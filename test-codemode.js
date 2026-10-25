/**
 * test-codemode.js — ทดสอบ Code Mode แบบ offline (ไม่มี network, ไม่มี key จริง)
 * ครอบคลุม:
 *  A) flow จริง: file_read → file_edit → run_command (ต้องได้ output "PASS") → คำตอบจบ
 *  B) run_command destructive (rm -rf /) ต้องถูก block และ error กลับเข้า context ได้
 *  C) getTools("code") มี 13 tools / research มี 10 (ไม่มี code tools)
 *  D) system prompt โหมด code มี VERIFICATION GATE — research ไม่มี
 *  E) file_edit แบบ oldString ซ้ำหลายจุด → ต้อง error ให้เพิ่ม context (ACI: ทำพลาดยาก)
 *  F) file_grep คืน path:line ถูกไฟล์
 * รัน: node test-codemode.js
 */
process.env.AGENT_EVENTS_FILE = require("node:path").join(require("node:os").tmpdir(), "cm-ev-test.jsonl");
process.env.AGENT_PLAYBOOK_FILE = require("node:path").join(require("node:os").tmpdir(), "cm-pb-test.jsonl");
process.env.AGENT_NO_EVALS = "1"; // Circuit 3 ปิดใน test เดิม — กัน eval-reflector ยิง LLM นอกสคริปต์
process.env.AGENT_PROJECT_DIR = require("node:path").join(require("node:os").tmpdir(), "cm-proj-" + Date.now());
const fs = require("node:fs");
const PROJ = process.env.AGENT_PROJECT_DIR;
fs.mkdirSync(PROJ, { recursive: true });

// fixture: app.js ที่ bug (ต้องแก้จาก - เป็น + แล้วรันต้องได้ PASS)
fs.writeFileSync(require("node:path").join(PROJ, "app.js"), `let count = 0;\ncount = count - 1;\ncount = count + 1;\nconsole.log(count === 1 ? "PASS" : "FAIL");\n`, "utf8");
fs.writeFileSync(require("node:path").join(PROJ, "lib.js"), `// lib: helper for app.js\nconst dup = (count) => count * 2;\n`, "utf8");

const agent = require("./research-agent.js");
const { agentLoop, getTools, CONFIG } = agent;
CONFIG.apiKey = "sk-or-v1-mock-test-key";
try { fs.unlinkSync(process.env.AGENT_EVENTS_FILE); } catch {}
try { fs.unlinkSync(process.env.AGENT_PLAYBOOK_FILE); } catch {}

const errors = [];
const assert = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + " — " + name); if (!cond) errors.push(name); };

// ---------- mock world: OpenRouter chat ตามจำนวน assistant ที่คุยไปแล้ว ----------
let turnsScenarios = null; // set เป็น array ต่อ scenario
let loginTurns = null;
const reflectMsg = { role: "web" , rule: "web: mock rule" };

require("node:http"); // (จริง ๆ ไม่จำเป็น — ใส่กัน lint)
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("/api/v1/models")) {
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  }
  if (!u.includes("/chat/completions")) throw new Error("unexpected url " + u);
  const body = JSON.parse(opts.body || "{}");
  const nAssist = body.messages.filter((m) => m.role === "assistant").length;
  // reflector call: ไม่มี body.tools และ system มีคำ 'reflector'
  if (!body.tools) {
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: reflectMsg.rule } }] }) };
  }
  const script = turnsScenarios[(loginTurns || 0) * 0 + nAssist] || [];
  const step = Array.isArray(script) ? script[0] : null; // แต่ละ turn เก็บเป็น [object]
  if (step == null) throw new Error("mock script ended unexpectedly at turn " + nAssist);
  const capture = { role: "assistant", content: step.content || "" };
  if (step.tool_calls) capture.tool_calls = step.tool_calls.map((t, i) => ({
    id: "call_" + i + "_" + Math.random().toString(36).slice(2, 6),
    type: "function",
    index: i,
    function: { name: t.name, arguments: JSON.stringify(t.args || {}) },
  }));
  const text = JSON.stringify({ choices: [{ message: capture }] });
  return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text, getReader: undefined };
};

// helper: จับ tool result ล่าสุดก่อน assistant ต่อไป (จาก body.messages)
const lastToolResults = (body) => body.messages.filter((m) => m.role === "tool");
const sysPrompt = (body) => body.messages.find((m) => m.role === "system")?.content || "";

