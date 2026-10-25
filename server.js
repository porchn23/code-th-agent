/**
 * server.js — Web UI สำหรับ Research Agent (zero dependency)
 * รัน: node server.js  แล้วเปิดเบราว์เซอร์ http://localhost:8787
 *
 * Endpoint:
 *   GET  /          → หน้า ui.html
 *   POST /api/ask   → SSE stream: {type:"log"|"answer"|"error", data}
 *
 * แนวคิด: อย่าเขียน agent ใหม่ — ทำ "หน้าบ้าน" ที่เอา agentLoop ตัวเดิมมาใช้
 * log ทุก step ของ agent ถูก "ดัก" ผ่าน console.log แล้ว stream ไปหน้าเว็บสดๆ
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { safePathInRoot } = require("./security-guards.js");
const { readWorkspaceFile, writeWorkspaceFile } = require("./workspace-files.js");
const { CONFIG, agentLoop, getApiKey, playbookSummary, evalSummary, getTools, loadSkills, loadAgentsRules, AGENTS_FILE, loadPlan, loadCkpts, restoreCheckpoint, diffCheckpoint } = require("./research-agent.js");

const PORT = Number(process.env.AGENT_PORT) || 8787;
const ANSI_RE = /\x1b\[[0-9;]*m/g; // ลบสี ANSI ก่อนส่งไปหน้าเว็บ
const DEFAULT_MODEL = CONFIG.model; // เก็บ default ไว้ restore หลังแต่ละ run

// เกราะกัน server ดับกลางทาง: LLM timeout/retry หมด หรือ bug เล็ก ๆ ไม่ควรปิดตัวเอง
// (local tool — อยู่ต่อ + พิมพ์เหตุผลให้เห็น ดีกว่าตายเงียบ ๆ)
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e?.stack || e?.message || e));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", (e && (e.stack || e.message)) || e));

// ---- รายการ models จาก OpenRouter (public endpoint, ไม่ต้อง key) + cache 10 นาที ----
let modelCache = null;
async function getModelList() {
  if (modelCache && Date.now() - modelCache.t < 10 * 60 * 1000) return modelCache.list;
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`Model list fetch failed: HTTP ${res.status}`);
  const { data } = await res.json();
  const list = data.map((m) => ({
    id: m.id,
    name: m.name,
    context: m.context_length,
    free: m.pricing && parseFloat(m.pricing.prompt) === 0 && parseFloat(m.pricing.completion) === 0,
    tools: (m.supported_parameters || []).includes("tools"), // agent ต้องการ function calling
  }));
  modelCache = { t: Date.now(), list };
  return list;
}

// โหลด key ตั้งแต่ boot (ไฟล์ .openrouter_key ต้องมีอยู่แล้วจากการรัน CLI ก่อนหน้า)
const keyReady = getApiKey().then((k) => { CONFIG.apiKey = k; console.log(`[ready] key loaded, model = ${CONFIG.model}`); })
  .catch((e) => { console.error("Key setup failed:", e.message); process.exit(1); });

let running = false; // กันวิ่งแข่งกันเอง (1 task ต่อ 1 process ชั่วคราว)
let queuedItem = null; // คิวรอลึก 1 — แทนการ 429 ทันที (งานถัดไปนั่งรอ run ปัจจุบัน)

// ===============================================================
// ระบบสมาชิก (v16) — ความปลอดภัยด้านข้อมูลและความเป็นส่วนตัว
// zero-dep: scrypt hash (node:crypto) + session cookie HttpOnly (ในหน่วยความจำ)
// ต่างชื่อ = แยกบัญชี; รหัส hash เก็บใน agent_users.json (gitignored เสมอ)
// ===============================================================
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const USERS_FILE = process.env.AGENT_USERS_FILE || path.join(__dirname, "agent_users.json");
const WS_FILE = process.env.AGENT_WORKSPACES_FILE || path.join(__dirname, "agent_workspaces.json");
const MEMBER_WS_ROOT = path.resolve(process.env.AGENT_WORKSPACE_ROOT || path.join(__dirname, "workspaces"));
const authOff = () => process.env.AGENT_NO_AUTH === "1"; // สวิตช์ปิด (ใช้ในเทสเท่านั้น)

function loadJson(file, fb) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fb; } }
function saveJson(file, v) { fs.writeFileSync(file, JSON.stringify(v, null, 2)); }

// ---- users ----
function loadUsers() { const u = loadJson(USERS_FILE, []); return Array.isArray(u) ? u : []; }
const hashPassword = (pw, salt) => crypto.scryptSync(String(pw), String(salt), 64).toString("hex");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function makeUser(name, password, role, email) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { id: "u-" + crypto.randomBytes(4).toString("hex"), name: String(name).trim().slice(0, 30),
    email: email ? String(email).trim().toLowerCase() : "", role: role === "admin" ? "admin" : "member", salt, hash: hashPassword(password, salt),
    orKey: "", created: Date.now() };
}
function findUser(name) { return loadUsers().find((u) => u.name === name) || null; }

// ---- sessions (เก็บต่อเนื่องลงไฟล์ — restart server แล้ว login ไม่หลุด) ----
const SESSIONS_FILE = process.env.AGENT_SESSIONS_FILE || path.join(__dirname, "agent_sessions.json");
const sessions = new Map(); // sid → { user: {name,email,role}, exp }
const SESSION_TTL = 7 * 24 * 3600 * 1000;
function persistSessions() {
  try {
    const now = Date.now();
    const obj = {};
    for (const [sid, s] of sessions) if (s.exp > now) obj[sid] = s;
    saveJson(SESSIONS_FILE, obj);
  } catch { /* เขียนไม่ได้ → session memory-only */ }
}
(function loadSessions() { // บูต: กู้ session เก่า + ตัดของหมดอายุทิ้ง
  const saved = loadJson(SESSIONS_FILE, null);
  if (saved && typeof saved === "object") for (const [sid, s] of Object.entries(saved)) if (s?.exp > Date.now()) sessions.set(sid, s);
})();
const failCounts = new Map(); // กันเดารหัส: ล้ม 5 ครั้ง → ล็อกชื่อนั้น 30 วิ
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const sid = parseCookies(req).agent_ses;
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.exp) { sessions.delete(sid); return null; }
  return s.user;
}

