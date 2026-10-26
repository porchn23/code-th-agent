//! Tauri commands = แทน server.js (HTTP + SSE → IPC + event)
//!
//! Event channel: "agent-event" → payload { type, data, runId }
//! type เดียวกับ SSE ของเวอร์ชัน JS: log | answer | answer-delta | answer-reset
//!                | error | run | plan | queued

use crate::agent::prompt::PlanInjection;
use crate::agent::{self, tools, AgentEvent, ChatMsg, RunOptions};
use crate::auth;
use crate::config;
use crate::error::AppError;
use crate::guards::safe_path_in_root;
use crate::state::{PlanFile, Workspace};
use crate::workspace as ws_mod;
use crate::{AppState, QueuedRun};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

const EVENT_CHANNEL: &str = "agent-event";

// ---------------------------------------------------------------------
// ตัวช่วย
// ---------------------------------------------------------------------
fn err_msg(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// ส่ง event ไป UI (พร้อม runId เพื่อให้แยกงานได้)
fn emit_event(app: &AppHandle, ev: AgentEvent, run_id: &str) {
    let mut payload = serde_json::to_value(ev).unwrap_or(Value::Null);
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("runId".to_string(), json!(run_id));
    }
    let _ = app.emit(EVENT_CHANNEL, payload);
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

// ---------------------------------------------------------------------
// รูปแบบ input จาก UI
// ---------------------------------------------------------------------
#[derive(Debug, Clone, Deserialize)]
pub struct ChatMsgIn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlanStepIn {
    pub text: String,
    #[serde(default)]
    pub done: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlanIn {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub steps: Vec<PlanStepIn>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub context: u64,
    pub free: bool,
    pub tools: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfileOut {
    pub name: String,
    pub email: String,
    pub role: String,
    pub has_key: bool,
    pub key_tail: String,
}

// =====================================================================
// AGENT
// =====================================================================

#[tauri::command]
pub async fn ask(
    app: AppHandle,
    state: State<'_, AppState>,
    task: String,
    model: Option<String>,
    temp: Option<f64>,
    max_steps: Option<usize>,
    history: Option<Vec<ChatMsgIn>>,
    mode: Option<String>,
    plan_mode: Option<bool>,
    approved_plan: Option<PlanIn>,
    ws: Option<String>,
) -> Result<String, String> {
    // ---- validate (ไม่รับค่ามั่วจาก client — เหมือน JS) ----
    let task = task.trim().to_string();
    if task.is_empty() {
        return Err("Missing task".into());
    }
    if task.chars().count() > 8000 {
        return Err("งานยาวเกินไป (สูงสุด 8000 ตัวอักษร)".into());
    }

    let mode_n = match mode.as_deref() {
        Some("code") => "code".to_string(),
        _ => "research".to_string(),
    };

    // model ต้องมีอยู่จริงและรองรับ tools
    let mut use_model = config::DEFAULT_MODEL.to_string();
    if let Some(m) = model.as_ref().filter(|m| !m.trim().is_empty()) {
        let list = fetch_models().await?;
        let found = list.iter().find(|x| x.id == *m && x.tools);
        match found {
            Some(f) => use_model = f.id.clone(),
            None => {
                return Err(format!(
                    "Model \"{m}\" not found or doesn't support tool calling"
                ))
            }
        }
    }

    let use_temp = match temp {
        Some(t) if (0.0..=2.0).contains(&t) => Some(t as f32),
        _ => None,
    };
    let use_steps = max_steps
        .map(|s| s.clamp(4, 24))
        .unwrap_or(if mode_n == "code" { 24 } else { 12 });

    let clean_history: Vec<ChatMsg> = history
        .unwrap_or_default()
        .into_iter()
        .filter(|m| (m.role == "user" || m.role == "assistant") && !m.content.is_empty())
        .rev()
        .take(8)
        .map(|m| ChatMsg {
            role: m.role,
            content: m.content.chars().take(1200).collect(),
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    // ---- sanitize แผนที่ผ่านการอนุมัติ ----
    let mut plan_tl = plan_mode.unwrap_or(false);
    let mut approved: Option<PlanInjection> = None;
    if let Some(p) = approved_plan {
        let steps: Vec<_> = p
            .steps
            .into_iter()
            .filter(|s| !s.text.is_empty())
            .take(10)
            .map(|s| agent::prompt::PlanStepInjection {
                text: s.text.chars().take(200).collect(),
                done: s.done,
            })
            .collect();
        if !steps.is_empty() {
            approved = Some(PlanInjection {
                title: p.title.chars().take(120).collect(),
                steps,
            });
            plan_tl = false;
        }
    }

    // ---- เลือก workspace ----
    let workspaces = ws_mod::load_workspaces(&state.store);
    let ws_obj = match ws_mod::find_ws(&workspaces, ws.as_deref().unwrap_or("")) {
        Some(w) => w.clone(),
        None => return Err("ไม่พบพื้นที่ทำงานนี้".into()),
    };

    let run = QueuedRun {
        task: task.clone(),
        model: Some(use_model.clone()),
        temp: use_temp.map(|t| t as f64),
        max_steps: Some(use_steps),
        history: clean_history,
        mode: mode_n,
        plan_mode: plan_tl,
        approved_plan: approved,
        ws: Some(ws_obj.id.clone()),
    };

    // ---- คิว (ลึก 1) ----
    if state.running.load(Ordering::Relaxed) {
        let mut q = state.queue.lock();
        if !q.is_empty() {
            return Err("Agent is busy and the queue is full — try again soon".into());
        }
        q.push(run);
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            emit_event(&app2, AgentEvent::Queued, "queue");
        });
        return Ok("queued".into());
    }

    start_run(app.clone(), state.inner(), run);
    Ok("started".into())
}

/// ทุกอย่างที่ run ต้องใช้ — เป็น owned ล้วน เพื่อให้ส่งเข้า spawned task ได้ (ต้อง 'static)
struct RunCtx {
    app: AppHandle,
    agent: agent::Agent,
    store: crate::state::Store,
    config: Arc<parking_lot::RwLock<config::Config>>,
    running: Arc<AtomicBool>,
    current_run: Arc<parking_lot::Mutex<Option<Arc<AtomicBool>>>>,
    queue: Arc<parking_lot::Mutex<Vec<QueuedRun>>>,
}

/// เริ่ม run (หรือดึงงานจากคิวมาต่อ)
fn start_run(app: AppHandle, state: &AppState, run: QueuedRun) {
    let ctx = RunCtx {
        app: app.clone(),
        agent: state.agent.clone(),
        store: state.store.clone(),
        config: state.config.clone(),
        running: state.running.clone(),
        current_run: state.current_run.clone(),
        queue: state.queue.clone(),
    };
    tauri::async_runtime::spawn(async move {
        run_task(ctx, run).await;
    });
}

/// ตัวรัน 1 งาน (ถ้ามีงานต่อคิว → รันต่ออัตโนมัติเมื่องานนี้จบ)
async fn run_task(ctx: RunCtx, run: QueuedRun) {
    let RunCtx {
        app,
        agent,
        store,
        config,
        running,
        current_run,
        queue,
    } = ctx;

    running.store(true, Ordering::Relaxed);

    let run_id = format!(
        "{:x}{}",
        agent::playbook::now_ms(),
        (agent::playbook::now_ms() % 36_000_000)
    );
    let signal = Arc::new(AtomicBool::new(false));
    *current_run.lock() = Some(signal.clone());

    let app_run = app.clone();
    let app_plan = app.clone();
    let rid_plan = run_id.clone();
    let rid_run = run_id.clone();

    let emit: agent::EventSink = {
        let a = app.clone();
        let rid = run_id.clone();
        Arc::new(move |ev: AgentEvent| emit_event(&a, ev, &rid))
    };

    let trusted = true; // โหมด local: เจ้าของเครื่องคือ admin (auth เต็มจะมาเติมทีหลัง)
    let workspaces = ws_mod::load_workspaces(&store);
    let ws_dir = ws_mod::find_ws(&workspaces, run.ws.as_deref().unwrap_or(""))
        .map(|w| PathBuf::from(&w.dir))
        .unwrap_or_else(|| config.read().data_dir.clone());

    let opts = RunOptions {
        depth: 0,
        tools: Some(tools::get_tools(
            &run.mode,
            &tools::ToolOptions {
                trusted,
                save: run.plan_mode,
                done: run.approved_plan.is_some(),
                ..Default::default()
            },
            &agent::skills::load_skills(&store),
        )),
        max_steps: run.max_steps.unwrap_or(12),
        temp: run.temp.map(|t| t as f32),
        history: run.history,
        mode: run.mode,
        plan_mode: run.plan_mode,
        approved_plan: run.approved_plan,
        root: Some(ws_dir),
        trusted,
        signal: signal.clone(),
        emit: emit.clone(),
        on_run: Some(Arc::new(move |r| {
            emit_event(&app_run, AgentEvent::Run(r), &rid_run);
        })),
        on_plan: Some(Arc::new(move |p: PlanFile| {
            emit_event(&app_plan, AgentEvent::Plan(p), &rid_plan);
        })),
        ..Default::default()
    };

    // ใช้ model ที่เลือก + key ของผู้ใช้ (ถ้ามี) ไม่งั้นใช้ key ของเครื่อง
    if let Some(m) = &run.model {
        config.write().model = m.clone();
    }
    config.write().api_key = config::load_api_key(None);

    let result = agent::agent_loop(&agent, &run.task, opts).await;
    config.write().model = config::DEFAULT_MODEL.to_string();

    match result {
        Ok(answer) => emit_event(&app, AgentEvent::Answer(answer), &run_id),
        Err(e) => {
            if !signal.load(Ordering::Relaxed) {
                emit_event(&app, AgentEvent::Error(err_msg(e)), &run_id);
            }
        }
    }

    running.store(false, Ordering::Relaxed);
    *current_run.lock() = None;

    // งานถัดไปจากคิว (ถ้ามี)
    let next = queue.lock().pop();
    if let Some(next) = next {
        run_task(
            RunCtx {
                app,
                agent,
                store,
                config,
                running,
                current_run,
                queue,
            },
            next,
        )
        .await;
    }
}

#[tauri::command]
pub fn stop_run(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(sig) = state.current_run.lock().as_ref() {
        sig.store(true, Ordering::Relaxed);
        return Ok(());
    }
    Err("ไม่มีงานกำลังรัน".into())
}

// =====================================================================
// MODEL
// =====================================================================
async fn fetch_models() -> Result<Vec<ModelInfo>, String> {
    let http = reqwest::Client::new();
    let res = http
        .get("https://openrouter.ai/api/v1/models")
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Model list fetch failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Model list fetch failed: HTTP {}", res.status()));
    }
    let data: Value = res.json().await.map_err(|e| e.to_string())?;
    let list = data
        .get("data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(list
        .iter()
        .map(|m| {
            let pricing = m.get("pricing");
            let free = pricing
                .and_then(|p| p.get("prompt"))
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok())
                == Some(0.0)
                && pricing
                    .and_then(|p| p.get("completion"))
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<f64>().ok())
                    == Some(0.0);
            ModelInfo {
                id: m
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                name: m
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                context: m
                    .get("context_length")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                free,
                tools: m
                    .get("supported_parameters")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().any(|x| x.as_str() == Some("tools")))
                    .unwrap_or(false),
            }
        })
        .filter(|m| !m.id.is_empty())
        .collect())
}

