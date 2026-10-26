//! TOOL EXECUTION — รัน tool จริง (เทียบ runTool ใน research-agent.js)
//!
//! ทุก tool ที่แตะไฟล์/รันคำสั่ง ต้องผ่าน safe_project_path ก่อนเสมอ

use crate::agent::calc;
use crate::agent::playbook::scrub_secrets;
use crate::agent::skills;
use crate::agent::tools::built_in_names;
use crate::config::Config;
use crate::error::{AppError, Result};
use crate::guards::{fetch_with_public_redirects, safe_path_in_root};
use crate::state::{MemoryEntry, PlanFile, PlanStep, SkillEntry, Store};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------
// ค่าคงที่ (เทียบ JS)
// ---------------------------------------------------------------------
const TEXT_EXT_RE: &str =
    r"(?i)\.(md|txt|json|csv|js|mjs|cjs|ts|jsx|tsx|py|sh|bat|ps1|yml|yaml|html?|css)$";
const PROTECTED_RE: &str = r"(?i)(openrouter_key|node_modules|\.git|\.agent_memory|agent_playbook\.json|agent-events\.jsonl)";

static TEXT_EXT: Lazy<Regex> = Lazy::new(|| Regex::new(TEXT_EXT_RE).expect("ext regex"));
static PROTECTED: Lazy<Regex> = Lazy::new(|| Regex::new(PROTECTED_RE).expect("protected regex"));
static DANGER_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)|\bdel\s+/[sqf]\s|\brmdir\s+/s|\bformat\s+\w:|\bshutdown\b|:\|\s*mkfs\w*\b|\bdd\s+if=|\btaskkill\s+/f\b|\bdiskpart\b|\b Remove-Item .*-Recurse\b)")
        .expect("danger regex")
});
static SCRIPT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?is)<script[\s\S]*?</script>|<style[\s\S]*?</style>|<!--[\s\S]*?-->").unwrap()
});
static BR_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)<br\s*/?>|</(p|div|h[1-6]|li|tr)>").unwrap());
static TAG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)<[^>]+>").unwrap());
static WS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[ \t]+").unwrap());
static NL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\n\s*\n\s*\n+").unwrap());

/// sandbox runner สำหรับ js_eval (คัดลอกจาก js-eval-runner.js ที่รากโปรเจกต์)
const JS_EVAL_RUNNER: &str = include_str!("../../js-eval-runner.js");

// ---------------------------------------------------------------------
// ผลลัพธ์ของ run_command (ส่งไปแสดงในแผง run ของ UI)
// ---------------------------------------------------------------------
#[derive(Debug, Clone, Serialize)]
pub struct RunResult {
    pub cmd: String,
    pub code: i32,
    pub ms: u64,
    pub text: String,
}

// ---------------------------------------------------------------------
// context ของ tool
// ---------------------------------------------------------------------
pub type RunSink = Arc<dyn Fn(RunResult) + Send + Sync>;
pub type PlanSink = Arc<dyn Fn(PlanFile) + Send + Sync>;

pub struct ToolCtx {
    pub root: PathBuf,
    pub trusted: bool,
    pub depth: u32,
    pub fetch_chars: usize,
    pub signal: Arc<AtomicBool>,
    pub store: Store,
    pub config: Arc<RwLock<Config>>,
    pub llm: Arc<crate::agent::llm::LlmClient>,
    pub on_run: Option<RunSink>,
    pub on_plan: Option<PlanSink>,
    /// spec ของ tool ที่เพิ่งสร้างสำเร็จใน run นี้ (live-spec injection)
    pub live_specs: Arc<parking_lot::Mutex<Vec<Value>>>,
}

impl ToolCtx {
    fn cfg(&self) -> Config {
        self.config.read().clone()
    }
}

// ---------------------------------------------------------------------
// helper
// ---------------------------------------------------------------------
pub fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!(
            "{}\n... [truncated, {} chars total]",
            s.chars().take(n).collect::<String>(),
            s.chars().count()
        )
    }
}

/// แปลง HTML เป็นข้อความล้วน — เทียบ stripHtml ใน JS
pub fn strip_html(html: &str) -> String {
    let s = SCRIPT_RE.replace_all(html, " ");
    let s = BR_RE.replace_all(&s, "\n");
    let s = TAG_RE.replace_all(&s, " ");
    let s = s
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">");
    let s = s
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&quot;", "\"");
    let s = WS_RE.replace_all(&s, " ");
    let s = NL_RE.replace_all(&s, "\n\n");
    s.trim().to_string()
}

