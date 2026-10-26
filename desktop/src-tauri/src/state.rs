//! ไฟล์ state ทั้งหมด — อ่าน/เขียน JSON แบบเดียวกับเวอร์ชัน Node.js
//!
//! ⚠️ สำคัญ: format ของไฟล์เหล่านี้ "แชร์กันได้" ระหว่างเวอร์ชัน JS กับ Rust
//!    (สลับกลับไปใช้ตัวเดิมได้โดยไม่เสีย state) — เลยห้ามเปลี่ยนชื่อ field
//!
//!    agent_users.json      [{id,name,email,role,salt,hash,orKey,created}]
//!    agent_sessions.json   {sid: {user:{name,email,role}, exp}}
//!    agent_workspaces.json [{id,name,dir,owner?}]
//!    agent_playbook.json   {rules:[{id,tag,rule,usageCount,lastSeen,created}], _cap}
//!    agent_evals.json      [{id,keywords[],check[],usageCount,lastSeen}]
//!    skills/index.json     [{name,description,params,createdAt,lastUsed,calls}]
//!    agent_plan.json       {id,ts,title,steps:[{text,done}]}
//!    .agent_memory.json    [{key,note}]
//!    agent-events.jsonl    append-only, 1 event ต่อบรรทัด

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------
// ผู้ใช้ + session
// ---------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub email: String,
    pub role: String,
    pub salt: String,
    pub hash: String,
    #[serde(default, rename = "orKey")]
    pub or_key: String,
    pub created: u64,
}

impl User {
    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionUser {
    pub name: String,
    #[serde(default)]
    pub email: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub user: SessionUser,
    pub exp: u64,
}

// ---------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

pub const WS_ROOT_ID: &str = "ws-root";

// ---------------------------------------------------------------------
// circuit 1 — playbook
// ---------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Rule {
    pub id: String,
    #[serde(default)]
    pub tag: String,
    pub rule: String,
    #[serde(default = "one")]
    pub usage_count: u32,
    pub last_seen: u64,
    #[serde(default)]
    pub created: u64,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybookFile {
    #[serde(default)]
    pub rules: Vec<Rule>,
    #[serde(default, rename = "_cap")]
    pub cap: Option<usize>,
}

// ---------------------------------------------------------------------
// circuit 3 — evals
// ---------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalEntry {
    pub id: String,
    pub keywords: Vec<String>,
    pub check: Vec<String>,
    #[serde(default = "one")]
    pub usage_count: u32,
    #[serde(default)]
    pub last_seen: u64,
}

// ---------------------------------------------------------------------
// circuit 2 — skill library
// ---------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillEntry {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub last_used: u64,
    #[serde(default)]
    pub calls: u32,
}

// ---------------------------------------------------------------------
// plan mode
// ---------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanStep {
    pub text: String,
    #[serde(default)]
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanFile {
    pub id: String,
    pub ts: u64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub steps: Vec<PlanStep>,
}

// ---------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub key: String,
    pub note: String,
}

// ---------------------------------------------------------------------
// event log (jsonl)
// ---------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunEvent {
    pub run_id: String,
    pub ts: u64,
    pub task: String,
    pub steps: u32,
    pub tools: serde_json::Value,
    pub outcome: String,
    #[serde(default)]
    pub errors: Vec<String>,
    #[serde(default)]
    pub tok: u64,
    pub model: String,
}

// ---------------------------------------------------------------------
// ตัวจัดการไฟล์ state — ทุก path ผูกกับ data dir เดียว
// ---------------------------------------------------------------------
#[derive(Debug, Clone)]
pub struct Store {
    pub dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Store { dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    fn read_json<T: for<'de> Deserialize<'de>>(&self, name: &str) -> Option<T> {
        let raw = std::fs::read_to_string(self.path(name)).ok()?;
        serde_json::from_str(&raw).ok()
    }

    fn write_json<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        if let Some(parent) = self.path(name).parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let body = serde_json::to_string_pretty(value)?;
        std::fs::write(self.path(name), body)?;
        Ok(())
    }