#[tauri::command]
pub async fn get_models() -> Result<Vec<ModelInfo>, String> {
    fetch_models().await
}

// =====================================================================
// CIRCUIT 1/2/3 + AGENTS.md + PLAN
// =====================================================================
#[tauri::command]
pub fn get_playbook(state: State<'_, AppState>) -> Value {
    agent::playbook::playbook_summary(&state.store)
}

#[tauri::command]
pub fn get_skills(state: State<'_, AppState>) -> Value {
    json!({ "tools": agent::skills::load_skills(&state.store) })
}

#[tauri::command]
pub fn get_evals(state: State<'_, AppState>) -> Value {
    agent::evals::eval_summary(&state.store)
}

#[tauri::command]
pub fn get_agents_rules(state: State<'_, AppState>) -> Value {
    json!({ "content": state.store.read_agents_rules().unwrap_or_default() })
}

#[tauri::command]
pub fn set_agents_rules(state: State<'_, AppState>, content: String) -> Result<Value, String> {
    state.store.write_agents_rules(&content).map_err(err_msg)?;
    Ok(json!({ "content": state.store.read_agents_rules().unwrap_or_default() }))
}

#[tauri::command]
pub fn get_plan(state: State<'_, AppState>) -> Value {
    match state.store.load_plan() {
        Some(p) => serde_json::to_value(p).unwrap_or(Value::Null),
        None => Value::Null,
    }
}