/// path ที่ปลอดภัย + ไม่ใช่ไฟล์ลับ/ไฟล์ระบบ
pub fn safe_project_path(rel: &str, root: &Path) -> Result<PathBuf> {
    let abs = safe_path_in_root(root, rel)?;
    let text = abs.to_string_lossy();
    if PROTECTED.is_match(&text) {
        return Err(AppError::msg("Access denied (protected file)"));
    }
    Ok(abs)
}

fn is_text_ext(path: &Path) -> bool {
    TEXT_EXT.is_match(&path.to_string_lossy())
}

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

// ---------------------------------------------------------------------
// จุดเข้าเดียวของทุก tool
// ---------------------------------------------------------------------
pub async fn run_tool(name: &str, args: &Value, ctx: &ToolCtx) -> Result<String> {
    // admin-only: run_command / tool_create / custom tool
    if !ctx.trusted
        && (name == "run_command" || name == "tool_create" || skills::has_skill(&ctx.store, name))
    {
        return Err(AppError::msg("This tool is available to admins only"));
    }

    match name {
        "web_fetch" => tool_web_fetch(args, ctx).await,
        "web_search" => tool_web_search(args, ctx).await,
        "get_datetime" => Ok(tool_get_datetime()),
        "calculator" => tool_calculator(args),
        "js_eval" => tool_js_eval(args, ctx).await,
        "file_read" => tool_file_read(args, ctx),
        "file_write" => tool_file_write(args, ctx),
        "run_command" => tool_run_command(args, ctx).await,
        "file_edit" => tool_file_edit(args, ctx),
        "file_grep" => tool_file_grep(args, ctx),
        "memory_save" => tool_memory_save(args, ctx),
        "memory_recall" => tool_memory_recall(args, ctx),
        "save_plan" => tool_save_plan(args, ctx),
        "plan_done" => tool_plan_done(args, ctx),
        "tool_create" => tool_tool_create(args, ctx).await,
        "research_subagent" => Err(AppError::msg(
            "sub-agent ต้องถูกเรียกจาก agent loop (ดู agent::run_subagent)",
        )),
        _ => {
            if skills::has_skill(&ctx.store, name) {
                return run_custom_tool(name, args, ctx).await;
            }
            Err(AppError::msg(format!("Unknown tool: {name}")))
        }
    }
}

// ---------------------------------------------------------------------
// TOOL: get_datetime
// ---------------------------------------------------------------------
fn tool_get_datetime() -> String {
    let now = chrono::Utc::now();
    let local = now.with_timezone(&chrono::Local);
    format!(
        "ISO: {} | Local: {} | Timezone: {}",
        now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        local.format("%Y-%m-%d %H:%M:%S"),
        local.format("%Z")
    )
}

// ---------------------------------------------------------------------
// TOOL: calculator
// ---------------------------------------------------------------------
fn tool_calculator(args: &Value) -> Result<String> {
    let expr = arg_str(args, "expression");
    match calc::eval(&expr) {
        Ok(v) => Ok(calc::format_number(v)),
        Err(e) => Err(AppError::msg(e)),
    }
}

// ---------------------------------------------------------------------
// TOOL: web_fetch — SSRF guard + strip HTML
// ---------------------------------------------------------------------
async fn tool_web_fetch(args: &Value, ctx: &ToolCtx) -> Result<String> {
    let url = arg_str(args, "url");
    let cfg = ctx.cfg();
    let res = fetch_with_public_redirects(
        &url,
        5,
        Duration::from_millis(cfg.fetch_timeout_ms),
        "Mozilla/5.0 research-agent-tutorial",
        2 * 1024 * 1024,
    )
    .await
    .map_err(|e| AppError::msg(e.to_string()))?;

    if !(200..300).contains(&res.status) {
        return Err(AppError::msg(format!("HTTP {} for {url}", res.status)));
    }
    let ct = res.content_type.to_lowercase();
    if !ct.contains("html") && !ct.contains("text") {
        return Ok(format!(
            "[{ct} — binary/content type not supported, try another source]"
        ));
    }
    let text = strip_html(&res.body);
    Ok(format!(
        "### CONTENT OF {url}\n{}",
        truncate(&text, ctx.fetch_chars)
    ))
}

