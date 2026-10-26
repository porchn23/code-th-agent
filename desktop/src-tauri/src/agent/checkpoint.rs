//! CHECKPOINTS — snapshot ก่อนแตะไฟล์ → ดู diff / ย้อนกลับได้
//! (เหมือน /rewind ของ Claude Code — port จาก research-agent.js)
//!
//! ไฟล์: `agent_checkpoints.json` = อาเรย์ของ record (format เดียวกับ JS)
//! ไฟล์สำรอง: `agent_checkpoints/<ckId>/f<N>.bak`

use crate::error::{AppError, Result};
use crate::state::Store;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const CKPT_CAP: usize = 30;
pub const MAX_FILE_BYTES: u64 = 300_000;
pub const MAX_PROJECT_FILES: usize = 120;
pub const DIFF_MAX_LINES: usize = 600;

/// โฟลเดอร์/ไฟล์ที่ข้าม (เหมือน CKPT_SKIP ใน JS)
const SKIP_DIRS: &[&str] = &["node_modules", ".git", "agent_checkpoints", "tools", "skills", "reports"];
const SKIP_FILES: &[&str] = &[
    ".agent_memory.json",
    ".openrouter_key",
    "agent-app.vbs",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CkptFile {
    pub rel: String,
    pub backup: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CkptRecord {
    pub id: String,
    pub ts: u64,
    #[serde(rename = "runId")]
    pub run_id: String,
    pub kind: String,
    pub files: Vec<CkptFile>,
    pub root: String,
}

/// บรรทัด diff (t = same | add | del | mod)
#[derive(Debug, Clone, Serialize)]
pub struct DiffLine {
    pub t: String,
    pub text: String,
}

// ---------------------------------------------------------------------
// ตัวช่วย path
// ---------------------------------------------------------------------
fn is_skipped(rel: &str) -> bool {
    let norm = rel.replace('\\', "/");
    let parts: Vec<&str> = norm.split('/').filter(|s| !s.is_empty()).collect();
    for p in &parts {
        if SKIP_DIRS.contains(p) {
            return true;
        }
        if SKIP_FILES.contains(p) {
            return true;
        }
        // agent_*.json / agent_*.jsonl ที่ระดับ root
        if parts.len() == 1 && p.starts_with("agent_") {
            if let Some(ext) = p.rsplit_once('.') {
                if ext.1 == "json" || ext.1 == "jsonl" {
                    return true;
                }
            }
        }
    }
    false
}

fn is_text_file(path: &Path) -> bool {
    let name = path.to_string_lossy().to_lowercase();
    [
        ".md", ".txt", ".json", ".csv", ".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx", ".py", ".sh",
        ".bat", ".ps1", ".yml", ".yaml", ".html", ".htm", ".css",
    ]
    .iter()
    .any(|e| name.ends_with(e))
}

// ---------------------------------------------------------------------
// บันทึก / โหลด record
// ---------------------------------------------------------------------
pub fn load_ckpts(store: &Store) -> Vec<CkptRecord> {
    store.load_ckpts()
}

pub fn save_ckpts(store: &Store, list: &[CkptRecord]) -> Result<()> {
    store.save_ckpts(list)
}

fn new_id() -> String {
    format!(
        "ck-{:x}{}",
        crate::agent::playbook::now_ms(),
        (crate::agent::playbook::now_ms() % 46_656)
    )
}

/// เก็บสำเนาไฟล์ 1 ไฟล์ — ต้องไม่ทำให้ run พัง
fn add_backup(store: &Store, abs: &Path, rec: &mut CkptRecord) {
    let Ok(buf) = std::fs::read(abs) else { return };
    if buf.len() as u64 > MAX_FILE_BYTES {
        return;
    }
    let dir = store.ckpt_dir().join(&rec.id);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let bk = dir.join(format!("f{}.bak", rec.files.len()));
    if std::fs::write(&bk, &buf).is_err() {
        return;
    }
    let rel = abs
        .strip_prefix(&rec.root)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/");
    rec.files.push(CkptFile {
        rel,
        backup: bk.to_string_lossy().to_string(),
    });
}

// ---------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------
/// snapshot ไฟล์เดียว (ก่อน file_edit / file_write)
pub fn snapshot_one(store: &Store, abs: &Path, kind: &str, run_id: &str, root: &Path) -> Option<CkptRecord> {
    let mut rec = CkptRecord {
        id: new_id(),
        ts: crate::agent::playbook::now_ms(),
        run_id: run_id.to_string(),
        kind: kind.to_string(),
        files: Vec::new(),
        root: root.to_string_lossy().to_string(),
    };
    add_backup(store, abs, &mut rec);
    if rec.files.is_empty() {
        None
    } else {
        Some(rec)
    }
}

/// snapshot ทั้งโปรเจกต์ (ก่อน run_command — ไม่รู้ล่วงหน้าคำสั่งจะแก้อะไร)
pub fn snapshot_project(store: &Store, run_id: &str, root: &Path) -> Option<CkptRecord> {
    let mut rec = CkptRecord {
        id: new_id(),
        ts: crate::agent::playbook::now_ms(),
        run_id: run_id.to_string(),
        kind: "run".to_string(),
        files: Vec::new(),
        root: root.to_string_lossy().to_string(),
    };

    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            !(e.file_type().is_dir() && SKIP_DIRS.contains(&name.as_str()))
        })
    {
        if rec.files.len() >= MAX_PROJECT_FILES {
            break;
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        if is_skipped(&rel) {
            continue;
        }
        let Ok(md) = entry.metadata() else { continue };
        if md.len() > MAX_FILE_BYTES {
            continue;
        }
        if !is_text_file(entry.path()) {
            continue;
        }
        add_backup(store, entry.path(), &mut rec);
    }

    if rec.files.is_empty() {
        None
    } else {
        Some(rec)
    }
}

/// hook ก่อนรัน tool ที่แก้ไฟล์ — error ต้องไม่ทำให้ run พัง
pub fn checkpoint_before(
    store: &Store,
    name: &str,
    args: &serde_json::Value,
    root: &Path,
    run_id: &str,
) -> Option<CkptRecord> {
    if crate::config::checkpoints_off() {
        return None;
    }
    let rec = if (name == "file_edit" || name == "file_write") && args.get("path").is_some() {
        let rel = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let abs = crate::agent::exec::safe_project_path(rel, root).ok()?;
        snapshot_one(store, &abs, "file", run_id, root)
    } else if name == "run_command" {
        snapshot_project(store, run_id, root)
    } else {
        None
    }?;

    let mut list = load_ckpts(store);
    list.insert(0, rec.clone());
    let dropped: Vec<CkptRecord> = if list.len() > CKPT_CAP {
        list.split_off(CKPT_CAP)
    } else {
        Vec::new()
    };
    let _ = save_ckpts(store, &list);
    for d in dropped {
        let _ = std::fs::remove_dir_all(store.ckpt_dir().join(&d.id));
    }
    Some(rec)
}

// ---------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------
/// diff แบบ LCS + ยุบบล็อก "same" ที่ยาวเกิน 6 บรรทัด
pub fn diff_text(a_text: &str, b_text: &str) -> Vec<DiffLine> {
    let a: Vec<&str> = a_text.split('\n').collect();
    let b: Vec<&str> = b_text.split('\n').collect();

    // ไฟล์ใหญ่เกิน → สรุปแบบ coarse (เหมือน JS)
    if a.len() > DIFF_MAX_LINES || b.len() > DIFF_MAX_LINES {
        let mut p = 0usize;
        while p < a.len() && p < b.len() && a[p] == b[p] {
            p += 1;
        }
        let mut s = 0usize;
        while s < a.len().min(b.len()) - p && a[a.len() - 1 - s] == b[b.len() - 1 - s] {
            s += 1;
        }
        return vec![
            DiffLine {
                t: "same".into(),
                text: format!("≈{p} บรรทัดต้นเหมือนกัน"),
            },
            DiffLine {
                t: "mod".into(),
                text: format!(
                    "เปลี่ยน ~{} → {} บรรทัด (ไฟล์ใหญ่เกิน diff แบบละเอียด)",
                    a.len() - p - s,
                    b.len() - p - s
                ),
            },
        ];
    }

    let m = a.len();
    let n = b.len();
    let mut dp = vec![vec![0u16; n + 1]; m + 1];
    for i in (0..m).rev() {
        for j in (0..n).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }

    let mut out: Vec<DiffLine> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < m && j < n {
        if a[i] == b[j] {
            out.push(DiffLine {
                t: "same".into(),
                text: a[i].to_string(),
            });
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            out.push(DiffLine {
                t: "del".into(),
                text: a[i].to_string(),
            });
            i += 1;
        } else {
            out.push(DiffLine {
                t: "add".into(),
                text: b[j].to_string(),
            });
            j += 1;
        }
    }
    while i < m {
        out.push(DiffLine {
            t: "del".into(),
            text: a[i].to_string(),
        });
        i += 1;
    }
    while j < n {
        out.push(DiffLine {
            t: "add".into(),
            text: b[j].to_string(),
        });
        j += 1;
    }

    // ยุบบล็อก same ที่ยาวเกิน 6 บรรทัด
    let mut c: Vec<DiffLine> = Vec::new();
    let mut k = 0usize;
    while k < out.len() {
        if out[k].t != "same" {
            c.push(out[k].clone());
            k += 1;
            continue;
        }
        let mut e = k;
        while e + 1 < out.len() && out[e + 1].t == "same" {
            e += 1;
        }
        if e - k + 1 > 6 {
            c.push(out[k].clone());
            c.push(out[k + 1].clone());
            c.push(DiffLine {
                t: "same".into(),
                text: format!("… (อีก {} บรรทัดเหมือนเดิม) …", e - k - 3),
            });
            c.push(out[e - 1].clone());
            c.push(out[e].clone());
        } else {
            for x in k..=e {
                c.push(out[x].clone());
            }
        }
        k = e + 1;
    }
    c.truncate(500);
    c
}

/// diff ของ checkpoint หนึ่งรายการ → รายไฟล์
pub fn diff_checkpoint(store: &Store, id: &str) -> Result<Vec<(String, Vec<DiffLine>)>> {
    let rec = load_ckpts(store)
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| AppError::msg(format!("checkpoint not found: {id}")))?;
    let root = PathBuf::from(&rec.root);

    let mut out = Vec::new();
    for f in &rec.files {
        let before = std::fs::read_to_string(&f.backup).unwrap_or_default();
        let abs = root.join(&f.rel);
        let after = std::fs::read_to_string(&abs).unwrap_or_default();
        out.push((f.rel.clone(), diff_text(&before, &after)));
    }
    Ok(out)
}

