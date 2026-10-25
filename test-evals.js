/**
 * test-evals.js — ทดสอบ วงจร 3: Task→Eval (agent เก็บ checklist จากงานที่สำเร็จ)
 * ข้อ 1: run สำเร็จแบบมี tool ≥3 steps → eval ถูกบันทึกลง agent_evals.json
 * ข้อ 2: eval reflector โดนเรียก "1 ครั้ง" ต่อ 1 run (ตอบ PATTERN|CHECK ตาม format)
 * ข้อ 3: run ที่ 2 งานหัวข้อคล้ายกัน → eval hints inject เข้า system prompt
 * ข้อ 4: dedupe — งานคล้ายกันซ้ำไม่สร้าง entry ใหม่ แต่ bump usageCount
 * ข้อ 5: run ที่มี error / สั้นเกิน / AGENT_NO_EVALS=1 → ไม่สร้าง eval
 * offline world ทั้งหมด (mock fetch + tmp state files) — ไม่เสีย cost
 */
process.env.OPENROUTER_API_KEY = "sk-or-v1-mock-test-key-0000000000000000";
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");
process.env.AGENT_EVENTS_FILE = path.join(os.tmpdir(), "eval-test-events.jsonl");
process.env.AGENT_PLAYBOOK_FILE = path.join(os.tmpdir(), "eval-test-playbook.json");
process.env.AGENT_EVALS_FILE = path.join(os.tmpdir(), "eval-test-evals.json");
process.env.AGENT_SKILLS_FILE = path.join(os.tmpdir(), "eval-test-skills.json");
try { fs.unlinkSync(process.env.AGENT_EVALS_FILE); } catch {}

const { CONFIG, agentLoop, evalSummary, loadEvals } = require("./research-agent.js");
CONFIG.apiKey = "mock";

// ---- mock world: task "well ทำงาน 3 step" → tool×2 → final; eval-reflector ตอบ format จริง ----
const llmResponse = (content, toolCalls) => ({ status: 200, ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }] }) });
const toolCall = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const short = `research "มีหลักในวงค์ทำ dashboard รายชื่อ: agent วัตถุให้ส่ง: 31 §"`;
const EVAL_REPLIES = [
  "PATTERN: dashboard report daily | CHECK: fetch fresh data; cross-check 2 sources; save report file",
];
const llmCalls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("openrouter")) {
    const body = JSON.parse(opts.body);
    if (body.model.endsWith(":online")) return llmResponse("1. result — https://example.com/a");
    const sys = body.messages.find((m) => m.role === "system")?.content || "";
    const lastUser = [...body.messages].reverse().find((m) => m.role === "user")?.content || "";
    const count = body.messages.filter((m) => m.role === "assistant").length;
    // eval reflector — จับจาก system ของมันเอง (คนเดียวที่ระบบบอก format)
    if (/agent's own eval curator/.test(sys)) {
      llmCalls.push({ kind: "eval", task: lastUser });
      return llmResponse(EVAL_REPLIES[0]);
    }
    llmCalls.push({ kind: "main", task: lastUser, turn: count, tools: (body.tools || []).map((t) => t.function.name) });
    if (/SUCCESS REPORT TASK/.test(lastUser)) {
      if (count === 0) return llmResponse(null, [toolCall("t1", "web_search", { query: "a" }), toolCall("t2", "web_search", { query: "b" })]);
      if (count === 1) return llmResponse(null, [toolCall("t4", "web_search", { query: "a b summary" })]);
      return llmResponse("done report");
    }
    if (/SHORT ERR RUN/.test(lastUser)) {
      if (count === 0) return llmResponse(null, [toolCall("t3", "web_search", { query: "c" })]);
      return llmResponse("tiny answer");
    }
    return llmResponse("misc");
  }
  return realFetch(url, opts);
};

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitLearned = () => Promise.race([require("./research-agent.js").whenLearned(), sleep(2000)]);

(async () => {
  // ข้อ 1+2: run สำเร็จ ≥3 steps → eval เก็บ + reflector ครั้งเดียว
  await agentLoop("SUCCESS REPORT TASK: สร้าง dashboard report daily", { depth: 0 });
  await waitLearned();
  const evals = loadEvals();
  check("1 run สำเร็จ ≥3 steps สร้าง eval จริง", evals.length === 1, "evals=" + evals.length);
  check("1a eval มี keywords+check ครบ format", evals[0] && evals[0].keywords.includes("dashboard") && evals[0].check.length === 3,
    evals[0] ? JSON.stringify(evals[0].keywords) + " / " + evals[0].check.length : "none");
  check("2 eval reflector ถูกเรียก 1 ครั้ง", llmCalls.filter((c) => c.kind === "eval").length === 1,
    "eval llm calls=" + llmCalls.filter((c) => c.kind === "eval").length);

  // ข้อ 3: run อื่นที่คล้ายกัน → system prompt โดน inject hints
  let injected = false;
  const orig = global.fetch;
  global.fetch = async (u, o) => {
    const r = await orig(u, o);
    try {
      const body = JSON.parse(o.body);
      if (/agent's own eval curator/.test(body.messages.find((m) => m.role === "system")?.content || "")) return r;
      if (body.messages.find((m) => m.role === "system")?.content.includes("Eval hints")) injected = true;
    } catch {}
    return r;
  };
  await agentLoop("สร้าง dashboard report daily อีกรอบ", { depth: 0 });
  await waitLearned();
  global.fetch = orig;
  check("3 งานคล้ายกัน system prompt ได้ Eval hints", injected);

  // ข้อ 4: dedupe — งานคล้ายมากซ้ำ → bump ไม่ new
  await agentLoop("SUCCESS REPORT TASK อีกครั้ง dashboard", { depth: 0 });
  await waitLearned();
  const after = loadEvals();
  check("4 dedupe งานคล้ายซ้ำ → bump ×2 ไม่เพิ่ม entry", after.length === 1 && after[0].usageCount === 2,
    `evals=${after.length} usage=${after[0] && after[0].usageCount}`);

  // ข้อ 5: run สั้น (1 step) ไม่เข้าเงื่อนไข → ไม่สร้าง eval ใหม่
  llmCalls.length = 0;
  await agentLoop("SHORT ERR RUN", { depth: 0 });
  await waitLearned();
  check("5 run <3 steps ไม่บันทึก eval", llmCalls.filter((c) => c.kind === "eval").length === 0 && loadEvals().length === 1,
    "eval calls=" + llmCalls.filter((c) => c.kind === "eval").length);
  // ข้อ 5b: AGENT_NO_EVALS — off switch ปิดจริง
  process.env.AGENT_NO_EVALS = "1";
  llmCalls.length = 0;
  await agentLoop("SUCCESS REPORT TASK — off switch test with tools dashboard", { depth: 0 });
  await waitLearned();
  check("5b AGENT_NO_EVALS=1 ปิด eval จริง", loadEvals().length === 1 && llmCalls.filter((c) => c.kind === "eval").length === 0);
  process.env.AGENT_NO_EVALS = ""; // คืนค่า

  // ข้อ 6: evalSummary + avgTok
  const s = evalSummary();
  check("6 evalSummary ครบ (runs.ok ≥ 4, avgTok>0)", s.evals.length === 1 && s.runs.ok >= 4 && s.runs.avgTok > 0, JSON.stringify(s.runs));

  const failed = results.filter((r) => !r.ok);
  console.log(`\nผ่าน ${results.length - failed.length}/${results.length}`);
  if (failed.length) { failed.forEach((f) => console.log("  FAIL: " + f.name)); process.exit(1); }
  console.log("ทุกข้อผ่าน ✓");
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