/// ผู้ใช้กด "อนุมัติแผน" → คืนแผนที่ sanitize แล้วให้ UI ส่งกลับมาในคำสั่ง ask ครั้งถัดไป
#[tauri::command]
pub fn approve_plan(state: State<'_, AppState>) -> Result<Value, String> {
    let plan = state
        .store
        .load_plan()
        .ok_or_else(|| "ไม่พบแผนที่รออนุมัติ".to_string())?;
    Ok(json!({
        "title": plan.title,
        "steps": plan.steps.iter().map(|s| json!({ "text": s.text, "done": s.done })).collect::<Vec<_>>()
    }))
}

// =====================================================================
// WORKSPACE + FILE TREE
// =====================================================================
#[tauri::command]
pub fn get_workspaces(state: State<'_, AppState>) -> Vec<Workspace> {
    ws_mod::load_workspaces(&state.store)
}

#[tauri::command]
pub fn add_workspace(state: State<'_, AppState>, dir: String) -> Result<Workspace, String> {
    ws_mod::add_workspace(&state.store, &dir, None).map_err(err_msg)
}

#[tauri::command]
pub fn remove_workspace(state: State<'_, AppState>, id: String) -> Result<(), String> {
    ws_mod::remove_workspace(&state.store, &id).map_err(err_msg)
}