// ---------------------------------------------------------------------
// TOOL: web_search — ใช้เคล็ดลับ OpenRouter :online
// ---------------------------------------------------------------------
async fn tool_web_search(args: &Value, ctx: &ToolCtx) -> Result<String> {
    let query = arg_str(args, "query");
    let cfg = ctx.cfg();
    let mut model_cfg = cfg.clone();
    model_cfg.model = format!("{}:online", cfg.model);

    let body = json!({
        "model": model_cfg.model,
        "messages": [{
            "role": "user",
            "content": format!(
                "Search the web now for: \"{query}\". List the top 5 results. For each one give: title, URL, and a one-sentence summary. Output only the list."
            )
        }],
        "max_tokens": 800
    });

    let msg = ctx
        .llm
        .call(&model_cfg, &body, &ctx.signal, &mut |_| {})
        .await?;
    Ok(format!(
        "### SEARCH RESULTS for \"{query}\"\n{}",
        truncate(&msg.content, cfg.search_max_chars)
    ))
}

// ---------------------------------------------------------------------
// TOOL: js_eval — รัน JS ใน sandbox ผ่าน node (คัดลอกพฤติกรรม JS เดิม)
// ---------------------------------------------------------------------
async fn tool_js_eval(args: &Value, ctx: &ToolCtx) -> Result<String> {
    let code = args
        .get("code")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if code.trim().is_empty() {
        return Err(AppError::msg("code is required"));
    }
    if code.chars().count() > 20_000 {
        return Err(AppError::msg("Code too long (max 20000 chars)"));
    }

    let tmp = tempdir()?;
    let code_file = tmp.join("code.js");
    let runner_file = tmp.join("runner.js");
    std::fs::write(&code_file, &code)?;
    std::fs::write(&runner_file, JS_EVAL_RUNNER)?;

    let output = tokio::process::Command::new("node")
        .arg(&runner_file)
        .arg(&code_file)
        .current_dir(&tmp)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();

    let out = match tokio::time::timeout(Duration::from_secs(5), output).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(AppError::msg(format!("js_eval failed to start: {e}"))),
        Err(_) => return Ok("Error: js_eval timed out after 5s".to_string()),
    };

    if ctx.signal.load(Ordering::Relaxed) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Ok("Error: js_eval cancelled".to_string());
    }

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let mut combined = stdout;
    if !stderr.trim().is_empty() {
        combined.push_str(&format!("\n[stderr] {}", stderr.trim()));
    }
    let text = combined.trim().to_string();
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(if text.is_empty() {
        "(no output — did you forget console.log?)".to_string()
    } else {
        text
    })
}

// ---------------------------------------------------------------------
// TOOL: file_read / file_write
// ---------------------------------------------------------------------
fn tool_file_read(args: &Value, ctx: &ToolCtx) -> Result<String> {
    let rel = arg_str(args, "path");
    let abs = safe_project_path(&rel, &ctx.root)?;
    if !is_text_ext(&abs) {
        return Err(AppError::msg(
            "Only text file extensions are allowed (md/txt/json/csv/js/ts/jsx/html/css/py/sh/bat/ps1/yml)",
        ));
    }
    if !abs.exists() {
        return Err(AppError::msg(format!("File not found: {rel}")));
    }
    let text = std::fs::read_to_string(&abs)?;
    Ok(format!("### FILE {rel}\n{}", truncate(&text, 20_000)))
}

fn tool_file_write(args: &Value, ctx: &ToolCtx) -> Result<String> {
    let rel = arg_str(args, "path");
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let abs = safe_project_path(&rel, &ctx.root)?;
    let reports_dir = ctx.root.join("reports");
    let abs_norm = abs.to_string_lossy().replace('\\', "/");
    let reports_norm = reports_dir.to_string_lossy().replace('\\', "/");
    if !abs_norm.starts_with(&format!("{reports_norm}/")) {
        return Err(AppError::msg(
            "Writes are only allowed inside reports/ (e.g. reports/my-report.md)",
        ));
    }
    if !is_text_ext(&abs) {
        return Err(AppError::msg(
            "Only text file extensions are allowed (md/txt/json/csv/js/ts/jsx/html/css/py/sh/bat/ps1/yml)",
        ));
    }
    std::fs::create_dir_all(&reports_dir)?;
    std::fs::write(&abs, &content)?;
    let name = abs
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(format!(
        "Saved {} chars to {} ({})",
        content.chars().count(),
        rel,
        name
    ))
}