    // ---- users ----
    pub fn load_users(&self) -> Vec<User> {
        self.read_json::<Vec<User>>("agent_users.json")
            .unwrap_or_default()
    }

    pub fn save_users(&self, users: &[User]) -> Result<()> {
        self.write_json("agent_users.json", &users)
    }

    // ---- sessions ----
    pub fn load_sessions(&self) -> HashMap<String, Session> {
        self.read_json::<HashMap<String, Session>>("agent_sessions.json")
            .unwrap_or_default()
    }

    pub fn save_sessions(&self, sessions: &HashMap<String, Session>) -> Result<()> {
        self.write_json("agent_sessions.json", sessions)
    }

    // ---- workspaces ----
    pub fn load_workspaces(&self) -> Vec<Workspace> {
        let list = self
            .read_json::<Vec<Workspace>>("agent_workspaces.json")
            .unwrap_or_default();
        if !list.is_empty() {
            return list;
        }
        // seed ครั้งแรก = โฟลเดอร์ตัวแอปเอง
        let seed = vec![Workspace {
            id: WS_ROOT_ID.to_string(),
            name: data_dir_name(),
            dir: self.dir.to_string_lossy().to_string(),
            owner: None,
        }];
        let _ = self.save_workspaces(&seed);
        seed
    }

    pub fn save_workspaces(&self, list: &[Workspace]) -> Result<()> {
        self.write_json("agent_workspaces.json", &list)
    }

    // ---- playbook ----
    pub fn load_playbook(&self) -> PlaybookFile {
        self.read_json::<PlaybookFile>("agent_playbook.json")
            .unwrap_or(PlaybookFile {
                rules: Vec::new(),
                cap: Some(50),
            })
    }

    pub fn save_playbook(&self, file: &PlaybookFile) -> Result<()> {
        self.write_json("agent_playbook.json", file)
    }

    // ---- evals ----
    pub fn load_evals(&self) -> Vec<EvalEntry> {
        self.read_json::<Vec<EvalEntry>>("agent_evals.json")
            .unwrap_or_default()
    }

    pub fn save_evals(&self, list: &[EvalEntry]) -> Result<()> {
        self.write_json("agent_evals.json", &list)
    }

    // ---- skills ----
    pub fn load_skills(&self) -> Vec<SkillEntry> {
        self.read_json::<Vec<SkillEntry>>("skills/index.json")
            .unwrap_or_default()
    }

    pub fn save_skills(&self, list: &[SkillEntry]) -> Result<()> {
        self.write_json("skills/index.json", &list)
    }

    // ---- plan ----
    pub fn load_plan(&self) -> Option<PlanFile> {
        self.read_json::<PlanFile>("agent_plan.json")
    }

    pub fn save_plan(&self, plan: &PlanFile) -> Result<()> {
        self.write_json("agent_plan.json", plan)
    }

    // ---- memory ----
    pub fn load_memory(&self) -> Vec<MemoryEntry> {
        self.read_json::<Vec<MemoryEntry>>(".agent_memory.json")
            .unwrap_or_default()
    }

    pub fn save_memory(&self, list: &[MemoryEntry]) -> Result<()> {
        self.write_json(".agent_memory.json", &list)
    }

