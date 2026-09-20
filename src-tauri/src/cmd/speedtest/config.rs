use anyhow::{Context as _, Result, bail};
use serde::Deserialize;
use serde_yaml_ng::{Mapping, Value};
use std::{collections::HashMap, path::Path};

pub const DEFAULT_URL: &str = "https://speed.cloudflare.com/__down?bytes=50000000";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub key: String,
    pub name: String,
    pub provider: Option<String>,
}

pub fn download_url(value: &str) -> Result<reqwest::Url> {
    let value = if value.trim().is_empty() {
        DEFAULT_URL
    } else {
        value.trim()
    };
    let url = reqwest::Url::parse(value).context("Invalid download test URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("Download test URL must use HTTP(S), without embedded credentials");
    }
    Ok(url)
}

pub fn selector(index: usize) -> String {
    format!("__verge_speedtest_{index}")
}

pub fn isolated_config(
    runtime: &Mapping,
    source_root: &Path,
    session_root: &Path,
    targets: &[Target],
    ports: (u16, u16),
    secret: &str,
) -> Result<Mapping> {
    // Whitelist outbound configuration; never inherit production inbounds or routing.
    let mut config = Mapping::new();
    for key in [
        "proxies",
        "proxy-groups",
        "proxy-providers",
        "dns",
        "hosts",
        "ipv6",
        "interface-name",
        "routing-mark",
        "global-client-fingerprint",
        "global-ua",
        "geodata-mode",
        "geodata-loader",
        "geox-url",
    ] {
        if let Some(value) = runtime.get(key) {
            config.insert(key.into(), value.clone());
        }
    }
    for filename in crate::core::GEO_ASSETS {
        let source = source_root.join(filename);
        if source.is_file() {
            std::fs::copy(&source, session_root.join(filename)).context("Unable to copy GeoData for isolated DNS")?;
        }
    }
    if let Some(dns) = config.get_mut("dns").and_then(Value::as_mapping_mut) {
        dns.remove("listen");
        dns.insert("enhanced-mode".into(), "redir-host".into());
        dns.insert("respect-rules".into(), false.into());
        // Rule-set DNS policies require unrelated rule providers; fail explicitly rather than reroute.
        if dns
            .get("nameserver-policy")
            .and_then(Value::as_mapping)
            .is_some_and(|policies| {
                policies
                    .keys()
                    .any(|key| key.as_str().is_some_and(|key| key.starts_with("rule-set:")))
            })
        {
            bail!("Download test does not support rule-set DNS policies yet");
        }
    }

    if let Some(providers) = config.get_mut("proxy-providers").and_then(Value::as_mapping_mut) {
        for (index, (_, provider)) in providers.iter_mut().enumerate() {
            let provider = provider.as_mapping_mut().context("Invalid proxy provider")?;
            provider.insert(
                "health-check".into(),
                serde_yaml_ng::to_value(serde_json::json!({"enable": false}))?,
            );
            if provider.get("type").and_then(Value::as_str) == Some("inline") {
                continue;
            }
            let destination = session_root.join(format!("provider-{index}.yaml"));
            let mut copied = false;
            if let Some(path) = provider.get("path").and_then(Value::as_str) {
                let source = source_root.join(path);
                if source.is_file() {
                    std::fs::copy(&source, &destination).context("Unable to copy provider cache")?;
                    copied = true;
                }
            }
            if copied {
                provider.insert("type".into(), "file".into());
                provider.remove("url");
            } else if provider.get("type").and_then(Value::as_str) != Some("http") {
                bail!("Proxy provider cache is unavailable; cannot identify the tested nodes");
            }
            provider.insert("path".into(), destination.to_string_lossy().to_string().into());
        }
    }

    let mut groups = Vec::new();
    if let Some(existing) = config.get("proxy-groups").and_then(Value::as_sequence) {
        for group in existing {
            let mut mapped = Mapping::new();
            for key in [
                "name",
                "proxies",
                "use",
                "filter",
                "exclude-filter",
                "exclude-type",
                "include-all",
                "include-all-proxies",
                "include-all-providers",
            ] {
                if let Some(value) = group.get(key) {
                    mapped.insert(key.into(), value.clone());
                }
            }
            mapped.insert("type".into(), "select".into());
            groups.push(Value::Mapping(mapped));
        }
    }
    for (index, target) in targets.iter().enumerate() {
        let name = selector(index);
        if groups
            .iter()
            .any(|group| group.get("name").and_then(Value::as_str) == Some(name.as_str()))
            || runtime
                .get("proxies")
                .and_then(Value::as_sequence)
                .is_some_and(|nodes| {
                    nodes
                        .iter()
                        .any(|node| node.get("name").and_then(Value::as_str) == Some(name.as_str()))
                })
        {
            bail!("Reserved speed test selector name already exists");
        }
        let group = if let Some(provider) = &target.provider {
            if !config
                .get("proxy-providers")
                .and_then(Value::as_mapping)
                .is_some_and(|providers| providers.contains_key(Value::String(provider.clone())))
            {
                bail!("Requested provider is not in the runtime configuration");
            }
            serde_json::json!({"name": name, "type": "select", "use": [provider], "filter": format!("^{}$", regex::escape(&target.name))})
        } else {
            if !config.get("proxies").and_then(Value::as_sequence).is_some_and(|nodes| {
                nodes
                    .iter()
                    .any(|node| node.get("name").and_then(Value::as_str) == Some(target.name.as_str()))
            }) {
                bail!("Requested node is not in the runtime configuration");
            }
            serde_json::json!({"name": name, "type": "select", "proxies": [&target.name]})
        };
        groups.push(serde_yaml_ng::to_value(group)?);
    }
    config.insert("proxy-groups".into(), groups.into());
    for (key, value) in serde_yaml_ng::from_str::<Mapping>(&format!(
        "mixed-port: {}\nallow-lan: false\nbind-address: 127.0.0.1\nmode: global\nlog-level: silent\nexternal-controller: 127.0.0.1:{}\nsecret: {secret}\nprofile:\n  store-selected: false\n  store-fake-ip: false\nrules: []\n",
        ports.0, ports.1
    ))? {
        config.insert(key, value);
    }
    Ok(config)
}