// ---------------------------------------------------------------------
// TOOL: file_edit — exact string replacement (ACI ของ SWE-agent)
// ---------------------------------------------------------------------
fn tool_file_edit(args: &Value, ctx: &ToolCtx) -> Result<String> {
    let rel = arg_str(args, "path");
    let abs = safe_project_path(&rel, &ctx.root)?;
    if !is_text_ext(&abs) {
        return Err(AppError::msg("Only text files can be edited"));
    }
    if !abs.exists() {
        return Err(AppError::msg(format!(
            "File not found: {rel} (read it first with file_read)"
        )));
    }
    let old_str = arg_str(args, "oldString");
    let new_str = arg_str(args, "newString");
    let replace_all = args
        .get("replace_all")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if old_str.is_empty() {
        return Err(AppError::msg("oldString is required"));
    }
    if old_str == new_str {
        return Err(AppError::msg("oldString and newString must differ"));
    }

    let text = std::fs::read_to_string(&abs)?;
    let count = text.matches(&old_str).count();
    if count == 0 {
        return Err(AppError::msg(
            "oldString not found in file — file_read the file, then copy the exact text",
        ));
    }
    if count > 1 && !replace_all {
        return Err(AppError::msg(format!(
            "oldString matches {count} places — add surrounding context to make it unique, or set replace_all:true"
        )));
    }
    let updated = if replace_all {
        text.replace(&old_str, &new_str)
    } else {
        text.replacen(&old_str, &new_str, 1)
    };
    std::fs::write(&abs, &updated)?;
    let replaced = if replace_all { count } else { 1 };
    Ok(format!(
        "Edited {}: replaced {} occurrence{} ({} → {} chars)",
        rel,
        replaced,
        if replaced > 1 { "s" } else { "" },
        text.chars().count(),
        updated.chars().count()
    ))
}

// ---------------------------------------------------------------------
// TOOL: file_grep
// ---------------------------------------------------------------------
fn tool_file_grep(args: &Value, ctx: &ToolCtx) -> Result<String> {
    let pattern = arg_str(args, "pattern");
    let include = arg_str(args, "include");
    let re = Regex::new(&format!("(?i){pattern}")).map_err(|e| AppError::msg(e.to_string()))?;

    let mut hits: Vec<String> = Vec::new();
    let mut truncated = false;

    for entry in walkdir::WalkDir::new(&ctx.root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            !(e.file_type().is_dir()
                && (name == "node_modules" || name == ".git" || name == "reports"))
        })
    {
        if hits.len() >= 60 {
            truncated = true;
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !include.is_empty() && !glob_match(&include, &name) {
            continue;
        }
        if !is_text_ext(Path::new(&name)) {
            continue;
        }
        if PROTECTED.is_match(&name) {
            continue;
        }
        let content = match std::fs::read_to_string(entry.path()) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for (i, line) in content.lines().enumerate() {
            if re.is_match(line) {
                let rel = entry
                    .path()
                    .strip_prefix(&ctx.root)
                    .unwrap_or(entry.path())
                    .to_string_lossy()
                    .replace('\\', "/");
                hits.push(format!("{rel}:{}: {}", i + 1, truncate(line.trim(), 200)));
                if hits.len() >= 60 {
                    truncated = true;
                    break;
                }
            }
        }
    }

    if hits.is_empty() {
        return Ok(format!("No matches for /{pattern}/"));
    }
    Ok(format!(
        "### GREP /{pattern}/ ({} hits{})\n{}",
        hits.len(),
        if truncated { ", truncated" } else { "" },
        hits.join("\n")
    ))
}

/// glob แบบง่าย: * = ไม่ข้ามจุด, ** = ข้ามได้
fn glob_match(pattern: &str, name: &str) -> bool {
    let p = pattern.replace("**", "\u{0}");
    let re = format!(
        "^{}$",
        regex::escape(&p)
            .replace("\\*", "[^.]*")
            .replace('\u{0}', ".+")
    );
    Regex::new(&format!("(?i){re}"))
        .map(|r| r.is_match(name))
        .unwrap_or(false)
}

