//! security-guards.js → Rust
//!
//! 2 หน้าที่หลัก (ห้ามตก เพราะเป็นชั้นความปลอดภัย):
//!   1. SSRF guard — บล็อก private/reserved IP ทุก redirect + pin DNS ตอน connect
//!   2. Path guard  — path ห้ามหลุด root + ห้ามผ่าน symlink
//!
//! ข้อความ error ต้องตรงกับเวอร์ชัน JS ทุกตัวอักษร (test-security-guards.js เทียบ string)

use crate::error::GuardError;
use std::net::{IpAddr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use url::{Host, Url};

// ---------------------------------------------------------------------
// CIDR blocks — เหมือน net.BlockList ใน Node.js
// ---------------------------------------------------------------------
const BLOCKED_V4: &[&str] = &[
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
];

const BLOCKED_V6: &[&str] = &[
    "::/96",
    "::1/128",
    "::ffff:0:0/96",
    "64:ff9b::/96",
    "64:ff9b:1::/48",
    "100::/64",
    "2001::/23",
    "2001:db8::/32",
    "2002::/16",
    "fc00::/7",
    "fe80::/10",
    "ff00::/8",
];

/// โครงสร้าง CIDR แบบเบา — parse ครั้งเดียวต่อ call ไม่ได้โชค สร้างค่าคงที่แทน
struct Cidr {
    addr: IpAddr,
    prefix: u8,
}

impl Cidr {
    fn parse(s: &str) -> Option<Self> {
        let (base, prefix) = s.split_once('/')?;
        let addr: IpAddr = base.parse().ok()?;
        let prefix: u8 = prefix.parse().ok()?;
        Some(Cidr { addr, prefix })
    }

    fn contains(&self, ip: &IpAddr) -> bool {
        match (self.addr, ip) {
            (IpAddr::V4(b), IpAddr::V4(t)) => {
                let bm = u32::from(b);
                let tm = u32::from(*t);
                let mask = if self.prefix == 0 {
                    0u32
                } else {
                    u32::MAX << (32 - self.prefix)
                };
                (bm & mask) == (tm & mask)
            }
            (IpAddr::V6(b), IpAddr::V6(t)) => {
                let bm = u128::from(b);
                let tm = u128::from(*t);
                let mask = if self.prefix == 0 {
                    0u128
                } else {
                    u128::MAX << (128 - self.prefix)
                };
                (bm & mask) == (tm & mask)
            }
            // v4 ไม่เทียบกับ v6 block (และกลับกัน) — เหมือน Node.js ที่แยก family
            _ => false,
        }
    }
}

/// true = ปลอดภัย (public) · false = อยู่ในช่วง private/reserved
pub fn is_public_address(address: &IpAddr) -> bool {
    let blocked = match address {
        IpAddr::V4(_) => BLOCKED_V4,
        IpAddr::V6(_) => BLOCKED_V6,
    };
    !blocked
        .iter()
        .filter_map(|c| Cidr::parse(c))
        .any(|c| c.contains(address))
}

// ---------------------------------------------------------------------
// Path guard
// ---------------------------------------------------------------------

/// ทำ path ให้เป็น absolute + ตัด `.` / `..` ทิ้งแบบ lexical (ไม่แตะ filesystem)
/// — เทียบ path.resolve ของ Node.js
fn lexically_normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn normalize_absolute(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(p)
    };
    lexically_normalize(&abs)
}

/// เทียบ path แบบ case-insensitive บน Windows (Windows FS ไม่สนตัวพิมพ์)
fn component_eq(a: &Component<'_>, b: &Component<'_>) -> bool {
    let av = a.as_os_str().to_string_lossy();
    let bv = b.as_os_str().to_string_lossy();
    if cfg!(windows) {
        av.eq_ignore_ascii_case(&bv)
    } else {
        av == bv
    }
}

/// true = `p` อยู่ภายใน `root`
fn is_within(root: &Path, p: &Path) -> bool {
    let rc: Vec<Component<'_>> = root.components().collect();
    let pc: Vec<Component<'_>> = p.components().collect();
    if pc.len() < rc.len() {
        return false;
    }
    rc.iter().zip(pc.iter()).all(|(a, b)| component_eq(a, b))
}