fn ws_root_dir(state: &AppState, ws: &str) -> Result<PathBuf, String> {
    let list = ws_mod::load_workspaces(&state.store);
    let w = ws_mod::find_ws(&list, ws).ok_or_else(|| "ไม่พบพื้นที่ทำงานนี้".to_string())?;
    Ok(PathBuf::from(&w.dir))
}

#[tauri::command]
pub fn list_tree(state: State<'_, AppState>, ws: String, path: String) -> Result<Value, String> {
    let root = ws_root_dir(&state, &ws)?;
    let target = if path.is_empty() {
        root.clone()
    } else {
        safe_path_in_root(&root, &path).map_err(err_msg)?
    };
    let entries = ws_mod::list_dir(&target).map_err(err_msg)?;
    Ok(json!({
        "path": path,
        "entries": entries.iter().map(|(n, d, s)| json!({ "name": n, "dir": d, "size": s })).collect::<Vec<_>>()
    }))
}

#[tauri::command]
pub fn read_file(state: State<'_, AppState>, ws: String, path: String) -> Result<Value, String> {
    let root = ws_root_dir(&state, &ws)?;
    let abs = safe_path_in_root(&root, &path).map_err(err_msg)?;
    let content = std::fs::read_to_string(&abs).map_err(err_msg)?;
    Ok(json!({ "content": content }))
}

#[tauri::command]
pub fn write_file(
    state: State<'_, AppState>,
    ws: String,
    path: String,
    content: String,
) -> Result<Value, String> {
    let root = ws_root_dir(&state, &ws)?;
    let abs = safe_path_in_root(&root, &path).map_err(err_msg)?;
    std::fs::write(&abs, content).map_err(err_msg)?;
    Ok(json!({ "ok": true }))
}

// =====================================================================
// GIT WORKTREE
// =====================================================================
#[tauri::command]
pub fn list_worktrees(state: State<'_, AppState>, ws: String) -> Result<Value, String> {
    let root = ws_root_dir(&state, &ws)?;
    let list = ws_mod::list_worktrees(&root).map_err(err_msg)?;
    Ok(json!({ "worktrees": list }))
}

