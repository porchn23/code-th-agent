//! Workspace (พื้นที่ทำงาน) + git worktree — port จาก server.js
//!
//! - สมาชิกใช้ได้เฉพาะ workspace ของตัวเอง (หรือใต้โฟลเดอร์ส่วนตัว)
//! - admin เห็น/จัดการทั้งหมด
//! - สร้าง worktree แล้วลงทะเบียนเป็น workspace ให้อัตโนมัติ

use crate::error::{AppError, Result};
use crate::state::{Store, User, Workspace, WS_ROOT_ID};
use md5::{Digest, Md5};
use std::path::{Path, PathBuf};

/// id ของ workspace จาก path — ต้องตรงกับ JS (md5 ของ path ที่ resolve แล้ว, 8 ตัวแรก)
pub fn ws_id_of(dir: &Path) -> String {
    let resolved = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let mut hasher = Md5::new();
    hasher.update(resolved.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let hex = hex::encode(digest);
    format!("ws-{}", &hex[..8])
}

/// โฟลเดอร์รากของ workspace สมาชิก (URL-encoded ชื่อสมาชิก)
pub fn member_ws_root(base: &Path, user_name: &str) -> PathBuf {
    let encoded: String = user_name
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect();
    base.join(encoded)
}

/// หา workspace จาก id (ไม่รู้จัก → คืนหลัก)
pub fn find_ws<'a>(list: &'a [Workspace], id: &str) -> Option<&'a Workspace> {
    list.iter()
        .find(|w| w.id == id)
        .or_else(|| list.iter().find(|w| w.id == WS_ROOT_ID))
        .or_else(|| list.first())
}

pub fn workspace_by_id<'a>(list: &'a [Workspace], id: &str) -> Option<&'a Workspace> {
    list.iter().find(|w| w.id == id)
}

/// เข้าถึงได้ไหม (สมาชิกเห็นเฉพาะของตัวเอง, admin เห็นทั้งหมด)
pub fn can_access(ws: Option<&Workspace>, user: Option<&User>, auth_off: bool) -> bool {
    let Some(ws) = ws else { return false };
    if auth_off {
        return true;
    }
    let Some(user) = user else { return false };
    user.role == "admin"
        || ws.id == WS_ROOT_ID
        || ws.owner.is_none()
        || ws.owner.as_deref() == Some(user.name.as_str())
}

/// จัดการได้ไหม (เพิ่ม/ลบ workspace)
pub fn can_manage(ws: Option<&Workspace>, user: Option<&User>, auth_off: bool) -> bool {
    let Some(ws) = ws else { return false };
    if auth_off {
        return true;
    }
    let Some(user) = user else { return false };
    user.role == "admin" || ws.owner.as_deref() == Some(user.name.as_str())
}

/// โหลด registry (seed ครั้งแรก = โฟลเดอร์ตัวแอป)
pub fn load_workspaces(store: &Store) -> Vec<Workspace> {
    store.load_workspaces()
}

pub fn save_workspaces(store: &Store, list: &[Workspace]) -> Result<()> {
    store.save_workspaces(list)
}

/// เพิ่ม workspace (สูงสุด 20)
pub fn add_workspace(store: &Store, dir: &str, owner: Option<String>) -> Result<Workspace> {
    let path = PathBuf::from(dir);
    if !path.is_dir() {
        return Err(AppError::msg(format!("โฟลเดอร์ไม่มีอยู่: {dir}")));
    }
    let mut list = load_workspaces(store);
    if list.len() >= 20 {
        return Err(AppError::msg("ถึงลิมิต 20 workspace แล้ว"));
    }
    let id = ws_id_of(&path);
    if list.iter().any(|w| w.id == id) {
        return Err(AppError::msg("workspace นี้มีอยู่แล้ว"));
    }
    let ws = Workspace {
        id,
        name: path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| dir.to_string()),
        dir: path.to_string_lossy().to_string(),
        owner,
    };
    list.push(ws.clone());
    save_workspaces(store, &list)?;
    Ok(ws)
}

pub fn remove_workspace(store: &Store, id: &str) -> Result<()> {
    let mut list = load_workspaces(store);
    if id == WS_ROOT_ID {
        return Err(AppError::msg("ลบ workspace หลักไม่ได้"));
    }
    let before = list.len();
    list.retain(|w| w.id != id);
    if list.len() == before {
        return Err(AppError::msg("ไม่พบ workspace"));
    }
    save_workspaces(store, &list)
}

// ---------------------------------------------------------------------
// git worktree
// ---------------------------------------------------------------------
#[derive(Debug, Clone, serde::Serialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub head: String,
    pub branch: String,
    pub detached: bool,
}

fn find_git() -> Option<String> {
    for g in ["git", r"C:\Program Files\Git\cmd\git.exe"] {
        if which(g) {
            return Some(g.to_string());
        }
    }
    None
}