// ---------------------------------------------------------------------
// TOOL: run_command (admin only)
// ---------------------------------------------------------------------
async fn tool_run_command(args: &Value, ctx: &ToolCtx) -> Result<String> {
    let cmd = arg_str(args, "command");
    if cmd.trim().is_empty() {
        return Err(AppError::msg("command required"));
    }
    if DANGER_RE.is_match(&cmd) {
        return Err(AppError::msg("Blocked: potentially destructive command"));
    }
    let timeout_ms = args
        .get("timeoutMs")
        .and_then(|v| v.as_f64())
        .unwrap_or(15_000.0)
        .clamp(2_000.0, 60_000.0) as u64;

    let t0 = Instant::now();
    let shell_output = shell_exec(&cmd, &ctx.root, Duration::from_millis(timeout_ms)).await;
    let (code, stdout, stderr) = match shell_output {
        Ok(v) => v,
        Err(e) => (1, String::new(), e.to_string()),
    };

    let out = scrub_secrets(&stdout.chars().take(6000).collect::<String>());
    let err = scrub_secrets(&stderr.chars().take(2000).collect::<String>());
    let killed = code == -1;
    let tail = if killed { "…[killed on timeout]" } else { "" };

    let mut result = format!("### RUN: {cmd}\nexit {code}{tail}\n");
    if !out.is_empty() {
        result.push_str(&format!("--- stdout ---\n{out}"));
    }
    if !err.is_empty() {
        result.push_str(&format!("--- stderr ---\n{err}"));
    }

    if let Some(sink) = &ctx.on_run {
        let mut text = stdout.clone();
        if !stderr.trim().is_empty() {
            text.push_str(&format!("\n[stderr] {}", stderr.trim()));
        }
        sink(RunResult {
            cmd: cmd.clone(),
            code,
            ms: t0.elapsed().as_millis() as u64,
            text: truncate(&text, 2000),
        });
    }

    Ok(result.trim().to_string())
}

/// รันคำสั่งผ่าน shell ของระบบ (เหมือน child_process.exec ของ Node)
async fn shell_exec(
    cmd: &str,
    cwd: &Path,
    timeout: Duration,
) -> std::io::Result<(i32, String, String)> {
    let mut command = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(cmd);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(cmd);
        c
    };
    command
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let fut = command.output();
    match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(out)) => Ok((
            out.status.code().unwrap_or(0),
            String::from_utf8_lossy(&out.stdout).to_string(),
            String::from_utf8_lossy(&out.stderr).to_string(),
        )),
        Ok(Err(e)) => Err(e),
        Err(_) => Ok((-1, String::new(), "killed on timeout".to_string())),
    }
}

// ---------------------------------------------------------------------
// TOOL: memory_save / memory_recall
// ---------------------------------------------------------------------
fn tool_memory_save(args: &Value, ctx: &ToolCtx) -> Result<String> {
    let key = arg_str(args, "key").trim().to_lowercase();
    let note = arg_str(args, "note").trim().to_string();
    if key.is_empty() || note.is_empty() {
        return Err(AppError::msg("Both key and note are required"));
    }
    let key: String = key.chars().take(60).collect();
    let note: String = note.chars().take(1000).collect();

    let mut list = ctx.store.load_memory();
    list.retain(|m| m.key != key);
    list.push(MemoryEntry {
        key: key.clone(),
        note,
    });
    if list.len() > 50 {
        list.drain(0..list.len() - 50);
    }
    ctx.store.save_memory(&list)?;
    Ok(format!(
        "Saved memory \"{key}\" ({} notes total)",
        list.len()
    ))
}

fn tool_memory_recall(args: &Value, ctx: &ToolCtx) -> Result<String> {
    let q = arg_str(args, "query").trim().to_lowercase();
    if q.is_empty() {
        return Err(AppError::msg("query required"));
    }
    let words: Vec<&str> = q.split_whitespace().filter(|w| !w.is_empty()).collect();
    let all = ctx.store.load_memory();
    let hits: Vec<&MemoryEntry> = all
        .iter()
        .filter(|m| {
            let key = m.key.to_lowercase();
            let note = m.note.to_lowercase();
            words.iter().any(|w| key.contains(w) || note.contains(w))
        })
        .collect();
    if hits.is_empty() {
        return Ok(format!("No memory matches \"{q}\"."));
    }
    Ok(format!(
        "### MEMORY MATCHES\n{}",
        hits.iter()
            .map(|m| format!("- [{}] {}", m.key, m.note))
            .collect::<Vec<_>>()
            .join("\n")
    ))
}