#[tauri::command]
pub fn create_worktree(
    state: State<'_, AppState>,
    ws: String,
    target: String,
    branch: String,
) -> Result<Value, String> {
    let root = ws_root_dir(&state, &ws)?;
    let target_path = PathBuf::from(&target);
    ws_mod::create_worktree(&root, &target_path, &branch).map_err(err_msg)?;
    // ลงทะเบียนเป็น workspace ให้เลือกใช้ได้ทันที
    let _ = ws_mod::add_workspace(&state.store, &target, None);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn remove_worktree(
    state: State<'_, AppState>,
    ws: String,
    target: String,
) -> Result<Value, String> {
    let root = ws_root_dir(&state, &ws)?;
    let target_path = PathBuf::from(&target);
    ws_mod::remove_worktree(&root, &target_path).map_err(err_msg)?;
    Ok(json!({ "ok": true }))
}

// =====================================================================
// CHECKPOINTS — diff / restore
// =====================================================================
#[tauri::command]
pub fn get_checkpoints(state: State<'_, AppState>) -> Value {
    let list = agent::checkpoint::load_ckpts(&state.store);
    json!(list
        .iter()
        .map(|c| json!({
            "id": c.id, "ts": c.ts, "runId": c.run_id, "kind": c.kind,
            "root": c.root, "fileCount": c.files.len()
        }))
        .collect::<Vec<_>>())
}

#[tauri::command]
pub fn diff_checkpoint(state: State<'_, AppState>, id: String) -> Result<Value, String> {
    let files = agent::checkpoint::diff_checkpoint(&state.store, &id).map_err(err_msg)?;
    Ok(json!({
        "id": id,
        "files": files.iter().map(|(rel, lines)| json!({
            "rel": rel,
            "diff": lines.iter().map(|l| json!({ "t": l.t, "text": l.text })).collect::<Vec<_>>()
        })).collect::<Vec<_>>()
    }))
}

#[tauri::command]
pub fn restore_checkpoint(state: State<'_, AppState>, id: String) -> Result<Value, String> {
    let restored = agent::checkpoint::restore_checkpoint(&state.store, &id).map_err(err_msg)?;
    Ok(json!({ "restored": restored }))
}

// =====================================================================
// AUTH
// =====================================================================
#[tauri::command]
pub fn login(state: State<'_, AppState>, ident: String, password: String) -> Result<Value, String> {
    state.login_guard.check(&ident).map_err(err_msg)?;
    let users = state.store.load_users();
    let user = auth::find_user(&users, &ident).ok_or_else(|| {
        state.login_guard.fail(&ident);
        AppError::BadCredentials.to_string()
    })?;
    if !auth::verify_password(&password, &user.salt, &user.hash) {
        state.login_guard.fail(&ident);
        return Err(AppError::BadCredentials.to_string());
    }
    state.login_guard.reset(&ident);
    let sid = state.sessions.create(&user);
    state.sessions.persist(&state.store);
    Ok(json!({
        "sid": sid,
        "user": { "name": user.name, "email": user.email, "role": user.role }
    }))
}

#[tauri::command]
pub fn register(
    state: State<'_, AppState>,
    name: String,
    password: String,
    email: Option<String>,
) -> Result<Value, String> {
    if password.chars().count() < 6 {
        return Err("รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร".into());
    }
    if !email.as_deref().unwrap_or("").is_empty() && !auth::valid_email(email.as_deref().unwrap()) {
        return Err("อีเมลไม่ถูกต้อง".into());
    }
    let mut users = state.store.load_users();
    if auth::find_user(&users, &name).is_some() {
        return Err("ชื่อผู้ใช้นี้ถูกใช้แล้ว".into());
    }
    // คนแรกเป็น admin
    let role = if users.is_empty() { "admin" } else { "member" };
    let user =
        auth::make_user(&name, &password, role, email.as_deref().unwrap_or("")).map_err(err_msg)?;
    users.push(user.clone());
    state.store.save_users(&users).map_err(err_msg)?;
    let sid = state.sessions.create(&user);
    state.sessions.persist(&state.store);
    Ok(json!({
        "sid": sid,
        "user": { "name": user.name, "email": user.email, "role": user.role }
    }))
}

#[tauri::command]
pub fn logout(state: State<'_, AppState>, sid: Option<String>) -> Result<(), String> {
    if let Some(s) = sid {
        state.sessions.destroy(&s);
    }
    state.sessions.persist(&state.store);
    Ok(())
}

#[tauri::command]
pub fn whoami(state: State<'_, AppState>, sid: Option<String>) -> Value {
    match state.current_user(sid.as_deref()) {
        Some(u) => json!({
            "name": u.name, "email": u.email, "role": u.role,
            "hasKey": !u.or_key.is_empty(),
            "keyTail": if u.or_key.len() >= 4 { &u.or_key[u.or_key.len() - 4..] } else { "" }
        }),
        None => Value::Null,
    }
}

#[tauri::command]
pub fn update_profile(
    state: State<'_, AppState>,
    sid: Option<String>,
    name: Option<String>,
    email: Option<String>,
) -> Result<Value, String> {
    let Some(sid) = sid else {
        return Err("ต้องเข้าสู่ระบบก่อน".into());
    };
    let Some(mut user) = state.current_user(Some(&sid)) else {
        return Err("ต้องเข้าสู่ระบบก่อน".into());
    };
    let mut users = state.store.load_users();
    if let Some(n) = name {
        let n = n.trim().chars().take(30).collect::<String>();
        if !n.is_empty() {
            user.name = n;
        }
    }
    if let Some(e) = email {
        if !e.is_empty() && !auth::valid_email(&e) {
            return Err("อีเมลไม่ถูกต้อง".into());
        }
        user.email = e.trim().to_lowercase();
    }
    if let Some(u) = users.iter_mut().find(|u| u.id == user.id) {
        *u = user.clone();
    }
    state.store.save_users(&users).map_err(err_msg)?;
    Ok(json!({ "name": user.name, "email": user.email }))
}

#[tauri::command]
pub fn change_password(
    state: State<'_, AppState>,
    sid: Option<String>,
    old: String,
    next: String,
) -> Result<(), String> {
    let Some(sid) = sid else {
        return Err("ต้องเข้าสู่ระบบก่อน".into());
    };
    let Some(user) = state.current_user(Some(&sid)) else {
        return Err("ต้องเข้าสู่ระบบก่อน".into());
    };
    if next.chars().count() < 6 {
        return Err("รหัสผ่านใหม่ต้องยาวอย่างน้อย 6 ตัวอักษร".into());
    }
    if !auth::verify_password(&old, &user.salt, &user.hash) {
        return Err("รหัสผ่านเดิมไม่ถูกต้อง".into());
    }
    let mut users = state.store.load_users();
    if let Some(u) = users.iter_mut().find(|u| u.id == user.id) {
        u.salt = hex::encode(rand::random::<[u8; 16]>());
        u.hash = auth::hash_password(&next, &u.salt).map_err(err_msg)?;
    }
    state.store.save_users(&users).map_err(err_msg)?;
    Ok(())
}

#[tauri::command]
pub fn set_api_key(
    state: State<'_, AppState>,
    sid: Option<String>,
    or_key: String,
) -> Result<(), String> {
    let Some(sid) = sid else {
        return Err("ต้องเข้าสู่ระบบก่อน".into());
    };
    let Some(user) = state.current_user(Some(&sid)) else {
        return Err("ต้องเข้าสู่ระบบก่อน".into());
    };
    let key = or_key.trim().to_string();
    if !key.is_empty() && !key.starts_with("sk-") {
        return Err("รูปแบบ key ไม่ถูกต้อง (ควรขึ้นต้นด้วย sk-)".into());
    }
    let mut users = state.store.load_users();
    if let Some(u) = users.iter_mut().find(|u| u.id == user.id) {
        u.or_key = key;
    }
    state.store.save_users(&users).map_err(err_msg)?;
    Ok(())
}

#[tauri::command]
pub fn get_api_key_info(state: State<'_, AppState>, sid: Option<String>) -> Value {
    let user = state.current_user(sid.as_deref());
    let server_key = config::load_api_key(None);
    json!({
        "hasUserKey": user.as_ref().map(|u| !u.or_key.is_empty()).unwrap_or(false),
        "userKeyTail": user.as_ref().map(|u| if u.or_key.len() >= 4 { u.or_key[u.or_key.len()-4..].to_string() } else { String::new() }).unwrap_or_default(),
        "hasServerKey": server_key.is_some(),
        "serverKeyTail": server_key.map(|k| if k.len() >= 4 { k[k.len()-4..].to_string() } else { String::new() }).unwrap_or_default(),
    })
}

#[tauri::command]
pub fn list_users(state: State<'_, AppState>) -> Value {
    let users = state.store.load_users();
    json!(users
        .iter()
        .map(|u| json!({
            "id": u.id, "name": u.name, "email": u.email, "role": u.role,
            "hasKey": !u.or_key.is_empty(), "created": u.created
        }))
        .collect::<Vec<_>>())
}

#[tauri::command]
pub fn add_user(
    state: State<'_, AppState>,
    name: String,
    password: String,
    role: String,
    email: Option<String>,
) -> Result<Value, String> {
    if password.chars().count() < 6 {
        return Err("รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร".into());
    }
    let mut users = state.store.load_users();
    if auth::find_user(&users, &name).is_some() {
        return Err("ชื่อผู้ใช้นี้ถูกใช้แล้ว".into());
    }
    let user = auth::make_user(
        &name,
        &password,
        if role == "admin" { "admin" } else { "member" },
        email.as_deref().unwrap_or(""),
    )
    .map_err(err_msg)?;
    users.push(user.clone());
    state.store.save_users(&users).map_err(err_msg)?;
    Ok(json!({ "id": user.id, "name": user.name, "role": user.role }))
}

#[tauri::command]
pub fn remove_user(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut users = state.store.load_users();
    let before = users.len();
    users.retain(|u| u.id != id);
    if users.len() == before {
        return Err("ไม่พบผู้ใช้".into());
    }
    state.store.save_users(&users).map_err(err_msg)?;
    Ok(())
}

// =====================================================================
// ช่วยเหลือ
// =====================================================================
#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> Value {
    json!({
        "dataDir": state.config.read().data_dir.to_string_lossy(),
        "today": today(),
        "model": state.config.read().model,
        "authOff": config::auth_off(),
    })
}
