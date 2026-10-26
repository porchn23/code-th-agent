//! thai-agentic — Rust desktop app (port ของ Node.js engine เดิม)
//!
//! โครงสร้าง:
//! - `agent/`    = LLM loop + tools + playbook/evals/skills (หัวใจ)
//! - `commands/` = Tauri commands = แทน server.js (HTTP+SSE → IPC + event)
//! - `guards.rs` = SSRF + path guard (ชั้นความปลอดภัย — ห้ามตก)
//! - `state.rs`  = ไฟล์ JSON state (แชร์ format กับเวอร์ชัน JS ได้)

pub mod agent;
pub mod auth;
pub mod commands;
pub mod config;
pub mod error;
pub mod guards;
pub mod state;
pub mod workspace;

use agent::Agent;
use config::Config;
use parking_lot::{Mutex, RwLock};
use state::Store;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// งานที่รอคิว (ลึก 1 ชิ้น เหมือน JS — คิวเต็ม = error)
#[derive(Clone)]
pub struct QueuedRun {
    pub task: String,
    pub model: Option<String>,
    pub temp: Option<f64>,
    pub max_steps: Option<usize>,
    pub history: Vec<agent::ChatMsg>,
    pub mode: String,
    pub plan_mode: bool,
    pub approved_plan: Option<agent::prompt::PlanInjection>,
    pub ws: Option<String>,
}

/// state กลางของแอป — เก็บใน Tauri (manage)
pub struct AppState {
    pub config: Arc<RwLock<Config>>,
    pub store: Store,
    pub agent: Agent,
    pub sessions: auth::Sessions,
    pub login_guard: auth::LoginGuard,
    /// มี run กำลังทำงานอยู่ไหม (กันยิงพร้อมกัน)
    pub running: Arc<AtomicBool>,
    /// signal ของ run ปัจจุบัน (ปุ่ม Stop)
    pub current_run: Arc<Mutex<Option<Arc<AtomicBool>>>>,
    /// คิวงาน (ลึก 1)
    pub queue: Arc<Mutex<Vec<QueuedRun>>>,
}

impl AppState {
    pub fn new() -> Self {
        let cfg = Config::default();
        let store = Store::new(cfg.data_dir.clone());
        let config = Arc::new(RwLock::new(cfg));
        let agent = Agent::new(config.clone(), store.clone());
        AppState {
            config,
            store,
            agent,
            sessions: auth::Sessions::default(),
            login_guard: auth::LoginGuard::default(),
            running: Arc::new(AtomicBool::new(false)),
            current_run: Arc::new(Mutex::new(None)),
            queue: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// ผู้ใช้จาก session id (ไม่ตรวจ auth — โหมด local ใช้ AGENT_NO_AUTH=1)
    pub fn current_user(&self, sid: Option<&str>) -> Option<state::User> {
        let sid = sid?;
        let su = self.sessions.get(sid)?;
        let users = self.store.load_users();
        users.into_iter().find(|u| u.name == su.name)
    }

    pub fn is_admin(&self, sid: Option<&str>) -> bool {
        if config::auth_off() {
            return true;
        }
        self.current_user(sid)
            .map(|u| u.is_admin())
            .unwrap_or(false)
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

/// entry point ของแอป
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let state = AppState::new();
    tracing::info!(
        data_dir = ?state.config.read().data_dir,
        "thai-agentic เริ่มทำงาน"
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::ask,
            commands::stop_run,
            commands::get_models,
            commands::get_playbook,
            commands::get_skills,
            commands::get_evals,
            commands::get_agents_rules,
            commands::set_agents_rules,
            commands::get_plan,
            commands::approve_plan,
            commands::get_checkpoints,
            commands::diff_checkpoint,
            commands::restore_checkpoint,
            commands::get_workspaces,
            commands::add_workspace,
            commands::remove_workspace,
            commands::list_tree,
            commands::read_file,
            commands::write_file,
            commands::list_worktrees,
            commands::create_worktree,
            commands::remove_worktree,
            commands::login,
            commands::register,
            commands::logout,
            commands::whoami,
            commands::update_profile,
            commands::change_password,
            commands::set_api_key,
            commands::get_api_key_info,
            commands::list_users,
            commands::add_user,
            commands::remove_user,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
