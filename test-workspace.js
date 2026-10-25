/**
 * test-workspace.js — ทดสอบ v16 พื้นที่ทำงาน (per-run root) ฝั่ง agent
 * ข้อ 1: agentLoop({root: tmpProject}) → file_edit โดนงานใน tmpProject จริง (ไม่แตะ repo)
 * ข้อ 2: checkpoint ก่อนแก้เก็บ rec.root = tmpProject → diff เห็นการแก้ → restore กลับได้
 * ข้อ 3: run_command cwd = tmpProject (cd โชว์ path ใน onRun)
 * ข้อ 4: ctx.onRun ถูกเรียกจริง (แผง 🧪 ใน UI ได้ข้อมูล)
 * offline ทั้งหมด (mock fetch + tmp dirs) — ไม่เสีย cost ไม่แก้ repo จริง
 */
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"));
const PROJ = path.join(TMP, "proj");
fs.mkdirSync(PROJ);
fs.writeFileSync(path.join(PROJ, "note.txt"), "line1\nline2\nline3\n", "utf8");

process.env.OPENROUTER_API_KEY = "sk-or-v1-mock-test-key-0000000000000000";
process.env.AGENT_EVENTS_FILE = path.join(TMP, "events.jsonl");
process.env.AGENT_PLAYBOOK_FILE = path.join(TMP, "playbook.json");
process.env.AGENT_EVALS_FILE = path.join(TMP, "evals.json");
process.env.AGENT_SKILLS_FILE = path.join(TMP, "skills.json");
process.env.AGENT_CHECKPOINT_DIR = path.join(TMP, "ckpts");
process.env.AGENT_CHECKPOINT_FILE = path.join(TMP, "ckpts.json");
process.env.AGENT_NO_AUTH = "1";

const { agentLoop, loadCkpts, diffCheckpoint, restoreCheckpoint, whenLearned } = require("./research-agent.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };

// mock world: step1 = file_edit note.txt, step2 = run_command cd, step3 = final
const llmResponse = (content, toolCalls) => ({ status: 200, ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }] }) });
const toolCall = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("openrouter")) {
    const body = JSON.parse(opts.body);
    if (body.model.endsWith(":online")) return llmResponse("1. result — https://example.com/a");
    const count = body.messages.filter((m) => m.role === "assistant").length;
    if (count === 0) return llmResponse(null, [toolCall("t1", "file_edit", { path: "note.txt", oldString: "line2", newString: "line2 EDITED" })]);
    if (count === 1) return llmResponse(null, [toolCall("t2", "run_command", { command: "cd" })]);
    return llmResponse("done workspace test");
  }
  return realFetch(url, opts);
};

(async () => {
  const runs = [];
  await agentLoop("WORKSPACE TASK: แก้ note.txt แล้วรัน cd", {
    depth: 0, mode: "code",
    root: PROJ, // v16 — หัวใจของ test นี้
    onRun: (r) => runs.push(r),
  });
  await Promise.race([whenLearned(), sleep(2000)]);

  // ข้อ 1: ไฟล์ใน tmp โดนแก้จริง / repo ปลอดภัย
  const note = fs.readFileSync(path.join(PROJ, "note.txt"), "utf8");
  check("1 file_edit ลง tmpProject จริง", note.includes("line2 EDITED"), note.replace(/\n/g, " | "));
  check("1a repo จริงไม่โดนแตะ (note.txt ไม่ถูกสร้างใน cwd)", !fs.existsSync(path.join(process.cwd(), "note.txt")));

  // ข้อ 2: checkpoint rec.root = tmpProject + diff + restore
  // (run นี้มี 2 checkpoints: ก่อน file_edit = ยังไม่แก้, ก่อน run_command = แก้แล้ว — restore ต้องใช้อันเก่าสุด)
  const cks = loadCkpts();
  const noteCks = cks.filter((c) => c.files.some((f) => f.rel === "note.txt"));
  const ck = noteCks[noteCks.length - 1]; // เก่าสุด = snapshot ก่อน file_edit
  check("2 checkpoint เก็บ rec.root = tmpProject", !!(ck && ck.root === PROJ), ck ? `root=${path.basename(String(ck.root || "?"))} files=${ck.files.map((f) => f.rel).join(",")}` : "no ck with note.txt");
  if (ck) {
    const d = diffCheckpoint(ck.id);
    const flat = JSON.stringify(d);
    check("2a diff เห็น +EDITED", /EDITED/.test(flat));
    check("2b restore คืนไฟล์กลับ", restoreCheckpoint(ck.id) && !fs.readFileSync(path.join(PROJ, "note.txt"), "utf8").includes("EDITED"));
  }

  // ข้อ 3+4: run_command cwd ถูก + onRun มีข้อมูลครบ
  check("3 run_command cwd = tmpProject", runs.some((r) => r.code === 0 && path.resolve(r.text.trim().replace(/\r/g, "")).toLowerCase() === path.resolve(PROJ).toLowerCase()),
    runs.length ? JSON.stringify(runs.map((r) => ({ code: r.code, text: r.text.slice(0, 60) }))) : "no onRun calls");
  check("4 onRun มี cmd+ms+text ครบ", runs.every((r) => typeof r.cmd === "string" && typeof r.ms === "number" && typeof r.text === "string") && runs.length >= 1);

  const failed = results.filter((r) => !r.ok);
  console.log(`\nผ่าน ${results.length - failed.length}/${results.length}`);
  if (failed.length) { failed.forEach((f) => console.log("  FAIL: " + f.name)); process.exit(1); }
  console.log("ทุกข้อผ่าน ✓");
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
