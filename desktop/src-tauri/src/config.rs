//! ค่าตั้งทั้งหมด — แก้ผ่าน env ได้เหมือนเวอร์ชัน JS

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
    pub max_steps: usize,
    pub fetch_timeout_ms: u64,
    pub fetch_max_chars: usize,
    pub search_max_chars: usize,
    pub subagent_fetch_chars: usize,
    pub max_history_msgs: usize,
    pub max_history_chars: usize,
    pub keep_tool_results: usize,
    pub trim_old_tool_chars: usize,
    pub data_dir: PathBuf,
}

pub const DEFAULT_MODEL: &str = "nvidia/nemotron-3.5-super-vl:free";

impl Default for Config {
    fn default() -> Self {
        Config {
            base_url: env_str("OPENROUTER_BASE_URL")
                .unwrap_or_else(|| "https://openrouter.ai/api/v1".to_string()),
            model: env_str("OPENROUTER_MODEL").unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            api_key: None,
            max_steps: 12,
            fetch_timeout_ms: 20_000,
            fetch_max_chars: 4_000,
            search_max_chars: 3_000,
            subagent_fetch_chars: 2_600,
            max_history_msgs: 8,
            max_history_chars: 1_200,
            keep_tool_results: 2,
            trim_old_tool_chars: 300,
            data_dir: crate::state::resolve_data_dir(),
        }
    }
}

fn env_str(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.trim().is_empty())
}

/// สวิตช์จาก env — อ่านสดทุกครั้ง (ให้ toggle ตอนรันได้ เหมือน JS)
pub fn auth_off() -> bool {
    std::env::var("AGENT_NO_AUTH").as_deref() == Ok("1")
}
pub fn checkpoints_off() -> bool {
    std::env::var("AGENT_NO_CHECKPOINTS").as_deref() == Ok("1")
}
pub fn evals_off() -> bool {
    std::env::var("AGENT_NO_EVALS").as_deref() == Ok("1")
}

/// โหลด API key จาก env → ไฟล์ .openrouter_key → ที่ตั้งไว้ใน settings
pub fn load_api_key(configured: Option<&str>) -> Option<String> {
    if let Ok(k) = std::env::var("OPENROUTER_API_KEY") {
        if !k.trim().is_empty() {
            return Some(k.trim().to_string());
        }
    }
    let key_file = crate::state::resolve_data_dir().join(".openrouter_key");
    if let Ok(raw) = std::fs::read_to_string(&key_file) {
        let t = raw.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    configured
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
