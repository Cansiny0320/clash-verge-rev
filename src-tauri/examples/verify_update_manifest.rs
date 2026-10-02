use std::{env, fs};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = fs::read_to_string(env::args().nth(1).ok_or("expected manifest path")?)?;
    let release: tauri_plugin_updater::RemoteRelease = serde_json::from_str(&manifest)?;
    let url = release.download_url("windows-x86_64")?;
    if !url
        .as_str()
        .starts_with("https://github.com/Cansiny0320/clash-verge-rev/releases/download/")
    {
        return Err("release URL is outside the fork".into());
    }
    println!("Tauri parsed version {} for Windows", release.version);
    Ok(())
}