pub type Selections = HashMap<String, String>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excludes_production_inbounds_and_preserves_protocol_fields() -> Result<()> {
        let runtime: Mapping = serde_yaml_ng::from_str(
            "tun: {enable: true}\nlisteners: [{port: 8888}]\nport: 7890\nexternal-controller-pipe: secret-pipe\ndns: {listen: '0.0.0.0:53', enhanced-mode: fake-ip}\nproxies: [{name: node, type: vless, uuid: test, dialer-proxy: relay, reality-opts: {public-key: abc}}]\nproxy-groups: [{name: relay, type: url-test, proxies: [DIRECT], interval: 30}]\n",
        )?;
        let target = Target {
            key: "node".into(),
            name: "node".into(),
            provider: None,
        };
        let config = isolated_config(
            &runtime,
            Path::new("."),
            Path::new("."),
            &[target],
            (1234, 1235),
            "test",
        )?;
        for key in ["tun", "listeners", "port", "external-controller-pipe"] {
            assert!(!config.contains_key(key));
        }
        assert!(config["dns"].get("listen").is_none());
        assert_eq!(config["proxies"], runtime["proxies"]);
        assert_eq!(config["proxy-groups"][0]["type"].as_str(), Some("select"));
        assert_eq!(config["bind-address"].as_str(), Some("127.0.0.1"));
        Ok(())
    }

    #[test]
    fn provider_identity_is_explicit_and_regex_is_literal() -> Result<()> {
        let runtime: Mapping =
            serde_yaml_ng::from_str("proxy-providers: {p: {type: inline, payload: [{name: 'a+b', type: direct}]}}")?;
        let target = Target {
            key: "p:a+b".into(),
            name: "a+b".into(),
            provider: Some("p".into()),
        };
        let config = isolated_config(&runtime, Path::new("."), Path::new("."), &[target], (1, 2), "test")?;
        assert_eq!(config["proxy-groups"][0]["filter"].as_str(), Some("^a\\+b$"));
        assert_eq!(config["proxy-groups"][0]["use"][0].as_str(), Some("p"));
        assert_eq!(
            config["proxy-providers"]["p"]["health-check"]["enable"].as_bool(),
            Some(false)
        );
        Ok(())
    }

    #[test]
    fn validates_download_urls() {
        assert!(download_url("").is_ok());
        assert!(download_url("https://example.com/file").is_ok());
        assert!(download_url("file:///secret").is_err());
        assert!(download_url("https://user:pass@example.com/file").is_err());
    }
}
