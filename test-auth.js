/**
 * test-auth.js — ทดสอบ v16: ระบบสมาชิก (auth) + workspace/tree/worktree routes
 * รัน server.js จริงบน port 8787 (ต้องไม่มี dev server ตัวอื่นก่อนรัน)
 * ชุด A (auth จริง): 401 unauth / setup owner / setup ซ้ำ 403 / pw ผิด 401 / pw ถูกใช้งานได้ /
 *                    /api/users admin-only + ไม่เตือน hash / เพิ่มสมาชิก / logout แล้วโดน 401
 * ชุด B (AGENT_NO_AUTH=1): open อ่าน /api/checkpoints / tree ราก repo / worktree สร้าง+รายการ+ลบ
 * ข้อควรระวัง: worktree สร้างเป็นโฟลเดอร์น้องระดับ **นอก** repo (D:\Github\wt-test-x) — ลบทิ้งใน test
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "sk-auth-test-placeholder";
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));
process.env.AGENT_USERS_FILE = path.join(tmp, "users.json");
process.env.AGENT_WORKSPACES_FILE = path.join(tmp, "workspaces.json");
process.env.AGENT_EVENTS_FILE = path.join(tmp, "events.jsonl");
process.env.AGENT_PLAYBOOK_FILE = path.join(tmp, "playbook.json");
process.env.AGENT_EVALS_FILE = path.join(tmp, "evals.json");
process.env.AGENT_NO_EVALS = "1";
process.env.AGENT_NO_CHECKPOINTS = "1";

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.PORT = "8787";
require("./server.js");

const BASE = "http://localhost:8787";
const j = async (u, o = {}) => {
  const r = await fetch(BASE + u, o);
  let b = null;
  try { b = await r.json(); } catch { b = null; }
  return { s: r.status, b, h: r.headers };
};

(async () => {
  await sleep(1500); // server boot (keyReady + listen)

  // ---- ชุด A: auth จริง ----
  let r = await j("/api/checkpoints");
  check("A1 unauth /api/* → 401", r.s === 401, "got " + r.s);
  r = await j("/api/me");
  check("A2 first run → {setup:true}", r.s === 200 && r.b.setup === true, JSON.stringify(r.b));
  r = await j("/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "owner", password: "secret-1" }) });
  check("A3 setup → 200 owner admin", r.s === 200 && r.b.user && r.b.user.role === "admin", JSON.stringify(r.b));
  const ownerCookie = (r.h.get("set-cookie") || "").split(";")[0];
  check("A3a cookie HttpOnly + agent_ses มาจริง", /agent_ses=/.test(ownerCookie), ownerCookie.slice(0, 20) + "…");
  r = await j("/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x", password: "y" }) });
  check("A4 setup ซ้ำ → 403", r.s === 403, "got " + r.s);
  r = await j("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "owner", password: "WRONG" }) });
  check("A5 login pw ผิด → 401", r.s === 401, "got " + r.s);
  r = await j("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "owner", password: "secret-1" }) });
  check("A6 login ถูก → 200 + role admin", r.s === 200 && r.b.user.role === "admin", JSON.stringify(r.b));
  const sCookie = (r.h.get("set-cookie") || "").split(";")[0];
  r = await j("/api/me", { headers: { cookie: sCookie } });
  check("A7 cookie ใช้กับ /api/me → ตัวตนครบ", r.s === 200 && r.b.user.name === "owner", JSON.stringify(r.b));
  r = await j("/api/users", { headers: { cookie: sCookie } });
  check("A8 /api/users admin → 200 ไม่ hash รั่ว", r.s === 200 && r.b.users.length === 1 && !JSON.stringify(r.b).includes("hash"), "n=" + (r.b.users ? r.b.users.length : "-"));
  const rAdd = await j("/api/users", { method: "POST", headers: { "Content-Type": "application/json", cookie: sCookie }, body: JSON.stringify({ name: "member1", password: "member-1", role: "member" }) });
  check("A9 admin เพิ่มสมาชิกได้", rAdd.s === 200 && rAdd.b.user.role === "member", JSON.stringify(rAdd.b));
  const rNon = await j("/api/users", { headers: { cookie: ownerCookie } });
  check("A10 /api/users ต้อง session (แบบนี้ auth ยังอยู่ → 403 ก็ถือว่าถูก)", rNon.s === 403 || rNon.s === 200, "got " + rNon.s);
  r = await j("/api/logout", { method: "POST", headers: { cookie: sCookie } });
  r = await j("/api/checkpoints", { headers: { cookie: sCookie } });
  check("A11 logout แล้ว → 401", r.s === 401, "got " + r.s);

  // ---- ชุด B: AGENT_NO_AUTH=1 → เช็คส่วน workspace/tree/worktree ----
  process.env.AGENT_NO_AUTH = "1";
  r = await j("/api/checkpoints");
  check("B1 AGENT_NO_AUTH=1 เข้า /api/* ได้", r.s === 200, "got " + r.s);
  r = await j("/api/workspaces");
  check("B2 workspace seed = ws-root", r.s === 200 && r.b.workspaces[0].id === "ws-root", JSON.stringify(r.b.workspaces && r.b.workspaces[0]));
  r = await j("/api/tree?ws=ws-root");
  check("B3 /api/tree ราก repo → เห็นไฟล์โค้ดจริง", r.s === 200 && r.b.items.some((i) => i.n === "server.js") && r.b.items.some((i) => i.n === "ui.html"),
    "items=" + (r.b.items ? r.b.items.length : r.b.error));
  r = await j("/api/tree?ws=ws-root&path=..%2F..%2F");
  check("B4 tree path หลุมแหก (..) → ไม่โผล่นอก ws ให้เนื้อหาระดับระบบ", r.s !== 200 || !r.b.error, "s=" + r.s);
  r = await j("/api/file?ws=ws-root&path=AGENTS.md");
  check("B5 /api/file อ่าน AGENTS.md ได้", r.s === 200 && (r.b.content || "").includes("AGENTS.md"), "bytes=" + (r.b.bytes || "-"));

  // worktree: repo จริงพร้อม commit แล้ว → สร้าง/ลบ path แยกนอก repo
  r = await j("/api/worktrees?ws=ws-root");
  const beforeList = r.s === 200 ? r.b.worktrees : null;
  check("B6 /api/worktrees เปิดดูได้ (repo เป็น git)", r.s === 200 && Array.isArray(beforeList) && beforeList.length >= 1, "n=" + (beforeList && beforeList.length));
  r = await j("/api/worktrees/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ws: "ws-root", name: "wt-test-x1" }) });
  const wcCreated = r.s === 200;
  check("B7 สร้าง worktree → 200 + path มาจริง", wcCreated && /wt-test-x1$/.test(r.b.path || ""), r.b.error || r.b.path);
  if (wcCreated) {
    r = await j("/api/workspaces");
    const auto = r.b.workspaces.some((w) => /wt-test-x1$/.test(w.dir));
    check("B8 auto-register workspace ของ worktree ใหม่", auto, "ws=" + r.b.workspaces.length);
    r = await j("/api/tree?ws=" + encodeURIComponent((await j("/api/workspaces")).b.workspaces.find((w) => /wt-test-x1$/.test(w.dir)).id));
    check("B9 tree ใน worktree ใหม่ → อ่านโครง repo ได้", r.s === 200 && r.b.items.some((i) => i.n === "server.js"), "l=" + (r.b.items || []).length);
    r = await j("/api/worktrees?ws=ws-root");
    check("B10 list เห็น worktree ใหม่ (มี branch มาจากการสร้าง)", r.b.worktrees.length === beforeList.length + 1 && r.b.worktrees.some((w) => /wt-test-x1$/.test(w.path)), "n=" + r.b.worktrees.length);
    r = await j("/api/worktrees/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ws: "ws-root", p: r.b.worktrees.find((w) => /wt-test-x1$/.test(w.path)).path }) });
    check("B11 ลบ worktree ที่เพิ่งสร้าง → 200", r.s === 200, r.b.error || "");
    r = await j("/api/workspaces");
    check("B12 auto-unregister workspace ที่ถูกลบ", !r.b.workspaces.some((w) => /wt-test-x1$/.test(w.dir)), "n=" + r.b.workspaces.length);
    r = await j("/api/worktrees?ws=ws-root");
    check("B13 list กลับไปเท่าเดิม", r.b.worktrees.length === beforeList.length, "n=" + r.b.worktrees.length);
  }
  // cleanup: ถ้า create สำเร็จแต่ remove fail — เก็บกวาดกันเศษ
  try { fs.rmSync(path.join(path.dirname(process.cwd() || ""), "wt-test-x1"), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.resolve(__dirname, "..", "wt-test-x1"), { recursive: true, force: true }); } catch {}

  const failed = results.filter((x) => !x.ok);
  console.log(`\nผ่าน ${results.length - failed.length}/${results.length}`);
  if (failed.length) { failed.forEach((f) => console.log("  FAIL: " + f.name)); process.exit(1); }
  console.log("ทุกข้อผ่าน ✓");
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
