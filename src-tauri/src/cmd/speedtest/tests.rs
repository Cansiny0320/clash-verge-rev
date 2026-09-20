use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

async fn read_headers(stream: &mut tokio::net::TcpStream) -> Result<String> {
    let mut data = Vec::new();
    while !data.ends_with(b"\r\n\r\n") {
        let byte = stream.read_u8().await?;
        data.push(byte);
        anyhow::ensure!(data.len() < 16384, "Oversized test request");
    }
    Ok(String::from_utf8(data)?)
}

// Serves entirely local payloads, including HTTP proxy CONNECT requests from Mihomo.
async fn server(
    status: &str,
    size: usize,
    content_type: &str,
) -> Result<(u16, Arc<AtomicUsize>, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n"
    );
    let task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let count = count.clone();
            let headers = headers.clone();
            tokio::spawn(async move {
                let result: Result<()> = async {
                    let request = read_headers(&mut stream).await?;
                    if request.starts_with("CONNECT ") {
                        stream.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await?;
                        read_headers(&mut stream).await?;
                    }
                    count.fetch_add(1, Ordering::SeqCst);
                    stream.write_all(headers.as_bytes()).await?;
                    let chunk = [42_u8; 16384];
                    let mut remaining = size;
                    while remaining > 0 {
                        let length = remaining.min(chunk.len());
                        stream.write_all(&chunk[..length]).await?;
                        remaining -= length;
                    }
                    Ok(())
                }
                .await;
                // The byte cap deliberately closes the stream early.
                let _ = result;
            });
        }
    });
    Ok((port, requests, task))
}

#[tokio::test]
async fn rejects_http_errors_html_and_empty_downloads() -> Result<()> {
    let client = reqwest::Client::builder().no_proxy().build()?;
    for (status, size, mime) in [
        ("429 Too Many Requests", 20, "application/octet-stream"),
        ("200 OK", 20, "text/html"),
        ("200 OK", 0, "application/octet-stream"),
    ] {
        let (port, _, task) = server(status, size, mime).await?;
        let result = measure(&client, format!("http://127.0.0.1:{port}/").parse()?, "test", |_| true).await;
        task.abort();
        assert!(result.is_err(), "Invalid response must not produce a speed");
    }
    Ok(())
}

#[tokio::test]
async fn stops_at_the_download_byte_limit() -> Result<()> {
    let (port, _, task) = server("200 OK", MAX_BYTES as usize + 1_000_000, "application/octet-stream").await?;
    let client = reqwest::Client::builder().no_proxy().build()?;
    let result = measure(&client, format!("http://127.0.0.1:{port}/").parse()?, "test", |_| true).await?;
    task.abort();
    assert_eq!(result.bytes, MAX_BYTES);
    assert!(
        result
            .bytes_per_second
            .is_some_and(|speed| speed.is_finite() && speed > 0.0)
    );
    Ok(())
}

#[tokio::test]
async fn stops_a_stalled_download_at_the_sample_deadline() -> Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await?;
        read_headers(&mut stream).await?;
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\npayload")
            .await?;
        std::future::pending::<()>().await;
        Ok::<_, anyhow::Error>(())
    });
    let client = reqwest::Client::builder().no_proxy().build()?;
    let start = Instant::now();
    let result = measure(&client, format!("http://127.0.0.1:{port}/").parse()?, "test", |_| true).await?;
    server.abort();
    assert_eq!(result.bytes, 7);
    assert!(start.elapsed() >= SAMPLE_TIME && start.elapsed() < SAMPLE_TIME + Duration::from_secs(2));
    Ok(())
}

#[tokio::test]
#[ignore = "Set VERGE_TEST_CORE to the bundled Mihomo executable; uses only local mock proxies"]
async fn real_core_keeps_same_named_provider_nodes_separate_and_cleans_up() -> Result<()> {
    let core = std::env::var("VERGE_TEST_CORE").context("VERGE_TEST_CORE must point to Mihomo")?;
    let (first, first_count, first_task) = server("200 OK", 1000, "application/octet-stream").await?;
    let (second, second_count, second_task) = server("200 OK", 2000, "application/octet-stream").await?;
    let root = std::env::temp_dir().join(format!("verge-speedtest-{}", nanoid::nanoid!()));
    std::fs::create_dir_all(&root)?;
    let mut session = Session {
        child: None,
        root: root.clone(),
        #[cfg(windows)]
        job: None,
    };
    let proxy_socket = TcpListener::bind("127.0.0.1:0")?;
    let api_socket = TcpListener::bind("127.0.0.1:0")?;
    let proxy_port = proxy_socket.local_addr()?.port();
    let api_port = api_socket.local_addr()?.port();
    let runtime = serde_yaml_ng::from_str(&format!(
        "proxy-providers:\n  first:\n    type: inline\n    payload: [{{name: same, type: http, server: 127.0.0.1, port: {first}}}]\n  second:\n    type: inline\n    payload: [{{name: same, type: http, server: 127.0.0.1, port: {second}}}]\n"
    ))?;
    let targets = ["first", "second"].map(|provider| Target {
        key: provider.into(),
        name: "same".into(),
        provider: Some(provider.into()),
    });
    let config = isolated_config(&runtime, &root, &root, &targets, (proxy_port, api_port), "local-test")?;
    let path = root.join("config.yaml");
    std::fs::write(&path, serde_yaml_ng::to_string(&config)?)?;
    let mut command = Command::new(core);
    command
        .arg("-d")
        .arg(&root)
        .arg("-f")
        .arg(path)
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
    session.child = Some(command.spawn()?);
    #[cfg(windows)]
    {
        session.job = Some(crate::core::manager::create_and_assign_sidecar_job(
            session.child.as_ref().unwrap().id(),
        )?);
    }
    let api = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1))
        .build()?;
    let base: reqwest::Url = format!("http://127.0.0.1:{api_port}/").parse()?;
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if api
                .get(base.clone())
                .bearer_auth("local-test")
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                break;
            }
            if let Some(status) = session.child.as_mut().unwrap().try_wait()? {
                bail!("Test core exited: {status}");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    let client = download_client(proxy_port)?;
    for (index, expected) in [1000, 2000, 1000].into_iter().enumerate() {
        select_proxy(&api, &base, "local-test", "GLOBAL", &selector(index % 2)).await?;
        let result = measure(&client, "http://download.test/payload".parse()?, "same", |_| true).await?;
        assert_eq!(
            result.bytes, expected,
            "Each measurement must use the selected provider, including after switching back"
        );
    }
    assert_eq!(first_count.load(Ordering::SeqCst), 2);
    assert_eq!(second_count.load(Ordering::SeqCst), 1);
    drop(session);
    assert!(!root.exists(), "Session must remove its isolated configuration");
    assert!(
        std::net::TcpStream::connect(("127.0.0.1", api_port)).is_err(),
        "Session must terminate the isolated core"
    );
    first_task.abort();
    second_task.abort();
    Ok(())
}