    // ---- event log (append-only) ----
    pub fn append_event(&self, ev: &RunEvent) -> Result<()> {
        let line = serde_json::to_string(ev)?;
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.path("agent-events.jsonl"))?;
        writeln!(f, "{line}")?;
        Ok(())
    }

    /// อ่าน event log ทั้งหมด (ใช้ทำ summary) — ไม่โหลดเข้า LLM context
    pub fn load_events(&self) -> Vec<RunEvent> {
        let raw = match std::fs::read_to_string(self.path("agent-events.jsonl")) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        raw.lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str::<RunEvent>(l).ok())
            .collect()
    }

    /// ตัด event log ที่เกิน cap (keep ล่าสุด) — เหมือน JS
    pub fn trim_events(&self, cap: usize) {
        let events = self.load_events();
        if events.len() <= cap {
            return;
        }
        let keep = &events[events.len() - cap..];
        let body: String = keep
            .iter()
            .filter_map(|e| serde_json::to_string(e).ok())
            .map(|l| format!("{l}\n"))
            .collect();
        let _ = std::fs::write(self.path("agent-events.jsonl"), body);
    }

    /// path ของไฟล์ custom tool
    pub fn tools_dir(&self) -> PathBuf {
        self.dir.join("tools")
    }

    /// path ของโฟลเดอร์ reports (file_write เขียนได้ที่นี่เท่านั้น)
    pub fn reports_dir(&self) -> PathBuf {
        self.dir.join("reports")
    }

    /// โฟลเดอร์เก็บไฟล์สำรองของ checkpoint
    pub fn ckpt_dir(&self) -> PathBuf {
        self.dir.join("agent_checkpoints")
    }

    /// โหลดรายการ checkpoint (อาเรย์ — format เดียวกับ JS)
    pub fn load_ckpts(&self) -> Vec<crate::agent::checkpoint::CkptRecord> {
        self.read_json::<Vec<crate::agent::checkpoint::CkptRecord>>("agent_checkpoints.json")
            .unwrap_or_default()
    }

    pub fn save_ckpts(&self, list: &[crate::agent::checkpoint::CkptRecord]) -> Result<()> {
        self.write_json("agent_checkpoints.json", &list)
    }

    /// ไฟล์ AGENTS.md (กฎของผู้ใช้)
    pub fn agents_file(&self) -> PathBuf {
        self.dir.join("AGENTS.md")
    }

    pub fn read_agents_rules(&self) -> Option<String> {
        let raw = std::fs::read_to_string(self.agents_file()).ok()?;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.chars().take(30_000).collect())
        }
    }

    pub fn write_agents_rules(&self, content: &str) -> Result<()> {
        let trimmed: String = content.chars().take(30_000).collect();
        std::fs::write(self.agents_file(), trimmed)?;
        Ok(())
    }
}

fn data_dir_name() -> String {
    std::env::current_dir()
        .ok()
        .and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
        .unwrap_or_else(|| "thai-agentic".to_string())
}

/// หาโฟลเดอร์เก็บ state
/// - `AGENT_DATA_DIR` → ใช้ตามนี้ (เช่นชี้ไปที่โฟลเดอร์โปรเจกต์เพื่อแชร์ state กับเวอร์ชัน JS)
/// - ถ้า cwd มีไฟล์ state รุ่นเก่าอยู่ → ใช้ cwd (แชร์ state ได้ทันที)
/// - มิฉะนั้น → `%APPDATA%/thai-agentic` (พฤติกรรม desktop app ทั่วไป)
pub fn resolve_data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("AGENT_DATA_DIR") {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let legacy = cwd.join("agent_users.json");
        let playbook = cwd.join("agent_playbook.json");
        if legacy.exists() || playbook.exists() {
            return cwd;
        }
    }
    dirs::data_dir()
        .map(|d| d.join("thai-agentic"))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// helper สำหรับคำสั่งที่คืนค่า error เป็น string ให้ฝั่ง UI
pub fn to_ui_error(e: AppError) -> String {
    e.to_string()
}

/// อ่านไฟล์แบบย่อย (สำหรับ preview ใน UI) — จำกัดขนาด
pub fn read_preview(path: &Path, max_bytes: usize) -> Result<String> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > max_bytes as u64 {
        return Err(AppError::msg(format!("ไฟล์ใหญ่เกิน {} KB", max_bytes / 1024)));
    }
    Ok(std::fs::read_to_string(path)?)
}
