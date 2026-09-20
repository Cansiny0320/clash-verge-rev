use anyhow::{Result, bail};
use serde_yaml_ng::{Mapping, Value};

// The production TUN auto-detect monitor belongs to that process. A second core
// without a TUN listener must bind explicitly or Windows routes it back into TUN.
pub fn bind_outbound(runtime: &Mapping, isolated: &mut Mapping) -> Result<()> {
    if runtime
        .get("tun")
        .and_then(|tun| tun.get("enable"))
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Ok(());
    }
    let tun_name = runtime
        .get("tun")
        .and_then(|tun| tun.get("device"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or("Meta");
    if let Some(name) = isolated
        .get("interface-name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
    {
        if name == tun_name {
            bail!("Download test outbound interface cannot be the active TUN interface");
        }
        return Ok(());
    }
    isolated.insert("interface-name".into(), default_outbound(tun_name)?.into());
    Ok(())
}

#[cfg(windows)]
fn default_outbound(tun_name: &str) -> Result<String> {
    use windows_sys::Win32::{
        NetworkManagement::{
            IpHelper::{
                FreeMibTable, GetIfEntry2, GetIpForwardTable2, GetIpInterfaceEntry, MIB_IF_ROW2, MIB_IPINTERFACE_ROW,
            },
            Ndis::IfOperStatusUp,
        },
        Networking::WinSock::AF_UNSPEC,
    };

    let mut table = std::ptr::null_mut();
    // SAFETY: Windows allocates this table and it remains valid until FreeMibTable.
    let error = unsafe { GetIpForwardTable2(AF_UNSPEC, &mut table) };
    if error != 0 {
        bail!(
            "Unable to read default outbound routes: {}",
            std::io::Error::from_raw_os_error(error as i32)
        );
    }
    let mut candidates = Vec::new();
    if !table.is_null() {
        // SAFETY: NumEntries describes the variable-length table returned by the API.
        let routes = unsafe { std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize) };
        for route in routes
            .iter()
            .filter(|route| route.DestinationPrefix.PrefixLength == 0 && !route.Loopback)
        {
            let mut interface = MIB_IF_ROW2 {
                InterfaceIndex: route.InterfaceIndex,
                ..Default::default()
            };
            let mut ip = MIB_IPINTERFACE_ROW {
                // SAFETY: all SOCKADDR_INET variants start with the address family.
                Family: unsafe { route.DestinationPrefix.Prefix.si_family },
                InterfaceIndex: route.InterfaceIndex,
                ..Default::default()
            };
            // SAFETY: both rows are initialized and writable for their entire struct size.
            if unsafe { GetIfEntry2(&mut interface) } != 0 || unsafe { GetIpInterfaceEntry(&mut ip) } != 0 {
                continue;
            }
            if interface.OperStatus != IfOperStatusUp || !ip.Connected {
                continue;
            }
            let length = interface
                .Alias
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(interface.Alias.len());
            let name = String::from_utf16_lossy(&interface.Alias[..length]);
            candidates.push((name, interface.Type, u64::from(route.Metric) + u64::from(ip.Metric)));
        }
        // SAFETY: table came from GetIpForwardTable2 and is no longer used.
        unsafe { FreeMibTable(table.cast()) };
    }
    choose_outbound(candidates, tun_name)
}

#[cfg(any(windows, test))]
fn choose_outbound(candidates: Vec<(String, u32, u64)>, tun_name: &str) -> Result<String> {
    candidates
        .into_iter()
        // Exclude loopback, proprietary virtual (Wintun), and tunnel interfaces.
        .filter(|(name, kind, _)| !name.is_empty() && name != tun_name && !matches!(kind, 24 | 53 | 131))
        .min_by_key(|(_, _, metric)| *metric)
        .map(|(name, _, _)| name)
        .ok_or_else(|| anyhow::anyhow!("No non-TUN default outbound interface is available for download testing"))
}

#[cfg(not(windows))]
fn default_outbound(_tun_name: &str) -> Result<String> {
    bail!("Download testing with TUN requires an explicit outbound interface-name on this platform")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    #[ignore = "Reads the host routing table; requires a connected non-TUN default interface"]
    fn native_route_lookup_excludes_tun() -> Result<()> {
        let name = default_outbound("Meta")?;
        assert!(!name.is_empty());
        assert_ne!(name, "Meta");
        println!("Download test outbound interface: {name}");
        Ok(())
    }

    #[test]
    fn ignores_tun_and_uses_combined_route_metric() -> Result<()> {
        let candidates = vec![
            ("custom-tun".into(), 6, 0),
            ("Meta".into(), 53, 0),
            ("loopback".into(), 24, 0),
            ("tunnel".into(), 131, 0),
            ("Ethernet".into(), 6, 25),
            ("Wi-Fi".into(), 71, 35),
        ];
        assert_eq!(choose_outbound(candidates, "custom-tun")?, "Ethernet");
        assert!(choose_outbound(vec![("Meta".into(), 53, 0)], "Meta").is_err());
        Ok(())
    }

    #[test]
    fn keeps_explicit_outbound_but_rejects_active_tun() -> Result<()> {
        let runtime: Mapping = serde_yaml_ng::from_str("tun: {enable: true, device: custom-tun}")?;
        let mut isolated: Mapping = serde_yaml_ng::from_str("interface-name: Ethernet")?;
        bind_outbound(&runtime, &mut isolated)?;
        assert_eq!(isolated["interface-name"].as_str(), Some("Ethernet"));
        isolated.insert("interface-name".into(), "custom-tun".into());
        assert!(bind_outbound(&runtime, &mut isolated).is_err());
        Ok(())
    }
}
