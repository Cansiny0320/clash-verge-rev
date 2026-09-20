mod config;
mod egress;

use anyhow::{Context as _, Result, bail};
use config::{Selections, Target, download_url, isolated_config, selector};
use parking_lot::Mutex;
use serde::Serialize;
use std::{
    net::TcpListener,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::LazyLock,
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

const MAX_BYTES: u64 = 50_000_000;
const SAMPLE_TIME: Duration = Duration::from_secs(5);
static ACTIVE: LazyLock<Mutex<Option<(String, CancellationToken)>>> = LazyLock::new(|| Mutex::new(None));

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedEvent {
    pub key: String,
    pub status: &'static str,
    pub bytes_per_second: Option<f64>,
    pub bytes: u64,
    pub error: Option<String>,
}

impl SpeedEvent {
    fn state(key: &str, status: &'static str) -> Self {
        Self {
            key: key.to_owned(),
            status,
            bytes_per_second: None,
            bytes: 0,
            error: None,
        }
    }
}

struct Session {
    child: Option<Child>,
    root: PathBuf,
    #[cfg(windows)]
    job: Option<std::os::windows::io::OwnedHandle>,
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct ActiveGuard(String);
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        let mut active = ACTIVE.lock();
        if active.as_ref().is_some_and(|(id, _)| *id == self.0) {
            *active = None;
        }
    }
}