/// รับ path ที่ `rel` (relative) แล้วคืน absolute path ที่ปลอดภัย
/// — เหมือน safePathInRoot ใน security-guards.js
pub fn safe_path_in_root(root: &Path, rel: &str) -> Result<PathBuf, GuardError> {
    let lexical_root = normalize_absolute(root);

    // resolve ตามแบบ Node: path.resolve(root, rel) — rel ที่เป็น absolute จะทับ root
    let abs = lexically_normalize(&lexical_root.join(rel));

    // เช็ค lexical ก่อน (กัน path หลุดด้วย ..)
    if !is_within(&lexical_root, &abs) {
        return Err(GuardError::PathEscape);
    }

    // ห้าม symlink ทุก segment ของ path
    if let Ok(rel_path) = abs.strip_prefix(&lexical_root) {
        let mut cursor = lexical_root.clone();
        for seg in rel_path.components() {
            cursor.push(seg.as_os_str());
            match std::fs::symlink_metadata(&cursor) {
                Ok(md) if md.file_type().is_symlink() => return Err(GuardError::SymlinkNotAllowed),
                Ok(_) => {}
                Err(_) => break, // ไม่มีไฟล์นี้จริง → หยุดเช็ค (เหมือน catch → break ของ JS)
            }
        }
    }

    // เทียบ realpath ของ root กับ realpath ของ path ที่มีอยู่จริง
    let real_root = std::fs::canonicalize(&lexical_root).map_err(|_| GuardError::PathEscape)?;
    let mut probe = abs.clone();
    while !probe.exists() {
        let parent = match probe.parent() {
            Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
            _ => return Err(GuardError::NoExistingParent),
        };
        if parent == probe {
            return Err(GuardError::NoExistingParent);
        }
        probe = parent;
    }
    let real_probe = std::fs::canonicalize(&probe).map_err(|_| GuardError::PathEscape)?;
    if !is_within(&real_root, &real_probe) {
        return Err(GuardError::PathEscape);
    }

    Ok(abs)
}

// ---------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------

fn host_of(url: &Url) -> String {
    match url.host() {
        Some(Host::Domain(d)) => d.to_lowercase(),
        Some(Host::Ipv4(ip)) => ip.to_string(),
        Some(Host::Ipv6(ip)) => ip.to_string(),
        None => String::new(),
    }
}

/// resolve URL → (url, ip) พร้อมตรวจว่าปลอดภัยไหม
/// — เทียบ resolvePublicHttpUrl ใน JS
pub async fn resolve_public_http_url(raw: &str) -> Result<(Url, IpAddr), GuardError> {
    let url = Url::parse(raw).map_err(|_| GuardError::InvalidUrl)?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(GuardError::SchemeNotAllowed);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(GuardError::CredentialsNotAllowed);
    }

    let host = match url.host() {
        Some(h) => h,
        None => return Err(GuardError::InvalidUrl),
    };

    let addr: IpAddr = match host {
        Host::Ipv4(ip) => IpAddr::V4(ip),
        Host::Ipv6(ip) => IpAddr::V6(ip),
        Host::Domain(d) => {
            let d = d.to_lowercase();
            if d.is_empty()
                || d == "localhost"
                || d.ends_with(".localhost")
                || d.ends_with(".local")
            {
                return Err(GuardError::PrivateDestination);
            }
            let addrs: Vec<IpAddr> = tokio::net::lookup_host((d.as_str(), 0u16))
                .await
                .map_err(|_| GuardError::ResolveFailed)?
                .map(|sa| sa.ip())
                .collect();
            if addrs.is_empty() {
                return Err(GuardError::ResolveFailed);
            }
            // ถ้ามีสัก IP ที่ไม่ public → ปฏิเสธทั้ง URL (เหมือน JS: some(!isPublic))
            if addrs.iter().any(|ip| !is_public_address(ip)) {
                return Err(GuardError::PrivateDestination);
            }
            addrs[0]
        }
    };

    if !is_public_address(&addr) {
        return Err(GuardError::PrivateDestination);
    }

    Ok((url, addr))
}

