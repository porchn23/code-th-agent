//! ระบบสมาชิก + session — port จาก server.js (auth part)
//!
//! ⚠️ hash ต้องเข้าคอมแพติเบิลกับ Node.js: scrypt(N=16384, r=8, p=1, keylen=64)
//!    salt = ตัวอักษร hex 16 ตัว (Node ใช้ utf8 bytes ของ string เป็น salt)

use crate::error::{AppError, Result};
use crate::state::{Session, SessionUser, Store, User};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;

pub const SESSION_TTL_MS: u64 = 7 * 24 * 3600 * 1000;
pub const LOGIN_MAX_FAILS: u32 = 5;
pub const LOGIN_LOCK_MS: u64 = 30_000;

static EMAIL_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").expect("email regex"));

/// hash รหัสผ่าน (hex) — เหมือน crypto.scryptSync(pw, salt, 64).toString("hex")
pub fn hash_password(password: &str, salt: &str) -> Result<String> {
    let params = scrypt::Params::new(14, 8, 1, 64)
        .map_err(|e| AppError::msg(format!("scrypt params: {e}")))?;
    let mut out = [0u8; 64];
    scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut out)
        .map_err(|e| AppError::msg(format!("scrypt: {e}")))?;
    Ok(hex::encode(out))
}

pub fn verify_password(password: &str, salt: &str, expected_hex: &str) -> bool {
    match hash_password(password, salt) {
        Ok(h) => constant_time_eq(h.as_bytes(), expected_hex.as_bytes()),
        Err(_) => false,
    }
}

/// เทียบแบบ constant-time (กัน timing attack)
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom(&mut buf);
    hex::encode(buf)
}

fn getrandom(buf: &mut [u8]) {
    use rand::RngCore;
    rand::thread_rng().fill_bytes(buf);
}

/// สร้างผู้ใช้ใหม่
pub fn make_user(name: &str, password: &str, role: &str, email: &str) -> Result<User> {
    let name = name.trim().chars().take(30).collect::<String>();
    if name.is_empty() {
        return Err(AppError::msg("name is required"));
    }
    let salt = random_hex(16);
    let hash = hash_password(password, &salt)?;
    Ok(User {
        id: format!("u-{}", random_hex(4)),
        name,
        email: email.trim().to_lowercase(),
        role: if role == "admin" { "admin" } else { "member" }.to_string(),
        salt,
        hash,
        or_key: String::new(),
        created: crate::agent::playbook::now_ms(),
    })
}

/// หาผู้ใช้จากชื่อ หรือ อีเมล
pub fn find_user(users: &[User], ident: &str) -> Option<User> {
    let needle = ident.trim().to_lowercase();
    if needle.is_empty() {
        return None;
    }
    users
        .iter()
        .find(|u| u.name.to_lowercase() == needle)
        .or_else(|| {
            users
                .iter()
                .find(|u| !u.email.is_empty() && u.email.to_lowercase() == needle)
        })
        .cloned()
}

/// ตัวนับ login fail (กันเดารหัส: 5 ครั้ง → ล็อก 30 วิ)
#[derive(Default)]
pub struct LoginGuard {
    fails: Mutex<HashMap<String, (u32, u64)>>,
}

impl LoginGuard {
    /// คืน Ok(()) ถ้ายังไม่ถูกล็อก
    pub fn check(&self, ident: &str) -> Result<()> {
        let now = crate::agent::playbook::now_ms();
        let map = self.fails.lock();
        if let Some((count, until)) = map.get(ident) {
            if *count >= LOGIN_MAX_FAILS && now < *until {
                let wait = ((*until - now) / 1000) + 1;
                return Err(AppError::RateLimited(wait));
            }
        }
        Ok(())
    }

    pub fn fail(&self, ident: &str) {
        let now = crate::agent::playbook::now_ms();
        let mut map = self.fails.lock();
        let entry = map.entry(ident.to_string()).or_insert((0, 0));
        entry.0 += 1;
        if entry.0 >= LOGIN_MAX_FAILS {
            entry.1 = now + LOGIN_LOCK_MS;
        }
    }

    pub fn reset(&self, ident: &str) {
        self.fails.lock().remove(ident);
    }
}

// ---------------------------------------------------------------------
// session
// ---------------------------------------------------------------------
pub struct Sessions {
    map: Mutex<HashMap<String, Session>>,
}

impl Default for Sessions {
    fn default() -> Self {
        let mut map = HashMap::new();
        if let Ok(raw) = std::fs::read_to_string("agent_sessions.json") {
            if let Ok(saved) = serde_json::from_str::<HashMap<String, Session>>(&raw) {
                let now = crate::agent::playbook::now_ms();
                for (sid, s) in saved {
                    if s.exp > now {
                        map.insert(sid, s);
                    }
                }
            }
        }
        Sessions {
            map: Mutex::new(map),
        }
    }
}

impl Sessions {
    pub fn create(&self, user: &User) -> String {
        let sid = random_hex(20);
        let session = Session {
            user: SessionUser {
                name: user.name.clone(),
                email: user.email.clone(),
                role: user.role.clone(),
            },
            exp: crate::agent::playbook::now_ms() + SESSION_TTL_MS,
        };
        self.map.lock().insert(sid.clone(), session);
        sid
    }

    pub fn get(&self, sid: &str) -> Option<SessionUser> {
        let now = crate::agent::playbook::now_ms();
        let mut map = self.map.lock();
        match map.get(sid) {
            Some(s) if s.exp > now => Some(s.user.clone()),
            Some(_) => {
                map.remove(sid);
                None
            }
            None => None,
        }
    }

    pub fn destroy(&self, sid: &str) {
        self.map.lock().remove(sid);
    }

    /// ตัด session ที่หมดอายุ + บันทึกลงไฟล์ (ให้รอด restart)
    pub fn persist(&self, store: &Store) {
        let now = crate::agent::playbook::now_ms();
        let mut map = self.map.lock();
        map.retain(|_, s| s.exp > now);
        let _ = store.save_sessions(&map);
    }
}

/// ตรวจอีเมล
pub fn valid_email(email: &str) -> bool {
    EMAIL_RE.is_match(email.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_matches_node_scrypt() {
        // เทียบกับ Node 24: crypto.scryptSync('testpass','abc123',64).toString('hex')
        // (ถ้าค่านี้ไม่ตรง = รหัสผ่านที่บันทึกไว้จะอ่านไม่ได้ → ต้องแก้ params)
        const NODE_REF: &str = "5cbebff3a299f14e058b88b6db9805ca40def8210ff8c971fbdffdda3f2b76755483b7789f2b763cacc2caca0399a206db46d210d09c049b5d60b15128bf8e93";
        let h = hash_password("testpass", "abc123").unwrap();
        assert_eq!(h, NODE_REF);
    }

    #[test]
    fn verify_roundtrip() {
        let h = hash_password("s3cret", "deadbeef").unwrap();
        assert!(verify_password("s3cret", "deadbeef", &h));
        assert!(!verify_password("wrong", "deadbeef", &h));
    }

    #[test]
    fn find_user_by_name_or_email() {
        let users = vec![make_user("admin", "pw", "admin", "A@Example.com").unwrap()];
        assert!(find_user(&users, "admin").is_some());
        assert!(find_user(&users, "a@example.com").is_some());
        assert!(find_user(&users, "nobody").is_none());
    }

    #[test]
    fn login_guard_locks_after_five_failures() {
        let g = LoginGuard::default();
        for _ in 0..5 {
            g.fail("admin");
        }
        assert!(g.check("admin").is_err());
    }
}
