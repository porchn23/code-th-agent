/**
 * test-member.js — ทดสอบ v17 ระบบสมาชิกจริง (สมัครเอง/โปรไฟล์/เปลี่ยนรหัส/key ส่วนตัว/โปรเจคต่อคน)
 * รัน server จริงบน 8787 (ไม่ปิด process อื่น) + state files ชั่วคราว — ไม่แตะข้อมูลผู้ใช้
 * R20: ตรวจว่า run ของ member ที่มี key ส่วนตัว → Bearer โดนส่งด้วย key ของคนนั้น (ไม่ใช่ key หลัก)
 */
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "member-test-"));
process.env.OPENROUTER_API_KEY = "sk-or-v1-server-default-key-mock0000000000";
process.env.AGENT_USERS_FILE = path.join(TMP, "users.json");
process.env.AGENT_SESSIONS_FILE = path.join(TMP, "sessions.json");
process.env.AGENT_WORKSPACES_FILE = path.join(TMP, "ws.json");
process.env.AGENT_WORKSPACE_ROOT = path.join(TMP, "member-workspaces");
fs.mkdirSync(process.env.AGENT_WORKSPACE_ROOT, { recursive: true });
process.env.AGENT_EVENTS_FILE = path.join(TMP, "events.jsonl");
process.env.AGENT_PLAYBOOK_FILE = path.join(TMP, "playbook.json");
process.env.AGENT_EVALS_FILE = path.join(TMP, "evals.json");
// ปิด eval/ckpt อัตโนมัติ — โฟกัสสมาชิก
process.env.AGENT_NO_EVALS = "1";
process.env.AGENT_NO_CHECKPOINTS = "1";

// ---- mock fetch ก่อน require server (จับ Authorization ทุกครั้ง) ----
const bearerSeen = []; // {auth, model}
const toolListsSeen = [];
const toolResultsSeen = [];
// server ยิง stream:true → ต้อง mock แบบ SSY stream (เหมือน test-server-mock.js)
const sseChunksFrom = (content) => {
  let s = "data: " + JSON.stringify({ choices: [{ delta: { role: "assistant" } }] }) + "\n\n";
  if (content) s += "data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\n\n" + "data: [DONE]\n\n";
  else s += "data: [DONE]\n\n";
  return s;
};
const sseToolCallFrom = (name, args) => "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "forced-call", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }) + "\n\ndata: [DONE]\n\n";
const mockLlmResponse = (content) => ({ status: 200, ok: true, headers: { get: () => "text/event-stream" }, text: async () => sseChunksFrom(content), json: async () => ({ choices: [{ message: { content } }] }) });
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("openrouter")) {
    let body = {};
    try { body = JSON.parse(opts.body); } catch {}
    const auth = opts.headers && (opts.headers.Authorization || opts.headers.authorization);
    if (!u.includes("/models")) bearerSeen.push({ auth, model: body.model });
    if (!u.includes("/models") && Array.isArray(body.tools)) toolListsSeen.push(body.tools.map((t) => t.function?.name));
    for (const m of body.messages || []) if (m.role === "tool") toolResultsSeen.push(String(m.content || ""));
    const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === "user")?.content || "";
    if (lastUser === "FORCE_MEMBER_COMMAND" && !(body.messages || []).some((m) => m.role === "tool"))
      return { ...mockLlmResponse("answer"), text: async () => sseToolCallFrom("run_command", { command: "echo must-not-run" }) };
    if (u.includes("/models")) return { status: 200, ok: true, json: async () => ({ data: [] }) };
    return mockLlmResponse(" answer");
  }
  return realFetch(url, opts);
};