// ---- workspaces (พื้นที่การทำงาน) — seed แรก = โฟลเดอร์ตัว agent เอง ----
const rootWsId = "ws-root";
function wsIdOf(dir) { return "ws-" + crypto.createHash("md5").update(path.resolve(dir)).digest("hex").slice(0, 8); }
function loadWorkspaces() {
  const list = loadJson(WS_FILE, null);
  if (Array.isArray(list) && list.length) return list;
  const seed = [{ id: rootWsId, name: path.basename(__dirname), dir: __dirname }];
  try { saveJson(WS_FILE, seed); } catch {}
  return seed;
}
function saveWorkspaces(list) { saveJson(WS_FILE, list); }
// ws จาก id ที่ client ส่งมา — ไม่จำ / ไม่รู้จัก → ใช้ workspace หลัก (กัน path มั่วจาก client)
function findWs(id) {
  const list = loadWorkspaces();
  return list.find((w) => w.id === id) || list.find((w) => w.id === rootWsId) || list[0];
}
function workspaceById(id) {
  return loadWorkspaces().find((w) => w.id === id) || null;
}
function canAccessWorkspace(ws, user) {
  if (!ws) return false;
  if (authOff()) return true;
  if (!user) return false;
  return user.role === "admin" || ws.id === rootWsId || !ws.owner || ws.owner === user.name;
}
function canManageWorkspace(ws, user) {
  return !!ws && (authOff() || (!!user && (user.role === "admin" || ws.owner === user.name)));
}
function authorizedWorkspace(id, user) {
  const ws = workspaceById(id) || (!id ? workspaceById(rootWsId) : null);
  return canAccessWorkspace(ws, user) ? ws : null;
}
function safeWorkspacePath(root, rel) {
  return safePathInRoot(root, rel);
}

// ---- git worktree — สร้าง/ลบ พื้นที่งานแยกข้างโปรเจค (repo เดียวกัน หลายกิ่งขนานกัน) ----
let gitExe = null;
function findGit() {
  if (gitExe) return gitExe;
  for (const g of ["git", "C:\\Program Files\\Git\\cmd\\git.exe"]) {
    try { execFileSync(g, ["--version"], { stdio: "ignore", windowsHide: true }); gitExe = g; return g; } catch {}
  }
  return null;
}
function runGit(args, cwd) {
  const g = findGit();
  if (!g) throw new Error("git is not available on this machine");
  try {
    return { code: 0, out: execFileSync(g, args, { cwd, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024 }) };
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : 1, out: String(e.stdout || ""), err: String(e.stderr || e.message || "") };
  }
}
function listWorktrees(dir) {
  const r = runGit(["worktree", "list", "--porcelain"], dir);
  if (r.code !== 0) { if (/not a git repository/i.test(r.err || "")) throw new Error("โฟลเดอร์นี้ไม่ใช่ git repository — worktree ใช้ได้เฉพาะโปรเจคที่เป็น git"); throw new Error((r.err || "git worktree failed").trim().slice(0, 300)); }
  const out = [];
  let cur = null;
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) { if (cur) out.push(cur); cur = { path: line.slice(9) }; }
    else if (cur?.head && line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "bare" || line === "detached") { if (cur) cur.detached = line === "detached"; }
  }
  if (cur) out.push(cur);
  return out;
}

// ---- tree/file explorer (ดูโครงสร้างโปรเจค) ----
const TREE_SKIP = /^(node_modules|\.git|agent_checkpoints|\.agent_memory|agent_users|agent_workspaces)$/;
function safeTreePath(wsDir, rel) {
  return safeWorkspacePath(wsDir, rel);
}