fn which(name: &str) -> bool {
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(';') {
            let cand = Path::new(dir).join(name);
            if cand.is_file() {
                return true;
            }
        }
    }
    false
}

fn run_git(args: &[&str], cwd: &Path) -> Result<(i32, String, String)> {
    let git = find_git().ok_or_else(|| AppError::msg("git is not available on this machine"))?;
    let out = std::process::Command::new(git)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| AppError::msg(e.to_string()))?;
    Ok((
        out.status.code().unwrap_or(1),
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    ))
}

/// รายการ worktree ของ repo — เทียบ listWorktrees ใน JS
pub fn list_worktrees(dir: &Path) -> Result<Vec<WorktreeInfo>> {
    let (code, out, err) = run_git(&["worktree", "list", "--porcelain"], dir)?;
    if code != 0 {
        if err.to_lowercase().contains("not a git repository") {
            return Err(AppError::msg(
                "โฟลเดอร์นี้ไม่ใช่ git repository — worktree ใช้ได้เฉพาะโปรเจกต์ที่เป็น git",
            ));
        }
        return Err(AppError::msg(
            err.trim().chars().take(300).collect::<String>(),
        ));
    }

    let mut list: Vec<WorktreeInfo> = Vec::new();
    let mut cur: Option<WorktreeInfo> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(c) = cur.take() {
                list.push(c);
            }
            cur = Some(WorktreeInfo {
                path: p.to_string(),
                head: String::new(),
                branch: String::new(),
                detached: false,
            });
        } else if let Some(c) = cur.as_mut() {
            if let Some(h) = line.strip_prefix("HEAD ") {
                c.head = h.to_string();
            } else if let Some(b) = line.strip_prefix("branch ") {
                c.branch = b.replace("refs/heads/", "");
            } else if line == "detached" {
                c.detached = true;
            }
        }
    }
    if let Some(c) = cur {
        list.push(c);
    }
    Ok(list)
}

/// สร้าง worktree ใหม่ในโฟลเดอร์ข้างโปรเจกต์
pub fn create_worktree(dir: &Path, target: &Path, branch: &str) -> Result<()> {
    let target_s = target.to_string_lossy().to_string();
    let (code, _out, err) = run_git(&["worktree", "add", "-b", branch, &target_s], dir)?;
    if code != 0 {
        return Err(AppError::msg(
            err.trim().chars().take(300).collect::<String>(),
        ));
    }
    Ok(())
}

/// ลบ worktree
pub fn remove_worktree(dir: &Path, target: &Path) -> Result<()> {
    let target_s = target.to_string_lossy().to_string();
    let (code, _out, err) = run_git(&["worktree", "remove", "--force", &target_s], dir)?;
    if code != 0 {
        return Err(AppError::msg(
            err.trim().chars().take(300).collect::<String>(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------
// ตัวสำรวจไฟล์ (tree / preview)
// ---------------------------------------------------------------------
const TREE_SKIP: &[&str] = &[
    "node_modules",
    ".git",
    "agent_checkpoints",
    ".agent_memory",
    "agent_users",
    "agent_workspaces",
];

/// รายการโฟลเดอร์ยอดชั้นเดียว (lazy-load)
pub fn list_dir(dir: &Path) -> Result<Vec<(String, bool, u64)>> {
    let mut out: Vec<(String, bool, u64)> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if TREE_SKIP.contains(&name.as_str()) {
            continue;
        }
        let md = entry.metadata().ok();
        let is_dir = md.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
        out.push((name, is_dir, size));
    }
    out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::make_user;

    #[test]
    fn ws_id_is_stable_and_prefixed() {
        let id = ws_id_of(Path::new("."));
        assert!(id.starts_with("ws-"));
        assert_eq!(id.len(), 11);
        assert_eq!(id, ws_id_of(Path::new(".")));
    }

    #[test]
    fn member_root_is_encoded() {
        let p = member_ws_root(Path::new("/base"), "a b");
        assert!(p.to_string_lossy().contains("a%20b"));
    }

    #[test]
    fn access_rules_follow_roles() {
        let ws = Workspace {
            id: "ws-x".into(),
            name: "x".into(),
            dir: "/x".into(),
            owner: Some("alice".into()),
        };
        let admin = make_user("admin", "p", "admin", "").unwrap();
        let alice = make_user("alice", "p", "member", "").unwrap();
        let bob = make_user("bob", "p", "member", "").unwrap();
        assert!(can_access(Some(&ws), Some(&admin), false));
        assert!(can_access(Some(&ws), Some(&alice), false));
        assert!(!can_access(Some(&ws), Some(&bob), false));
        assert!(can_access(Some(&ws), None, true));
    }
}