// ---------------------------------------------------------------------
// TOOL: save_plan / plan_done
// ---------------------------------------------------------------------
fn tool_save_plan(args: &Value, ctx: &ToolCtx) -> Result<String> {
    let title = arg_str(args, "title");
    let steps_raw = args
        .get("steps")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let steps: Vec<PlanStep> = steps_raw
        .iter()
        .filter_map(|s| s.as_str())
        .map(|s| PlanStep {
            text: s.trim().to_string(),
            done: false,
        })
        .filter(|s| !s.text.is_empty())
        .take(10)
        .collect();

    if steps.is_empty() {
        return Err(AppError::msg("plan needs at least one step"));
    }

    let plan = PlanFile {
        id: format!("p-{:x}", crate::agent::playbook::now_ms()),
        ts: crate::agent::playbook::now_ms(),
        title: title.chars().take(120).collect(),
        steps,
    };
    ctx.store.save_plan(&plan)?;
    if let Some(sink) = &ctx.on_plan {
        sink(plan.clone());
    }
    Ok(format!(
        "Plan \"{}\" saved with {} steps. End now with ONE short message saying the plan is ready and waiting for the user to approve it in the web UI.",
        plan.title,
        plan.steps.len()
    ))
}

fn tool_plan_done(args: &Value, ctx: &ToolCtx) -> Result<String> {
    let n = args.get("step").and_then(|v| v.as_u64()).unwrap_or(0);
    if n == 0 {
        return Err(AppError::msg("step must be 1-based"));
    }
    let mut plan = ctx
        .store
        .load_plan()
        .ok_or_else(|| AppError::msg("No plan found — save_plan first"))?;
    let idx = (n as usize).saturating_sub(1);
    if idx >= plan.steps.len() {
        return Err(AppError::msg(format!(
            "step {n} is out of range (plan has {} steps)",
            plan.steps.len()
        )));
    }
    plan.steps[idx].done = true;
    let text = plan.steps[idx].text.chars().take(80).collect::<String>();
    ctx.store.save_plan(&plan)?;
    if let Some(sink) = &ctx.on_plan {
        sink(plan.clone());
    }
    Ok(format!("✓ step {n} marked done: {text}"))
}

// ---------------------------------------------------------------------
// TOOL: tool_create (circuit 2) + custom tool runner
// ---------------------------------------------------------------------
async fn tool_tool_create(args: &Value, ctx: &ToolCtx) -> Result<String> {
    let name = arg_str(args, "name");
    if !crate::agent::tools::valid_tool_name(&name) {
        return Err(AppError::msg(
            "tool name must match /^[a-z][a-z0-9_]{2,29}$/",
        ));
    }
    if built_in_names().iter().any(|n| n == &name) {
        return Err(AppError::msg(format!(
            "\"{name}\" is a built-in tool name — choose another name"
        )));
    }
    let desc: String = WS_RE
        .replace_all(arg_str(args, "description").trim(), " ")
        .chars()
        .take(200)
        .collect();
    let src = args
        .get("code")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if src.trim().is_empty() {
        return Err(AppError::msg("code is required"));
    }
    if src.chars().count() > 10_000 {
        return Err(AppError::msg("code too long (max 10000 chars)"));
    }
    if src.contains(".openrouter_key")
        || src.contains("agent_playbook")
        || src.contains("agent-events")
    {
        return Err(AppError::msg("code must not touch protected files"));
    }
    let schema = match args.get("params") {
        Some(p) if p.get("type").and_then(|v| v.as_str()) == Some("object") => p.clone(),
        _ => json!({ "type": "object", "properties": {} }),
    };

    let tools_dir = ctx.store.tools_dir();
    std::fs::create_dir_all(&tools_dir)?;
    let file = tools_dir.join(format!("{name}.js"));
    std::fs::write(&file, &src)?;

    // ทดสอบจริง 1 ครั้ง: ผ่าน = exit 0 + stdout เป็น JSON ได้เท่านั้น
    let test_args = args.get("test_args").cloned().unwrap_or(json!({}));
    let test = run_tool_process(&file, &test_args, Duration::from_secs(10)).await;

    let reject = |msg: &str, stderr: &str| -> String {
        let _ = std::fs::remove_file(&file);
        format!("{msg}\n{}", truncate(stderr.trim(), 600))
    };

    if test.timed_out {
        return Ok(reject(
            &format!("Tool \"{name}\" FAILED test: timeout after 10s (infinite loop?) — nothing registered"),
            &test.stderr,
        ));
    }
    if test.code != 0 {
        return Ok(reject(
            &format!("Tool \"{name}\" FAILED test: exit code non-zero — nothing registered"),
            &test.stderr,
        ));
    }
    let parsed: Value = match serde_json::from_str(test.stdout.trim()) {
        Ok(v) => v,
        Err(_) => {
            return Ok(reject(
                &format!("Tool \"{name}\" FAILED test: stdout was not valid JSON. Remember the contract: read JSON args from process.argv[2], print ONE JSON object to stdout — nothing registered"),
                &test.stderr,
            ))
        }
    };

    skills::save_skill(
        &ctx.store,
        SkillEntry {
            name: name.clone(),
            description: desc.clone(),
            params: schema.clone(),
            created_at: crate::agent::playbook::now_ms(),
            last_used: crate::agent::playbook::now_ms(),
            calls: 0,
        },
    );

    let spec = json!({
        "type": "function",
        "function": {
            "name": name,
            "description": format!("[custom tool] {desc}"),
            "parameters": schema
        }
    });
    // live-spec injection → ใช้ได้ทันทีใน run เดียวกัน
    ctx.live_specs.lock().push(spec.clone());

    Ok(format!(
        "### REGISTERED TOOL {name}\nTest run output: {}\nIt is now available as an extra function call (persists across runs). Use it when relevant; rebuild it only if you need different behavior.",
        truncate(&parsed.to_string(), 400)
    ))
}