// รันงาน 1 ชิ้นต่อ response — ใช้ทั้งเคส "ว่างรับเลย" และ "ดึงจากคิว" เมื่อ run ก่อนหน้าจบ
async function runTask(parsed, res) {
  running = true;
  const { task, model, temp, maxSteps, history, mode } = parsed;
  // Tier 1 plan mode: planMode = รอบวางแผน (ห้ามลงมือ) / approvedPlan = แผนที่ผู้ใช้กดอนุมัติแล้ว
  // sanitize approvedPlan: ยอมรับเฉพาะรูป {title, steps:[{text,done}]} ที่กลั่นแล้ว
  let planTL = !!parsed.planMode;
  let approvedPlan = null;
  if (parsed.approvedPlan && Array.isArray(parsed.approvedPlan.steps)) {
    const steps = parsed.approvedPlan.steps
      .filter((s) => s && typeof s.text === "string")
      .slice(0, 10)
      .map((s) => ({ text: s.text.slice(0, 200), done: !!s.done }));
    if (steps.length) approvedPlan = { title: String(parsed.approvedPlan.title || "").slice(0, 120), steps };
    planTL = false; // แผนผ่านการอนุมัติแล้ว — รอบนี้ลงมือทำจริง
  }
  const modeN = mode === "code" ? "code" : "research"; // กันค่าที่ไม่รู้จัก
  // งานจากคิว: header ส่งไปแล้วตอนส่ง event "queued" — ห้าม writeHead ซ้ำ (throw = ค้าง running)
  if (!res.headersSent) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  }
  const send = (type, data) => {
    try { res.write(`data: ${JSON.stringify({ type, data })}\n\n`); } catch {}
  };
  let serverKey = null; // v17: key ของเจ้าของเครื่อง (mock ไว้คืนใน finally ถ้า run นี้ใช้ key สมาชิก)
  // ปุ่ม Stop ของ UI → abort → ยกเลิก LLM call + tool ที่กำลังวิ่งจริง
  // (ใช้ response ไม่ใช่ request — req 'close' ไฟร์ตอน body อ่านจบ ไม่ใช่ตอนจบงาน)
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try {
    await keyReady;
    // v17 per-user key: สมาชิกที่ import key เอง → run ของเขาใช้ key นั้น (ไม่เผื่อเหมือนกันกับเจ้าของเครื่อง)
    serverKey = CONFIG.apiKey;
    const u = parsed._user && findUser(parsed._user.name);
    if (u?.orKey) {
      CONFIG.apiKey = u.orKey;
      send("log", `🔑 ใช้ key ของ ${u.name} (…${u.orKey.slice(-4)}) สำหรับ run นี้`);
    }
    // เลือก model: ถ้า UI ส่งมา ต้อง list ของจริงมีและรองรับ tools
    // (validate จาก data ไม่รับคำมั่นจาก client — แนวทางเดียวกับทุก input ของ agent)
    let useModel = DEFAULT_MODEL;
    if (model) {
      const list = await getModelList();
      const found = list.find((m) => m.id === model && m.tools);
      if (!found) throw new Error(`Model "${model}" not found or doesn't support tool calling`);
      useModel = model;
    }
    CONFIG.model = useModel;
    // settings จาก UI — validate ทุกค่า ไม่เอาหม้อแห้งจาก client
    const useTemp = typeof temp === "number" && temp >= 0 && temp <= 2 ? temp : null;
    const useSteps = Number.isInteger(maxSteps) ? Math.min(Math.max(maxSteps, 4), 24) : undefined;
    // history: Q&A ย้อนหลังของแชตเดียวกัน → agent จำบริบทได้ cross-turn
    // (sanitize: role/content กลั่นมาแล้วตัดสั้น กล่องเก่าถูก agent หั่นอีกทีเอง)
    const cleanHistory = Array.isArray(history)
      ? history
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .slice(-8)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }))
      : [];
    const answer = await agentLoop(task.trim(), {
      depth: 0,
      temp: useTemp,
      maxSteps: useSteps != null ? useSteps : (modeN === "code" ? 24 : undefined),
      mode: modeN, // "research" (default) | "code" (เพิ่ม run_command/file_edit/file_grep + verification gate)
      tools: getTools(modeN, { save: planTL, done: !!approvedPlan, trusted: authOff() || u?.role === "admin" }),
      trusted: authOff() || u?.role === "admin",
      history: cleanHistory,
      signal: controller.signal,
      planMode: planTL,
      approvedPlan,
      // v16 workspace: run นี้ทำงานกับพื้นที่ทำงานที่เลือก (tools ไฟล์/run_command หมายถึงโฟลเดอร์นั้น)
      root: findWs(parsed.ws)?.dir || __dirname,
      onRun: (r) => send("run", r), // ผลการรันจริง (🧪 run panel ใน UI)
      // log ของ agent → ส่งไปหน้าเว็บสด ๆ (ไม่ patch console.log แบบ global —
      // ถ้า patch แล้ว request ที่ถูก abort จะมา restore ทับ patch ของ request ที่วิ่งอยู่)
      onLog: (line) => send("log", line.replace(ANSI_RE, "").trim()),
      // streaming คำตอบ: delta สด → UI (null = ล้างเมื่อโมเดลสลับไป tool call)
      onDelta: (t) => (t === null ? send("answer-reset") : send("answer-delta", t)),
      // Tier 1 plan mode: save_plan/plan_done → event "plan" สด ๆ ไปหน้าเว็บ (การ์ดแผน + ปุ่มอนุมัติ)
      onPlan: (p) => {
        try { send("plan", { id: p.id, ts: p.ts, title: p.title, steps: p.steps }); } catch {}
      },
    });
    send("answer", answer);
  } catch (e) {
    // ถูกยกเลิกเอง (ผู้ใช้กด Stop) → ไม่ต้องส่ง error ให้ UI เห็น
    if (!controller.signal.aborted) send("error", e.message || String(e));
  } finally {
    CONFIG.model = DEFAULT_MODEL; // restore — run ถัดไปกลับไปใช้ default
    try { if (serverKey !== null) CONFIG.apiKey = serverKey; } catch {} // v17: คืน key เจ้าของเครื่อง (ถ้า run นี้ใช้ key ของสมาชิก)
    running = false;
    try { if (!res.writableEnded) res.end(); } catch {}
    // คิว: มีงานรออยู่ (และ client ยังต่ออยู่) → เริ่มงานนั้นต่อทันที
    const nxt = queuedItem;
    if (nxt && !nxt.res.writableEnded) { queuedItem = null; try { await runTask(nxt.parsed, nxt.res); } catch { /* ห้ามพังหลัง res.end */ } }
    else { queuedItem = null; if (nxt) { try { nxt.res.end(); } catch {} } }
  }
}