#[tauri::command]
pub fn start_download_test(
    session_id: String,
    targets: Vec<Target>,
    selections: Selections,
    on_event: Channel<SpeedEvent>,
) -> Result<(), String> {
    if targets.is_empty() || targets.len() > 2000 {
        return Err("Invalid download test target count".into());
    }
    let cancel = CancellationToken::new();
    {
        let mut active = ACTIVE.lock();
        if active.is_some() {
            return Err("A download test is already running".into());
        }
        *active = Some((session_id.clone(), cancel.clone()));
    }
    let guard = ActiveGuard(session_id);
    tauri::async_runtime::spawn(async move {
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Ok(()),
            result = run_test(&targets, &selections, &on_event, &cancel) => result,
        };
        drop(guard);
        if let Err(error) = result {
            let mut event = SpeedEvent::state("", "error");
            event.error = Some(format!("{error:#}"));
            let _ = on_event.send(event);
        }
        let _ = on_event.send(SpeedEvent::state(
            "",
            if cancel.is_cancelled() { "cancelled" } else { "finished" },
        ));
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_download_test(session_id: String) {
    if let Some((id, cancel)) = ACTIVE.lock().as_ref()
        && *id == session_id
    {
        cancel.cancel();
    }
}

async fn select_proxy(
    client: &reqwest::Client,
    base: &reqwest::Url,
    secret: &str,
    group: &str,
    node: &str,
) -> Result<()> {
    let mut url = base.clone();
    url.path_segments_mut()
        .map_err(|()| anyhow::anyhow!("Invalid controller URL"))?
        .extend(["proxies", group]);
    client
        .put(url)
        .bearer_auth(secret)
        .json(&serde_json::json!({"name": node}))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

async fn run_test(
    targets: &[Target],
    selections: &Selections,
    channel: &Channel<SpeedEvent>,
    cancel: &CancellationToken,
) -> Result<()> {
    let settings = crate::config::Config::verge().await.latest_arc();
    let url = download_url(settings.download_test_url.as_deref().unwrap_or_default())?;
    let core = settings.get_valid_clash_core();
    let runtime = crate::config::Config::runtime()
        .await
        .latest_arc()
        .config
        .clone()
        .context("No active runtime configuration")?;
    let source_root = crate::utils::dirs::app_home_dir()?;
    let root = source_root.join("speedtests").join(nanoid::nanoid!());
    std::fs::create_dir_all(&root)?;
    let mut session = Session {
        child: None,
        root,
        #[cfg(windows)]
        job: None,
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&session.root, std::fs::Permissions::from_mode(0o700))?;
    }
    let proxy_socket = TcpListener::bind("127.0.0.1:0")?;
    let api_socket = TcpListener::bind("127.0.0.1:0")?;
    let proxy_port = proxy_socket.local_addr()?.port();
    let api_port = api_socket.local_addr()?.port();
    let secret = nanoid::nanoid!(40);
    let mut config = isolated_config(
        &runtime,
        &source_root,
        &session.root,
        targets,
        (proxy_port, api_port),
        &secret,
    )?;
    egress::bind_outbound(&runtime, &mut config)?;
    let config_path = session.root.join("config.yaml");
    std::fs::write(&config_path, serde_yaml_ng::to_string(&config)?)?;
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let core_path = std::env::current_exe()?.with_file_name(format!("{core}{extension}"));
    let mut command = Command::new(core_path);
    command
        .arg("-d")
        .arg(&session.root)
        .arg("-f")
        .arg(&config_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x0800_0000);
    }
    drop(proxy_socket);
    drop(api_socket);
    session.child = Some(
        command
            .spawn()
            .context("Unable to start the bundled Mihomo for download testing")?,
    );
    #[cfg(windows)]
    if let Some(child) = session.child.as_ref() {
        session.job = Some(crate::core::manager::create_and_assign_sidecar_job(child.id())?);
    }
    let api = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()?;
    let base = reqwest::Url::parse(&format!("http://127.0.0.1:{api_port}/"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(child) = session.child.as_mut()
            && let Some(status) = child.try_wait()?
        {
            bail!("Download test core exited ({status}); check provider and DNS configuration");
        }
        if api
            .get(base.clone())
            .bearer_auth(&secret)
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            break;
        }
        if Instant::now() >= deadline {
            bail!("Timed out starting the download test core");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // Restore only the isolated instance's dependency selectors from the active view.
    for (group, node) in selections {
        if group != "GLOBAL" {
            select_proxy(&api, &base, &secret, group, node)
                .await
                .context("Unable to reproduce the active proxy chain")?;
        }
    }
    let client = download_client(proxy_port)?;
    for (index, target) in targets.iter().enumerate() {
        if cancel.is_cancelled() {
            break;
        }
        channel.send(SpeedEvent::state(&target.key, "testing"))?;
        let result = async {
            let group = selector(index);
            let mut info_url = base.clone();
            info_url
                .path_segments_mut()
                .map_err(|()| anyhow::anyhow!("Invalid controller URL"))?
                .extend(["proxies", &group]);
            let info: serde_json::Value = api
                .get(info_url)
                .bearer_auth(&secret)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            if info.get("all") != Some(&serde_json::json!([&target.name])) {
                bail!("Node identity could not be resolved uniquely in its provider");
            }
            select_proxy(&api, &base, &secret, "GLOBAL", &group).await?;
            measure(&client, url.clone(), &target.key, |event| channel.send(event).is_ok()).await
        }
        .await;
        match result {
            Ok(event) => channel.send(event)?,
            Err(error) => {
                let mut event = SpeedEvent::state(&target.key, "error");
                event.error = Some(format!("{error:#}"));
                channel.send(event)?;
            }
        }
    }
    Ok(())
}

fn download_client(proxy_port: u16) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .no_proxy()
        .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{proxy_port}"))?)
        // An idle CONNECT tunnel would keep using the previous node after GLOBAL changes.
        .pool_max_idle_per_host(0)
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .build()?)
}

async fn measure(
    client: &reqwest::Client,
    url: reqwest::Url,
    key: &str,
    report: impl Fn(SpeedEvent) -> bool,
) -> Result<SpeedEvent> {
    let mut response = tokio::time::timeout(
        Duration::from_secs(10),
        client
            .get(url)
            .header("Cache-Control", "no-cache, no-store")
            .header("Accept-Encoding", "identity")
            .send(),
    )
    .await
    .context("Download connection timed out")??;
    if !response.status().is_success() {
        bail!("Download server returned HTTP {}", response.status());
    }
    if response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/html"))
    {
        bail!("Download server returned an HTML page instead of test data");
    }
    let start = Instant::now();
    let deadline = tokio::time::Instant::now() + SAMPLE_TIME;
    let mut bytes = 0_u64;
    let mut last_report = Instant::now();
    loop {
        match tokio::time::timeout_at(deadline, response.chunk()).await {
            Err(_) => break,
            Ok(Err(error)) => return Err(error).context("Download stream failed"),
            Ok(Ok(None)) => break,
            Ok(Ok(Some(chunk))) => {
                bytes += (chunk.len() as u64).min(MAX_BYTES - bytes);
            }
        }
        if bytes >= MAX_BYTES {
            break;
        }
        if last_report.elapsed() >= Duration::from_millis(250) {
            if !report(measurement(key, "testing", bytes, start.elapsed())) {
                bail!("Download test view disconnected");
            }
            last_report = Instant::now();
        }
    }
    if bytes == 0 {
        bail!("No download data received within the sample window");
    }
    Ok(measurement(key, "done", bytes, start.elapsed()))
}

fn measurement(key: &str, status: &'static str, bytes: u64, elapsed: Duration) -> SpeedEvent {
    SpeedEvent {
        key: key.to_owned(),
        status,
        bytes,
        bytes_per_second: Some(bytes as f64 / elapsed.as_secs_f64().max(0.001)),
        error: None,
    }
}

#[cfg(test)]
mod tests;