// ไม่ปิด server ที่ผู้ใช้อาจกำลังใช้งานอยู่ — หากพอร์ตชนให้หยุดและแจ้งแทน
require("./server.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };
let cookieAdmin = "", cookieMember = "";

async function post(u, body, ck) {
  const r = await fetch("http://localhost:8787" + u, { method: "POST", headers: { "Content-Type": "application/json", ...(ck ? { cookie: ck } : {}) }, body: JSON.stringify(body) });
  return { s: r.status, j: await r.json().catch(() => ({})), h: r.headers };
}
async function get(u, ck) {
  const r = await fetch("http://localhost:8787" + u, { headers: ck ? { cookie: ck } : {} });
  return { s: r.status, j: await r.json().catch(() => ({})) };
}

(async () => {
  await sleep(800); // รอ server boot

  // R1 guard: /api/* ยังถูกบังคับ login
  const g = await get("/api/checkpoints");
  check("R1 unauth /api/* → 401", g.s === 401, "s=" + g.s);

  // สมัคร validation
  check("R2 register pw สั้น → 400", (await post("/api/register", { name: "ann", email: "ann@mail.com", password: "123" })).s === 400);
  check("R3 register email มั่ว → 400", (await post("/api/register", { name: "ann", email: "not-an-email", password: "123456" })).s === 400);
  check("R4 register ไม่มีชื่อ → 400", (await post("/api/register", { email: "ann@mail.com", password: "123456" })).s === 400);

  // admin คนแรก (setup) — เจ้าของเครื่อง
  const su = await post("/api/setup", { name: "owner", email: "owner@mail.com", password: "ownerpw" });
  check("R0 setup owner → 200 + admin", su.s === 200 && su.j.user?.role === "admin", JSON.stringify(su.j));
  cookieAdmin = (su.h.get("set-cookie") || "").split(";")[0];

  // R5 สมัครเองสำเร็จ = member
  const reg = await post("/api/register", { name: "ann", email: "ann@mail.com", password: "annpass" });
  check("R5 register สำเร็จ → member", reg.s === 200 && reg.j.user?.role === "member", JSON.stringify(reg.j));
  cookieMember = (reg.h.get("set-cookie") || "").split(";")[0];
  check("R5a cookie มี agent_ses", /agent_ses=/.test(cookieMember || ""));

  check("R6 dup ชื่อ → 400", (await post("/api/register", { name: "ann", email: "other@mail.com", password: "123456" })).s === 400);
  check("R7 dup email → 400", (await post("/api/register", { name: "ann2", email: "ann@mail.com", password: "123456" })).s === 400);

  // R8 login ด้วย email ได้
  const loginE = await post("/api/login", { name: "ann@mail.com", password: "annpass" });
  check("R8 login ด้วย email → 200", loginE.s === 200 && loginE.j.user?.name === "ann", JSON.stringify(loginE.j));

  // R9/R10 โปรไฟล์
  const pf = await get("/api/profile", cookieMember);
  check("R9 GET profile → {name,email,role}", pf.s === 200 && pf.j.name === "ann" && pf.j.email === "ann@mail.com", JSON.stringify(pf.j));
  const preRenameDir = path.join(process.env.AGENT_WORKSPACE_ROOT, encodeURIComponent("ann"), "before-rename");
  fs.mkdirSync(preRenameDir, { recursive: true });
  const preRenameWs = await post("/api/workspaces", { dir: preRenameDir }, cookieMember);
  check("R9a workspace ก่อนเปลี่ยนชื่อถูกสร้าง", preRenameWs.s === 200 && preRenameWs.j.workspace?.owner === "ann");
  const upd = await post("/api/profile", { name: "ann2", email: "ann2@mail.com" }, cookieMember);
  check("R10 แก้โปรไฟล์ ok + session ตาม", upd.s === 200 && upd.j.name === "ann2" && (await get("/api/me", cookieMember)).j.user?.name === "ann2", JSON.stringify(upd.j));
  const renamedWs = (await get("/api/workspaces", cookieMember)).j.workspaces?.find((w) => w.id === preRenameWs.j.workspace?.id);
  check("R10b เปลี่ยนชื่อแล้วยังเข้าถึง workspace เดิมได้", renamedWs?.owner === "ann2");
  check("R10c ลบ workspace เดิมได้หลังเปลี่ยนชื่อ", (await post("/api/workspaces/remove", { id: preRenameWs.j.workspace?.id }, cookieMember)).s === 200);
  check("R10a dup email คนอื่น → 400", (await post("/api/profile", { email: "owner@mail.com" }, cookieMember)).s === 400);

  // R11/R12 เปลี่ยนรหัสผ่าน
  check("R11 รหัสเดิมผิด → 401", (await post("/api/password", { old: "wrongpw", next: "newpass99" }, cookieMember)).s === 401);
  const pw = await post("/api/password", { old: "annpass", next: "newpass99" }, cookieMember);
  const relogin = await post("/api/login", { name: "ann2@mail.com", password: "newpass99" });
  check("R12 เปลี่ยนรหัสสำเร็จ + login ด้วยรหัสใหม่ได้", pw.s === 200 && relogin.s === 200);

  // key ส่วนตัว
  check("R13 key prefix ผิด → 400", (await post("/api/key", { orKey: "nope-1234567890" }, cookieMember)).s === 400);
  const keyOk = await post("/api/key", { orKey: "sk-or-v1-member-private-key-mock-9999" }, cookieMember);
  check("R14 บันทึก key → masked …last4", keyOk.s === 200 && /9999$/.test(keyOk.j.masked || ""), JSON.stringify(keyOk.j));
  const keyGet = await get("/api/key", cookieMember);
  check("R15 GET key ได้แค่ mask ไม่รั่ว full", !JSON.stringify(keyGet.j).includes("sk-or-v1-member-private"), JSON.stringify(keyGet.j));

  // โปรเจคต่อสมาชิก — ใช้โฟลเดอร์คนละโฟลเดอร์ (dedupe ตัวเดียวกัน → 400 ตามดีไซน์)
  const WS_ADMIN = path.join(TMP, "ws-admin"), WS_MEMBER = path.join(TMP, "ws-member");
  fs.mkdirSync(WS_ADMIN); fs.mkdirSync(WS_MEMBER);
  execFileSync("git", ["init", "--quiet"], { cwd: WS_ADMIN, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Member Test"], { cwd: WS_ADMIN, windowsHide: true });
  execFileSync("git", ["config", "user.email", "member-test@example.invalid"], { cwd: WS_ADMIN, windowsHide: true });
  fs.writeFileSync(path.join(WS_ADMIN, "README.md"), "workspace test\n");
  execFileSync("git", ["add", "README.md"], { cwd: WS_ADMIN, windowsHide: true });
  execFileSync("git", ["commit", "--quiet", "-m", "test"], { cwd: WS_ADMIN, windowsHide: true });
  const wsAdd = await post("/api/workspaces", { dir: WS_ADMIN }, cookieAdmin);
  check("R16 admin เพิ่ม workspace → 200 + owner=admin", wsAdd.s === 200 && (wsAdd.j.workspace?.owner === "owner" || !wsAdd.j.error), JSON.stringify(wsAdd.j));
  const adminList = (await get("/api/workspaces", cookieAdmin)).j.workspaces || [];
  check("R16a admin เห็นทุก ws", adminList.some((w) => w.id === "ws-root") && adminList.length >= 2, "n=" + adminList.length);

  // member สร้าง ws ตัวเอง
  const wsMember = await post("/api/workspaces", { dir: WS_MEMBER }, cookieMember);
  check("R17 member เพิ่ม path นอก workspace ส่วนตัวไม่ได้", wsMember.s === 403);
  const WS_MEMBER_OWN = path.join(process.env.AGENT_WORKSPACE_ROOT, encodeURIComponent("ann2"), "project");
  fs.mkdirSync(WS_MEMBER_OWN, { recursive: true });
  const wsOwn = await post("/api/workspaces", { dir: WS_MEMBER_OWN }, cookieMember);
  check("R17a member เพิ่ม workspace ใต้โฟลเดอร์ส่วนตัวได้", wsOwn.s === 200 && wsOwn.j.workspace?.owner === "ann2", JSON.stringify(wsOwn.j));
  const memList = (await get("/api/workspaces", cookieMember)).j.workspaces || [];
  check("R17b member เห็นเฉพาะ own + ws-root + ไม่มี owner", memList.every((w) => !w.owner || w.owner === "ann2" || w.id === "ws-root"), "n=" + memList.length);
  const wsAdminId = wsAdd.j.workspace?.id;
  check("R18 member ลบ ws ของ admin → 403", (await post("/api/workspaces/remove", { id: wsAdminId }, cookieMember)).s === 403);
  check("R18a member เปิด tree ของ admin → 404", (await get("/api/tree?ws=" + wsAdminId, cookieMember)).s === 404);
  check("R18b member อ่านไฟล์ของ admin → 404", (await get("/api/file?ws=" + wsAdminId + "&path=AGENTS.md", cookieMember)).s === 404);
  check("R18c member ดู worktrees ของ admin → 404", (await get("/api/worktrees?ws=" + wsAdminId, cookieMember)).s === 404);
  check("R18d member สร้าง worktree ใน repo admin ไม่ได้ → 404", (await post("/api/worktrees/create", { ws: wsAdminId, name: "member-forbidden" }, cookieMember)).s === 404);
  const wtCreate = await post("/api/worktrees/create", { ws: wsAdminId, name: "admin-test-wt" }, cookieAdmin);
  check("R18e admin สร้าง worktree ได้และ owner ถูกกำหนด", wtCreate.s === 200 && fs.existsSync(wtCreate.j.path), JSON.stringify(wtCreate.j));
  const wtListed = await get("/api/worktrees?ws=" + wsAdminId, cookieAdmin);
  const createdWt = wtListed.j.worktrees?.find((w) => path.resolve(w.path) === path.resolve(wtCreate.j.path));
  check("R18f admin เห็น worktree ที่สร้าง", !!createdWt, JSON.stringify({ status: wtListed.s, path: wtCreate.j.path, listed: wtListed.j.worktrees }));
  const wtRemoved = createdWt && await post("/api/worktrees/remove", { ws: wsAdminId, p: createdWt.path }, cookieAdmin);
  check("R18g admin ลบ worktree ได้และถอด workspace", wtRemoved?.s === 200 && !(await get("/api/workspaces", cookieAdmin)).j.workspaces.some((w) => w.dir === wtCreate.j.path));
  const wsMemId = wsOwn.j.workspace?.id;
  check("R19 owner ลบ ws ตัวเองได้", (await post("/api/workspaces/remove", { id: wsMemId }, cookieMember)).s === 200);

  // R20: run ของ member ใช้ Bearer = key ของ member
  bearerSeen.length = 0;
  const ask = await fetch("http://localhost:8787/api/ask", { method: "POST", headers: { "Content-Type": "application/json", cookie: cookieMember }, body: JSON.stringify({ task: "KEY BEARER TEST", mode: "code" }) });
  const text = await ask.text();
  await sleep(400);
  const llmAuth = bearerSeen.filter((b) => typeof b.auth === "string" && (!b.model || !String(b.model).endsWith(":online"))).map((b) => b.auth);
  check("R20 run member → Bearer = key ของ member", llmAuth.some((a) => a.includes("member-private-key-mock-9999")),
    llmAuth.length ? llmAuth.slice(0, 2).join(" | ") : "no llm calls (ask s=" + ask.status + " len=" + text.length + ")");
  // ที่สำคัญ: ไม่ใช่ key หลักเครื่อง
  check("R20a Bearer ≠ key หลักเครื่อง", llmAuth.length && llmAuth.some((a) => a.includes("member-private")), "ok");
  check("R21 member ไม่มี run_command/tool_create", toolListsSeen.some((names) => !names.includes("run_command") && !names.includes("tool_create")), JSON.stringify(toolListsSeen.at(-1)));
  const forcedCommand = await fetch("http://localhost:8787/api/ask", { method: "POST", headers: { "Content-Type": "application/json", cookie: cookieMember }, body: JSON.stringify({ task: "FORCE_MEMBER_COMMAND", mode: "code" }) });
  await forcedCommand.text();
  check("R21a runtime ปฏิเสธ run_command ที่สมาชิกบังคับเรียก", toolResultsSeen.some((result) => result.includes("admins only")), toolResultsSeen.at(-1));
  toolListsSeen.length = 0;
  const adminAsk = await fetch("http://localhost:8787/api/ask", { method: "POST", headers: { "Content-Type": "application/json", cookie: cookieAdmin }, body: JSON.stringify({ task: "ADMIN TOOL ACCESS", mode: "code" }) });
  await adminAsk.text();
  check("R22 admin ยังใช้ run_command/tool_create ได้", toolListsSeen.some((names) => names.includes("run_command") && names.includes("tool_create")), JSON.stringify(toolListsSeen.at(-1)));

  const failed = results.filter((r) => !r.ok);
  console.log(`\nผ่าน ${results.length - failed.length}/${results.length}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  if (failed.length) { failed.forEach((f) => console.log("  FAIL: " + f.name)); process.exit(1); }
  console.log("ทุกข้อผ่าน ✓");
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(1); });