// ================= Scenario A: flow แก้โค้ดจริง =================
(async () => {
  // จับ first-request system prompt ของแต่ละ run (run ไหนรันล่าสุด = ค่าใน lastFirstSys)
  let sawSys = "", sawResearchSys = "", lastFirstSys = "";
  let results = []; // tool result ของ run ปัจจุบัน (capture จาก request ที่มี role:tool)
  let turnIdx = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    try {
      const body = JSON.parse(opts.body || "{}");
      if (body.tools && !body.messages.some((m) => m.role === "assistant")) {
        lastFirstSys = body.messages.find((m) => m.role === "system")?.content || "";
      }
      if (body.tools) {
        const tms = body.messages.filter((m) => m.role === "tool");
        if (tms.length) results.push(String(tms[tms.length - 1].content));
      }
    } catch {}
    return realFetch(url, opts);
  };

  // -------- Scenario A: flow แก้โค้ดจริง (script: read → edit → run → answer) --------
  turnsScenarios = [
    [{ tool_calls: [{ name: "file_read", args: { path: "app.js" } }] }],
    [{ tool_calls: [{ name: "file_edit", args: { path: "app.js", oldString: "count = count - 1;", newString: "/* noop — fixed */" } }] }],
    [{ tool_calls: [{ name: "run_command", args: { command: "node app.js", timeoutMs: 15000 } }] }],
    [{ content: "แก้เสร็จ — รัน node app.js แล้ว output มีคำว่า PASS" }],
    ...Array.from({ length: 20 }, () => [{ content: "done" }]),
  ];

  const answerA = await agentLoop("แก้ bug ใน app.js ให้รันแล้วได้ PASS แลบอกเหตุผล", {
    tools: getTools("code"), mode: "code", maxSteps: 6, noBanner: true,
  });
  sawSys = lastFirstSys;
  assert("A0 run_command ได้ exit 0 + output PASS", results.some((r) => /pass/i.test(r) && /exit 0/.test(r)));

  assert("A1 system prompt code mode มี VERIFICATION GATE", /VERIFICATION GATE/.test(sawSys));
  assert("A2 คำตอบอ้าง output จริง (PASS)", /PASS/.test(answerA));
  // ตรวจไฟล์ fixture ถูกแก้จริง
  const after = fs.readFileSync(require("node:path").join(PROJ, "app.js"), "utf8");
  assert("A3 app.js ถูกแก้จริง (มี /* noop — fixed */)", /noop/.test(after) && /fixed/.test(after));

  // -------- Scenario C/D: tools list + system prompt โหมด research --------
  const codeT = getTools("code"), resT = getTools("research");
  assert("C1 code mode มี 14 tools", codeT.length === 14);   // 10 built-in + 3 code + tool_create (Circuit 2)
  assert("C2 research mode มี 11 tools", resT.length === 11); // 10 built-in + tool_create
  assert("C3 research ไม่มี run_command", !resT.some((t) => t.function.name === "run_command"));

  // run โหมด research จริงหนึ่งครั้งเพื่อจับ system prompt
  turnsScenarios = [[{ content: "จบ" }], ...Array.from({ length: 20 }, () => [{ content: "done" }])];
  await agentLoop("ทักทาย (research mode)", { tools: resT, mode: "research", maxSteps: 2, noBanner: true });
  sawResearchSys = lastFirstSys;
  assert("D1 research system ไม่มี CODE MODE", !/CODE MODE/.test(sawResearchSys));

  // -------- Scenario B: destructive command โดน block --------
  sawSys = "";
  turnsScenarios = [
    [{ tool_calls: [{ name: "run_command", args: { command: "rm -rf /" } }] }],
    [{ content: "จบ — command โดน block แล้ว" }],
    ...Array.from({ length: 20 }, () => [{ content: "done" }]),
  ];
  turnIdx = 2;
  results = [];
  const answerB = await agentLoop("ลองรัน rm -rf", { tools: getTools("code"), mode: "code", maxSteps: 4, noBanner: true });
  assert("B1 model เห็น error แบบ blocked", results.some((r) => /Blocked: potentially destructive/.test(r)));

  // -------- Scenario E: file_edit ซ้ำหลายจุด ต้อง error ขอ context --------
  fs.writeFileSync(require("node:path").join(PROJ, "dup.js"), "let x = 1;\nlet x = 1;\n", "utf8");
  turnsScenarios = [
    [{ tool_calls: [{ name: "file_edit", args: { path: "dup.js", oldString: "let x = 1;", newString: "let x = 2;" } }] }],
    [{ tool_calls: [{ name: "file_edit", args: { path: "dup.js", oldString: "let x = 1;", newString: "let x = 2;", replace_all: true } }] }],
    [{ content: "จบ" }],
    ...Array.from({ length: 20 }, () => [{ content: "done" }]),
  ];
  turnIdx = 3;
  results = [];
  const ansE = await agentLoop("แก้ dup.js", { tools: getTools("code"), mode: "code", maxSteps: 6, noBanner: true });
  assert("E1 edit ซ้ำ → error ขอ unique context ก่อน", results.some((r) => /matches 2 places/i.test(r)));
  const dupAfter = fs.readFileSync(require("node:path").join(PROJ, "dup.js"), "utf8");
  assert("E2 replace_all ทำงาน (ทุกบรรทัดเป็น 2)", !/let x = 1;/.test(dupAfter));

  // -------- Scenario F: file_grep --------
  turnsScenarios = [
    [{ tool_calls: [{ name: "file_grep", args: { pattern: "dup" } }] }],
    [{ content: "จบ" }],
    ...Array.from({ length: 20 }, () => [{ content: "done" }]),
  ];
  turnIdx = 4;
  results = [];
  const ansF = await agentLoop("หาด้วย grep ว่า dup", { tools: getTools("code"), mode: "code", maxSteps: 4, noBanner: true });
  assert("F1 grep คืน path:line จาก lib.js", results.some((r) => /lib\.js:2:/.test(r)));

  console.log("\nผลรวม: " + (errors.length ? "FAIL — " + errors.join(", ") : "ALL PASS ✅"));
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e && e.stack || e); process.exit(1); });