struct ProcOut {
    code: i32,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

async fn run_tool_process(file: &Path, args: &Value, timeout: Duration) -> ProcOut {
    let payload = args.to_string();
    let mut command = tokio::process::Command::new("node");
    command
        .arg(file)
        .arg(&payload)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    match tokio::time::timeout(timeout, command.output()).await {
        Ok(Ok(out)) => ProcOut {
            code: out.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            timed_out: false,
        },
        Ok(Err(e)) => ProcOut {
            code: 1,
            stdout: String::new(),
            stderr: e.to_string(),
            timed_out: false,
        },
        Err(_) => ProcOut {
            code: -1,
            stdout: String::new(),
            stderr: "timeout".to_string(),
            timed_out: true,
        },
    }
}

async fn run_custom_tool(name: &str, args: &Value, ctx: &ToolCtx) -> Result<String> {
    let file = ctx.store.tools_dir().join(format!("{name}.js"));
    if !file.exists() {
        return Err(AppError::msg(format!(
            "Custom tool \"{name}\" is registered but its file is missing under tools/ — recreate it with tool_create"
        )));
    }
    let out = run_tool_process(&file, args, Duration::from_secs(10)).await;
    skills::bump_usage(&ctx.store, name);
    let mut text = out.stdout;
    if !out.stderr.trim().is_empty() {
        text.push_str(&format!("\n[stderr] {}", out.stderr.trim()));
    }
    Ok(truncate(text.trim(), 8000))
}

// ---------------------------------------------------------------------
// โฟลเดอร์ชั่วคราว (ไม่พึ่ง crate เพิ่ม)
// ---------------------------------------------------------------------
fn tempdir() -> Result<PathBuf> {
    let base = std::env::temp_dir();
    let stamp = format!(
        "agent-eval-{}-{}",
        std::process::id(),
        crate::agent::playbook::now_ms()
    );
    let dir = base.join(stamp);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_html() {
        let html = "<html><head><style>x{}</style></head><body><h1>Title</h1><p>Hello <b>world</b></p><script>bad()</script></body></html>";
        let out = strip_html(html);
        assert!(out.contains("Title"));
        assert!(out.contains("Hello"));
        assert!(!out.contains("bad()"));
        assert!(!out.contains("x{}"));
    }

    #[test]
    fn truncate_marks_cut() {
        let s = "a".repeat(100);
        let out = truncate(&s, 10);
        assert!(out.starts_with("aaaaaaaaaa"));
        assert!(out.contains("truncated"));
    }

    #[test]
    fn glob_matches_like_js() {
        assert!(glob_match("*.js", "server.js"));
        assert!(!glob_match("*.js", "server.ts"));
    }

    #[test]
    fn danger_regex_blocks_destructive() {
        assert!(DANGER_RE.is_match("rm -rf /"));
        assert!(DANGER_RE.is_match("format c:"));
        assert!(!DANGER_RE.is_match("node test.js"));
    }
}