/// ย้อนกลับไฟล์ทั้งหมดของ checkpoint
pub fn restore_checkpoint(store: &Store, id: &str) -> Result<Vec<String>> {
    let rec = load_ckpts(store)
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| AppError::msg(format!("checkpoint not found: {id}")))?;
    let root = PathBuf::from(&rec.root);

    let mut restored = Vec::new();
    for f in &rec.files {
        if !Path::new(&f.backup).exists() {
            continue;
        }
        let abs = root.join(&f.rel);
        // กัน path escape
        if !abs.starts_with(&root) {
            continue;
        }
        if let Some(parent) = abs.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::copy(&f.backup, &abs).is_ok() {
            restored.push(f.rel.clone());
        }
    }
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_marks_added_and_removed() {
        let d = diff_text("a\nb\nc", "a\nX\nc");
        assert!(d.iter().any(|l| l.t == "del" && l.text == "b"));
        assert!(d.iter().any(|l| l.t == "add" && l.text == "X"));
        assert!(d.iter().any(|l| l.t == "same" && l.text == "a"));
    }

    #[test]
    fn diff_identical_is_all_same() {
        let d = diff_text("x\ny", "x\ny");
        assert!(d.iter().all(|l| l.t == "same"));
    }

    #[test]
    fn skip_rules_match_js() {
        assert!(is_skipped("node_modules/x.js"));
        assert!(is_skipped("agent_users.json"));
        assert!(is_skipped(".openrouter_key"));
        assert!(is_skipped("reports/out.md"));
        assert!(!is_skipped("src/main.rs"));
    }
}