const server = http.createServer(async (req, res) => {
  // ---- หน้าเว็บ (public — ทุก /api/* ต้องมี session ยกเว้น open list ด้านล่าง) ----
  if (req.method === "GET" && (req.url === "/" || req.url === "/ui.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "ui.html")));
  }

  // ---- Auth guard: ทุก /api/* ต้อง login (ยกเว้น open list + /api/me) ----
  // AGENT_NO_AUTH=1 → เข้าได้หมด (ใช้ใน tests + local trust mode)
  const OPEN_PATHS = ["/api/login", "/api/register", "/api/setup", "/api/logout", "/api/me", "/api/models"];
  if (req.url.startsWith("/api/") && !authOff()) {
    const open = OPEN_PATHS.find((p) => req.url === p || req.url.startsWith(p + "?"));
    if (!open && !currentUser(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Unauthenticated — please login" }));
    }
  }

  // ---- ตัวเลือก model สำหรับหน้า UI ----
  if (req.method === "GET" && req.url === "/api/models") {
    try {
      const list = await getModelList();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ default: DEFAULT_MODEL, models: list }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ---- Circuit 1: playbook ที่ agent เรียนรู้จาก run ที่ล้มเหลว ----
  if (req.method === "GET" && req.url === "/api/playbook") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(playbookSummary()));
  }

  // ---- Circuit 2: tool library (custom tools ที่ agent สร้างเอง) ----
  if (req.method === "GET" && req.url === "/api/skills") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ tools: loadSkills() }));
  }

  // ---- Circuit 3: eval checklists ที่ agent เก็บจากงานที่สำเร็จ ----
  if (req.method === "GET" && req.url === "/api/evals") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(evalSummary()));
  }

  // ---- Tier 1: AGENTS.md (กฎของผู้ใช้), แผน, checkpoints ----
  if (req.method === "GET" && req.url === "/api/agents") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ content: loadAgentsRules() }));
  }
  if (req.method === "POST" && req.url === "/api/agents") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 40000) req.destroy(); });
    req.on("end", () => {
      try {
        const { content } = JSON.parse(body);
        if (typeof content !== "string") throw new Error("content required");
        fs.writeFileSync(AGENTS_FILE, content.slice(0, 30000), "utf8"); // cap ~7500 tok
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, bytes: content.slice(0, 30000).length }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === "GET" && req.url === "/api/plan") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(loadPlan()));
  }
  if (req.method === "GET" && req.url === "/api/checkpoints") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      checkpoints: loadCkpts().map(({ id, ts, kind, runId, files }) => ({
        id, ts, kind, runId,
        files: files.map((f) => f.rel),
      })),
    }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/checkpoints/diff?id=")) {
    try {
      const id = decodeURIComponent(req.url.split("id=")[1] || "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(diffCheckpoint(id)));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === "POST" && req.url === "/api/checkpoints/restore") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { id } = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ restored: restoreCheckpoint(String(id)) }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // =====================================================
  // v16: ระบบสมาชิก + พื้นที่ทำงาน + tree/worktrees
  // =====================================================

  // ---- สมาชิก: ผู้ช่วยแบ่ง body พร้อมตัดของใหญ่เกิน ----
  const readBody = (req, maxBytes = 40000) => new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    req.on("data", (c) => {
      if (tooLarge) return;
      body += c;
      if (Buffer.byteLength(body, "utf8") > maxBytes) { tooLarge = true; body = ""; }
    });
    req.on("end", () => {
      if (tooLarge) return reject(new Error("request body too large"));
      try { resolve(JSON.parse(body || "{}")); } catch (e) { reject(e); }
    });
  });
  const jsonOut = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

  // ---- first-run: สร้างบัญชีเจ้าของคนแรก (ใช้ได้ตอน users.length===0 เท่านั้น) ----
  if (req.method === "POST" && req.url === "/api/setup") {
    return readBody(req).then(({ name, password, email }) => {
      if (loadUsers().length) return jsonOut(403, { error: "เซ็ตอัพไปแล้ว — ใช้การ login แทน" });
      name = String(name || "").trim();
      if (name.length < 2) return jsonOut(400, { error: "ชื่อต้องมีอย่างน้อย 2 ตัว" });
      if (String(password || "").length < 6) return jsonOut(400, { error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัว" });
      if (email && !EMAIL_RE.test(String(email))) return jsonOut(400, { error: "รูปแบบอีเมลไม่ถูกต้อง" });
      const users = loadUsers();
      const user = makeUser(name, password, "admin", email);
      saveJson(USERS_FILE, [...users, user]);
      const sid = crypto.randomBytes(24).toString("hex");
      sessions.set(sid, { user: { name: user.name, email: user.email, role: user.role }, exp: Date.now() + SESSION_TTL });
      persistSessions();
      res.setHeader("Set-Cookie", `agent_ses=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
      return jsonOut(200, { user: { name: user.name, email: user.email, role: user.role } });
    }).catch(() => jsonOut(400, { error: "invalid body" }));
  }

  // ---- login (มี rate-limit: พลาด 5 ครั้ง → ล็อค 30 วิ) ----
  if (req.method === "POST" && req.url === "/api/login") {
    return readBody(req).then(({ name: ldname, password }) => {
      const who = "local"; // ผู้ใช้ local — อนาคตอาจร่วมกับ x-forwarded-for จาก reverse proxy
      const pre = failCounts.get(who) || { n: 0, until: 0 };
      if (pre.until > Date.now()) return jsonOut(429, { error: "ลองครั้งเดียวพัก 30 วินาที" });
      const users = loadUsers();
      const user = users.find((u) => u.name === String(ldname || "")) || users.find((u) => u.email && u.email === String(ldname || "").toLowerCase());
      const ok = user && (() => {
        try {
          return crypto.timingSafeEqual(Buffer.from(user.hash, "hex"), Buffer.from(hashPassword(String(password || ""), user.salt), "hex"));
        } catch { return false; }
      })();
      if (!ok) {
        failCounts.set(who, pre.n + 1 >= 5 ? { n: 0, until: Date.now() + 30000 } : { n: pre.n + 1, until: 0 });
        return jsonOut(401, { error: "ชื่อ/อีเมล หรือรหัสผ่านไม่ถูกต้อง" });
      }
      failCounts.delete(who);
      const sid = crypto.randomBytes(24).toString("hex");
      sessions.set(sid, { user: { name: user.name, email: user.email, role: user.role }, exp: Date.now() + SESSION_TTL });
      persistSessions();
      res.setHeader("Set-Cookie", `agent_ses=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
      return jsonOut(200, { user: { name: user.name, email: user.email, role: user.role } });
    }).catch(() => jsonOut(400, { error: "invalid body" }));
  }

  // ---- สมัครสมาชิกเอง (v17): ได้ role member ทันที ----
  if (req.method === "POST" && req.url === "/api/register") {
    return readBody(req).then(({ name, email, password }) => {
      name = String(name || "").trim();
      email = String(email || "").trim().toLowerCase();
      if (name.length < 2) return jsonOut(400, { error: "ชื่อต้องมีอย่างน้อย 2 ตัว" });
      if (!EMAIL_RE.test(email)) return jsonOut(400, { error: "รูปแบบอีเมลไม่ถูกต้อง" });
      if (String(password || "").length < 6) return jsonOut(400, { error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัว" });
      const users = loadUsers();
      if (users.length >= 20) return jsonOut(400, { error: "สมาชิกเต็ม (สูงสุด 20)" });
      if (users.some((u) => u.name === name)) return jsonOut(400, { error: "ชื่อนี้ถูกใช้แล้ว" });
      if (users.some((u) => u.email === email)) return jsonOut(400, { error: "อีเมลนี้ถูกใช้แล้ว" });
      const user = makeUser(name, password, "member", email);
      saveJson(USERS_FILE, [...users, user]);
      const sid = crypto.randomBytes(24).toString("hex"); // auto-login
      sessions.set(sid, { user: { name: user.name, email: user.email, role: user.role }, exp: Date.now() + SESSION_TTL });
      persistSessions();
      res.setHeader("Set-Cookie", `agent_ses=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
      return jsonOut(200, { user: { name: user.name, email: user.email, role: user.role } });
    }).catch(() => jsonOut(400, { error: "invalid body" }));
  }

  // ---- logout ----
  if (req.method === "POST" && req.url === "/api/logout") {
    const sid = parseCookies(req).agent_ses;
    if (sid) { sessions.delete(sid); persistSessions(); }
    res.setHeader("Set-Cookie", "agent_ses=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
    return jsonOut(200, { ok: true });
  }

  // ---- ตัวตนของผู้ใช้ปัจจุบัน ----
  if (req.method === "GET" && req.url === "/api/me") {
    if (authOff()) return jsonOut(200, { user: { name: "local", email: "", role: "admin" } });
    if (loadUsers().length === 0) return jsonOut(200, { setup: true });
    const cu = currentUser(req);
    return cu ? jsonOut(200, { user: cu }) : jsonOut(401, { error: "Unauthenticated" });
  }

  // ---- โปรไฟล์ + รหัสผ่าน + key ส่วนตัว (v17) ----
  if (req.method === "GET" && req.url === "/api/profile") {
    const cu = currentUser(req);
    if (!cu) return jsonOut(401, { error: "Unauthenticated" });
    return jsonOut(200, { name: cu.name, email: cu.email || "", role: cu.role });
  }
  if (req.method === "POST" && req.url === "/api/profile") {
    return readBody(req).then(({ name, email }) => {
      const cu = currentUser(req);
      if (!cu) return jsonOut(401, { error: "Unauthenticated" });
      const users = loadUsers();
      const me = users.find((u) => u.name === cu.name);
      if (!me) return jsonOut(404, { error: "ไม่พบบัญชีนี้แล้ว" });
      const nn = name !== undefined ? String(name).trim() : cu.name;
      const ne = email !== undefined ? String(email).trim().toLowerCase() : (me.email || "");
      if (nn.length < 2) return jsonOut(400, { error: "ชื่อต้องมีอย่างน้อย 2 ตัว" });
      if (ne && !EMAIL_RE.test(ne)) return jsonOut(400, { error: "รูปแบบอีเมลไม่ถูกต้อง" });
      if (nn !== cu.name && users.some((u) => u.name === nn)) return jsonOut(400, { error: "ชื่อนี้ถูกใช้แล้ว" });
      if (ne && ne !== me.email && users.some((u) => u.email === ne)) return jsonOut(400, { error: "อีเมลนี้ถูกใช้แล้ว" });
      const oldName = me.name;
      me.name = nn; me.email = ne;
      saveJson(USERS_FILE, users);
      if (nn !== oldName) {
        const workspaces = loadWorkspaces();
        let changed = false;
        for (const ws of workspaces) if (ws.owner === oldName) { ws.owner = nn; changed = true; }
        if (changed) saveWorkspaces(workspaces);
      }
      // เปลี่ยนชื่อ → ยก session ให้ตามใหม่ด้วย
      const sid = parseCookies(req).agent_ses;
      if (sid && sessions.has(sid)) sessions.set(sid, { user: { name: nn, email: ne, role: me.role }, exp: sessions.get(sid).exp });
      persistSessions();
      return jsonOut(200, { ok: true, name: nn, email: ne });
    }).catch(() => jsonOut(400, { error: "invalid body" }));
  }
  if (req.method === "POST" && req.url === "/api/password") {
    return readBody(req).then(({ old: oldPw, next }) => {
      const cu = currentUser(req);
      if (!cu) return jsonOut(401, { error: "Unauthenticated" });
      if (String(next || "").length < 6) return jsonOut(400, { error: "รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัว" });
      const users = loadUsers();
      const me = users.find((u) => u.name === cu.name);
      if (!me) return jsonOut(404, { error: "ไม่พบบัญชีนี้แล้ว" });
      let oldOk = false;
      try { oldOk = crypto.timingSafeEqual(Buffer.from(me.hash, "hex"), Buffer.from(hashPassword(String(oldPw || ""), me.salt), "hex")); } catch {}
      if (!oldOk) return jsonOut(401, { error: "รหัสผ่านเดิมไม่ถูกต้อง" });
      me.salt = crypto.randomBytes(16).toString("hex");
      me.hash = hashPassword(String(next), me.salt);
      saveJson(USERS_FILE, users);
      return jsonOut(200, { ok: true });
    }).catch(() => jsonOut(400, { error: "invalid body" }));
  }
  if (req.method === "POST" && req.url === "/api/key") {
    return readBody(req).then(({ orKey }) => {
      const cu = currentUser(req);
      if (!cu) return jsonOut(401, { error: "Unauthenticated" });
      orKey = String(orKey || "").trim();
      if (orKey && !/^sk-or-/.test(orKey)) return jsonOut(400, { error: "รูปแบบ key ไม่ถูก (ต้องขึ้นต้น sk-or-)" });
      if (orKey && orKey.length < 20) return jsonOut(400, { error: "key สั้นเกินไป" });
      const users = loadUsers();
      const me = users.find((u) => u.name === cu.name);
      if (!me) return jsonOut(404, { error: "ไม่พบบัญชีนี้แล้ว" });
      me.orKey = orKey; // เก็บในเครื่องเดียว (ไฟล์ agent_users.json อยู่นอก git) — ไม่เด้งกลับหน้า UI อีก
      saveJson(USERS_FILE, users);
      return jsonOut(200, { ok: true, masked: orKey ? `…${orKey.slice(-4)}` : "" });
    }).catch(() => jsonOut(400, { error: "invalid body" }));
  }
  if (req.method === "GET" && req.url === "/api/key") {
    const cu = currentUser(req);
    if (!cu) return jsonOut(401, { error: "Unauthenticated" });
    const me = findUser(cu.name);
    return jsonOut(200, { set: !!(me?.orKey), masked: me?.orKey ? `…${me.orKey.slice(-4)}` : "" });
  }

  // ---- สมาชิกทั้งหมด (admin เท่านั้น; hash ไม่เด้งออก) ----
  if (req.method === "GET" && req.url === "/api/users") {
    const cu = currentUser(req);
    if (!cu || cu.role !== "admin") return jsonOut(403, { error: "admin เท่านั้น" });
    return jsonOut(200, { users: loadUsers().map(({ id, name, email, role, created }) => ({ id, name, email, role, created })) });
  }
  if (req.method === "POST" && req.url === "/api/users") {
    return readBody(req).then(({ name, password, role }) => {
      const cu = currentUser(req);
      if (!cu || cu.role !== "admin") return jsonOut(403, { error: "admin เท่านั้น" });
      name = String(name || "").trim();
      if (name.length < 2) return jsonOut(400, { error: "ชื่อต้องมีอย่างน้อย 2 ตัว" });
      if (String(password || "").length < 6) return jsonOut(400, { error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัว" });
      if (!["admin", "member"].includes(role)) role = "member";
      const users = loadUsers();
      if (users.length >= 20) return jsonOut(400, { error: "สมาชิกเต็ม (สูงสุด 20)" });
      if (users.some((u) => u.name === name)) return jsonOut(400, { error: "ชื่อนี้ถูกใช้แล้ว" });
      const user = makeUser(name, password, role);
      saveJson(USERS_FILE, [...users, user]);
      return jsonOut(200, { ok: true, user: { id: user.id, name: user.name, role: user.role } });
    }).catch(() => jsonOut(400, { error: "invalid body" }));
  }
  if (req.method === "POST" && req.url === "/api/users/remove") {
    return readBody(req).then(({ id }) => {
      const cu = currentUser(req);
      if (!cu || cu.role !== "admin") return jsonOut(403, { error: "admin เท่านั้น" });
      const users = loadUsers();
      const victim = users.find((u) => u.id === String(id));
      if (!victim) return jsonOut(404, { error: "ไม่พบสมาชิกนี้" });
      if (victim.role === "admin" && users.filter((u) => u.role === "admin").length <= 1) return jsonOut(400, { error: "ต้องเหลือ admin อย่างน้อย 1 คน" });
      saveJson(USERS_FILE, users.filter((u) => u.id !== victim.id));
      return jsonOut(200, { ok: true });
    }).catch(() => jsonOut(400, { error: "invalid body" }));
  }

  // ---- พื้นที่ทำงาน (workspaces — มีเจ้าของตั้งแต่ v17: member เห็นของตัวเอง + ws-root ใช้ร่วม) ----
  if (req.method === "GET" && req.url === "/api/workspaces") {
    const cu = currentUser(req);
    const isAdmin = !cu || cu.role === "admin"; // authOff → ไม่มี cu → เห็นทั้งหมด
    const mine = loadWorkspaces().filter((w) => !w.owner || w.owner === (cu?.name ?? "") || isAdmin || w.id === rootWsId);
    return jsonOut(200, { workspaces: mine });
  }
  if (req.method === "POST" && req.url === "/api/workspaces") {
    return readBody(req).then(({ dir }) => {
      if (!dir || typeof dir !== "string") return jsonOut(400, { error: "dir required" });
      const resolved = path.resolve(dir);
      let st = null;
      try { st = fs.statSync(resolved); } catch {}
      if (!st || !st.isDirectory()) return jsonOut(400, { error: "ไม่พบโฟลเดอร์นี้" });
      const cu = currentUser(req);
      if (cu && cu.role !== "admin") {
        fs.mkdirSync(MEMBER_WS_ROOT, { recursive: true });
        const memberSegment = encodeURIComponent(cu.name);
        const memberRoot = path.resolve(MEMBER_WS_ROOT, memberSegment);
        fs.mkdirSync(memberRoot, { recursive: true });
        try { safeWorkspacePath(MEMBER_WS_ROOT, memberSegment); }
        catch { return jsonOut(403, { error: "โฟลเดอร์ส่วนตัวต้องไม่ชี้ออกนอกพื้นที่ทำงาน" }); }
        const rel = path.relative(memberRoot, resolved);
        if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))
          return jsonOut(403, { error: "สมาชิกเพิ่ม workspace ได้เฉพาะในโฟลเดอร์ส่วนตัวของตน" });
        try { safeWorkspacePath(memberRoot, rel || "."); }
        catch { return jsonOut(403, { error: "workspace ต้องอยู่ภายในโฟลเดอร์ส่วนตัวจริง" }); }
      }
      const list = loadWorkspaces();
      if (list.length >= 20) return jsonOut(400, { error: "พื้นที่ทำงานเต็ม (สูงสุด 20)" });
      if (list.some((w) => w.dir === resolved)) return jsonOut(400, { error: "พื้นที่ทำงานนี้มีอยู่แล้ว" });
      const ws = { id: wsIdOf(resolved), name: path.basename(resolved), dir: resolved, owner: cu ? cu.name : "local" };
      saveJson(WS_FILE, [...list, ws]);
      return jsonOut(200, { ok: true, workspace: ws });
    }).catch(() => jsonOut(400, { error: "invalid body" }));
  }
  if (req.method === "POST" && req.url === "/api/workspaces/remove") {
    return readBody(req).then(({ id }) => {
      if (id === rootWsId) return jsonOut(400, { error: "ลบพื้นที่หลักไม่ได้" });
      const list = loadWorkspaces();
      const victim = list.find((w) => w.id === String(id));
      if (!victim) return jsonOut(404, { error: "ไม่พบพื้นที่ทำงานนี้" });
      const cu = currentUser(req); // authOff/black-box: ไม่มี cu → อนุญาต (โหมด trust)
      if (cu && cu.role !== "admin" && victim.owner && victim.owner !== cu.name) return jsonOut(403, { error: "ลบได้เฉพาะเจ้าของหรือ admin" });
      saveJson(WS_FILE, list.filter((w) => w.id !== String(id)));
      return jsonOut(200, { ok: true });
    }).catch(() => jsonOut(400, { error: "invalid body" }));
  }

  // ---- เลือกโฟลเดอร์โปรเจกต์ (แสดงเฉพาะโฟลเดอร์, admin/local เท่านั้น) ----
  if (req.method === "GET" && req.url.startsWith("/api/directories?")) {
    const user = currentUser(req);
    if (!authOff() && (!user || user.role !== "admin")) return jsonOut(403, { error: "เฉพาะ admin ที่เลือกโฟลเดอร์เครื่องได้" });
    try {
      const qs = new URL(req.url, "http://x");
      const current = path.resolve(qs.searchParams.get("path") || process.cwd());
      if (!fs.statSync(current).isDirectory()) return jsonOut(400, { error: "ที่อยู่นี้ไม่ใช่โฟลเดอร์" });
      const directories = fs.readdirSync(current, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => ({ name: entry.name, path: path.join(current, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = path.dirname(current);
      return jsonOut(200, { current, parent: parent === current ? null : parent, directories });
    } catch (e) { return jsonOut(400, { error: e.message }); }
  }

  // ---- ตัวสำรวจไฟล์ (tree 1 ระดับ + preview ไฟล์ text) ----
  if (req.method === "GET" && req.url.startsWith("/api/tree?")) {
    try {
      const qs = new URL(req.url, "http://x");
      const ws = authorizedWorkspace(qs.searchParams.get("ws"), currentUser(req));
      if (!ws) return jsonOut(404, { error: "ไม่พบพื้นที่ทำงานนี้" });
      const full = safeTreePath(ws.dir, qs.searchParams.get("path") || ""); // abs path แล้ว — ห้าม join ซ้ำ
      const out = [];
      for (const d of fs.readdirSync(full, { withFileTypes: true })) {
        if (d.name.startsWith(".")) continue;
        if (d.isDirectory() && TREE_SKIP.test(d.name)) continue;
        const s = d.isDirectory() ? null : (fs.statSync(path.join(full, d.name)).size || 0);
        out.push({ n: d.name, d: d.isDirectory(), s });
      }
      out.sort((a, b) => (b.d - a.d) || a.n.localeCompare(b.n));
      return jsonOut(200, { items: out });
    } catch (e) { return jsonOut(400, { error: e.message }); }
  }
  if (req.method === "GET" && req.url.startsWith("/api/file?")) {
    try {
      const qs = new URL(req.url, "http://x");
      const ws = authorizedWorkspace(qs.searchParams.get("ws"), currentUser(req));
      if (!ws) return jsonOut(404, { error: "ไม่พบพื้นที่ทำงานนี้" });
      return jsonOut(200, readWorkspaceFile(ws.dir, qs.searchParams.get("path") || ""));
    } catch (e) { return jsonOut(400, { error: e.message }); }
  }
  if (req.method === "PUT" && req.url.startsWith("/api/file?")) {
    return readBody(req, 140000).then(({ content }) => {
      try {
        const qs = new URL(req.url, "http://x");
        const user = currentUser(req);
        const ws = authorizedWorkspace(qs.searchParams.get("ws"), user);
        if (!ws || !canManageWorkspace(ws, user)) return jsonOut(404, { error: "ไม่มีสิทธิ์แก้ไขไฟล์ในพื้นที่นี้" });
        const saved = writeWorkspaceFile(ws.dir, qs.searchParams.get("path") || "", content);
        return jsonOut(200, { ok: true, ...saved });
      } catch (e) { return jsonOut(400, { error: e.message }); }
    }).catch((e) => jsonOut(400, { error: e.message || "invalid body" }));
  }

  // ---- git worktrees: ดู/สร้าง/ลบ (พร้อม sync workspace registry) ----
  if (req.method === "GET" && req.url.startsWith("/api/worktrees?")) {
    const qs = new URL(req.url, "http://x");
    const ws = authorizedWorkspace(qs.searchParams.get("ws"), currentUser(req));
    if (!ws) return jsonOut(404, { error: "ไม่พบพื้นที่ทำงานนี้" });
    try { return jsonOut(200, { worktrees: listWorktrees(ws.dir) }); }
    catch (e) { return jsonOut(400, { error: e.message }); }
  }
  if (req.method === "POST" && req.url === "/api/worktrees/create") {
    return readBody(req).then(async ({ ws: wsId, name }) => {
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(String(name || ""))) return jsonOut(400, { error: "ชื่ออนุญาต a-z 0-9 . _ - ไม่เกิน 40 ตัว" });
      const user = currentUser(req);
      const ws = authorizedWorkspace(wsId, user);
      if (!ws || !canManageWorkspace(ws, user)) return jsonOut(404, { error: "ไม่พบพื้นที่ทำงานนี้" });
      const wcPath = path.join(path.dirname(ws.dir), name);
      if (fs.existsSync(wcPath)) return jsonOut(400, { error: "โฟลเดอร์ปลายทางมีอยู่แล้ว" });
      const r = runGit(["worktree", "add", wcPath, "-b", name], ws.dir);
      if (r.code !== 0) return jsonOut(400, { error: (r.err || r.out).trim().slice(0, 300) });
      const list = loadWorkspaces();
      const resolved = path.resolve(wcPath);
      if (!list.some((w) => w.dir === resolved) && list.length < 20)
        saveJson(WS_FILE, [...list, { id: wsIdOf(resolved), name, dir: resolved, owner: user?.name || null }]);
      return jsonOut(200, { ok: true, path: resolved });
    }).catch(() => jsonOut(400, { error: "invalid body" }));
  }
  if (req.method === "POST" && req.url === "/api/worktrees/remove") {
    return readBody(req).then(async ({ ws: wsId, p }) => {
      const user = currentUser(req);
      const ws = authorizedWorkspace(wsId, user);
      if (!ws || !canManageWorkspace(ws, user)) return jsonOut(404, { error: "ไม่พบพื้นที่ทำงานนี้" });
      const parent = path.dirname(ws.dir);
      const target = path.resolve(String(p || ""));
      if (target !== ws.dir && !target.startsWith(parent + path.sep)) return jsonOut(400, { error: "worktree ต้องอยู่ระดับเดียวกัน" });
      if (!listWorktrees(ws.dir).some((w) => path.resolve(w.path) === target)) return jsonOut(404, { error: "ไม่พบ worktree นี้" });
      const r = runGit(["worktree", "remove", String(p || "")], ws.dir);
      if (r.code !== 0) return jsonOut(400, { error: (r.err || r.out).trim().slice(0, 300) });
      saveJson(WS_FILE, loadWorkspaces().filter((w) => w.dir !== target)); // ถอด workspace นั้นออก
      return jsonOut(200, { ok: true });
    }).catch(() => jsonOut(400, { error: "invalid body" }));
  }

  // ---- API: ถาม agent (stream) + คิวรอลึก 1 ----
  if (req.method === "POST" && req.url === "/api/ask") {
    // คิวเต็ม (งานวิ่ง + มีของรอ) → 429 ทันที ระดับ headers กัน race
    if (running && queuedItem) {
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Agent is busy and the queue is full — try again soon" }));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      if (!parsed.task || !String(parsed.task).trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Missing task" }));
      }
      parsed._user = currentUser(req); // v17: run นี้ใช้ key/ค่าของผู้ใช้คนนี้ (null เมื่อ authOff)
      const ws = authorizedWorkspace(parsed.ws, parsed._user);
      if (!ws) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "ไม่พบพื้นที่ทำงานนี้" }));
      }
      parsed.ws = ws.id;
      if (running) {
        if (queuedItem) { // กัน race: คิวถูกกินไประหว่างรอ body
          res.writeHead(429, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Agent is busy and the queue is full — try again soon" }));
        }
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const send = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, data })}\n\n`); } catch {} };
        send("queued", "รองานก่อนหน้าเสร็จ — จะเริ่มงานของคุณทันทีเมื่อว่าง");
        const item = { parsed, res };
        res.on("close", () => { if (!res.writableEnded && queuedItem === item) queuedItem = null; }); // client ปิดระหว่างรอคิว → ทิ้ง
        queuedItem = item;
        return;
      }
      await runTask(parsed, res);
    });
    return; // ไม่ให้ไหลต่อไปเจอ handler 404
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

// เปิดพอร์ตต่อเมื่อ key พร้อมเท่านั้น — ไม่จำเป็นต้องรับ request ตั้งแต่ key ยังไม่แน่
keyReady
  .then(() => server.listen(PORT, "127.0.0.1", () => console.log(`Research Agent UI → http://127.0.0.1:${PORT}`)))
  .catch(() => process.exit(1));