#[derive(Debug, Clone)]
pub struct PublicResponse {
    pub status: u16,
    pub body: String,
    pub final_url: String,
    pub content_type: String,
}

/// ดาวน์โหลดแบบตรวจทุก redirect + pin DNS (ไม่ให้โดน DNS rebinding)
/// — เทียบ fetchWithPublicRedirects ใน JS
pub async fn fetch_with_public_redirects(
    raw: &str,
    max_redirects: usize,
    timeout: Duration,
    user_agent: &str,
    max_bytes: usize,
) -> Result<PublicResponse, GuardError> {
    let mut current = raw.to_string();

    for _ in 0..=max_redirects {
        let (parsed, ip) = resolve_public_http_url(&current).await?;
        let host = host_of(&parsed);
        let port = parsed.port_or_known_default().unwrap_or(80);
        let sock = SocketAddr::new(ip, port);

        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .resolve(&host, sock)
            .timeout(timeout)
            .user_agent(user_agent)
            .build()
            .map_err(|_| GuardError::ResolveFailed)?;

        let resp = client
            .get(parsed.clone())
            .send()
            .await
            .map_err(|_| GuardError::ResolveFailed)?;

        let status = resp.status().as_u16();
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            if let Some(loc) = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
            {
                let next = parsed.join(loc).map_err(|_| GuardError::InvalidUrl)?;
                current = next.to_string();
                continue;
            }
        }

        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = resp.bytes().await.map_err(|_| GuardError::ResolveFailed)?;
        if bytes.len() > max_bytes {
            return Err(GuardError::BodyTooLarge);
        }
        return Ok(PublicResponse {
            status,
            body: String::from_utf8_lossy(&bytes).to_string(),
            final_url: current,
            content_type,
        });
    }

    Err(GuardError::TooManyRedirects)
}

// ---------------------------------------------------------------------
// tests — เทียบพฤติกรรมกับ test-security-guards.js
// ---------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_private_v4() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "192.168.1.1",
            "172.16.0.1",
            "169.254.1.1",
            "0.0.0.0",
            "100.64.0.1",
            "255.255.255.255",
        ] {
            assert!(
                !is_public_address(&ip.parse().unwrap()),
                "{ip} should be blocked"
            );
        }
    }

    #[test]
    fn allows_public_v4() {
        for ip in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1"] {
            assert!(
                is_public_address(&ip.parse().unwrap()),
                "{ip} should be allowed"
            );
        }
    }

    #[test]
    fn blocks_private_v6() {
        for ip in ["::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1"] {
            assert!(
                !is_public_address(&ip.parse().unwrap()),
                "{ip} should be blocked"
            );
        }
    }

    #[test]
    fn allows_public_v6() {
        assert!(is_public_address(&"2606:4700:4700::1111".parse().unwrap()));
    }

    #[tokio::test]
    async fn rejects_bad_scheme_and_creds() {
        assert_eq!(
            resolve_public_http_url("ftp://example.com")
                .await
                .unwrap_err(),
            GuardError::SchemeNotAllowed
        );
        assert_eq!(
            resolve_public_http_url("http://user:pw@example.com")
                .await
                .unwrap_err(),
            GuardError::CredentialsNotAllowed
        );
        assert_eq!(
            resolve_public_http_url("not a url").await.unwrap_err(),
            GuardError::InvalidUrl
        );
    }

    #[tokio::test]
    async fn rejects_localhost_and_private_ip() {
        assert_eq!(
            resolve_public_http_url("http://localhost/x")
                .await
                .unwrap_err(),
            GuardError::PrivateDestination
        );
        assert_eq!(
            resolve_public_http_url("http://127.0.0.1/x")
                .await
                .unwrap_err(),
            GuardError::PrivateDestination
        );
    }

    #[test]
    fn path_escape_is_blocked() {
        let root = std::env::temp_dir();
        let err = safe_path_in_root(&root, "../../etc/passwd").unwrap_err();
        assert_eq!(err, GuardError::PathEscape);
    }
}
