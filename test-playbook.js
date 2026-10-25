/**
 * test-playbook.js — Circuit 1 (Playbook) ยอดรวม test ตาม acceptance @ docs
 * (a) event push เพิ่มบรรทัดจริง + ทุก field ครบ (b) run มี error → rule เกิดจริง
 * (c) dedupe: run ซ้ำ error เหมือนเดิม = ไม่สร้างกฎซ้ำ, เพิ่ม xN แทน
 * (d) รันหน้าได้เห็นกฎใน system prompt จริง (e) scrub secret ไม่หลุดลงไฟล์
 * รันผ่าน mock OpenRouter world ทั้งหมด — ไม่ต้องมี key/เน็ต
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ---- isolation: playbook/events เสงในไฟล์ temp ของ test เอง ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pb-test-"));
const EVENTS = path.join(tmp, "agent-events.jsonl");
const PLAYB = path.join(tmp, "agent_playbook.json");
process.env.AGENT_EVENTS_FILE = EVENTS;
process.env.AGENT_PLAYBOOK_FILE = PLAYB;
process.env.OPENROUTER_API_KEY = "sk-or-v1-mock-test-key"; // ไม่ใช้จริงใน world mock
process.env.OPENROUTER_MODEL = "nvidia/nemotron-3.5-super-vl:free";

const { agentLoop, whenLearned, loadPlaybook, playbookSummary } = require("./research-agent.js");

const RULE_TEXT = "web: If web_search returns HTTP 402, do not retry web_search. Fallback: use web_fetch directly on stable sources.";

let reqs = [];                   // จับทุก request body ที่ agent ยิง
let assistantCount = 0;          // สำหรับ script ในกิจกรรม orchestrator
const realFetch = global.fetch;

function reply(content, toolCalls) {
  const msg = { content: content ?? null };
  if (toolCalls) msg.tool_calls = toolCalls;
  return { choices: [{ message: msg }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
}
const resp = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj), json: async () => obj, body: null, headers: new Map() });

global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes("openrouter.ai")) {
    const body = JSON.parse(init.body || "{}");
    reqs.push(body);
    const sys = body.messages && body.messages[0] && body.messages[0].content || "";
    // reflector: system มีคำ "my reflector" + ไม่แนบ tools
    if (/agent's own reflector/.test(sys) && !body.tools) return resp({ choices: [{ message: { content: RULE_TEXT } }], usage: { prompt_tokens: 8, completion_tokens: 6 } });
    // sub-call วทิยูสเซิล :online ของ web_search → 402 Insufficient credits (+จำลองมี secret ยาวใน error เพื่อทดสอบ scrub)
    if (String(body.model || "").endsWith(":online")) {
      return resp({ error: { message: "Insufficient credits. Buy at settings/credits or use sk-or-v1-SECRETSHOULDNTBELOGGED." } }, 402);
    }
    // orchestrator script จริง: 0) web_search 1) web_search (query ต่างกัน เลี่ยง dedupe) 2) final
    const n = assistantCount++;
    if (n === 0) return resp(reply(null, [{ id: "c1", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "test q1" }) } }]));
    if (n === 1) return resp(reply(null, [{ id: "c2", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "test q2" }) } }]));
    return resp(reply("final summary after 402s"));
  }
  return realFetch(url, init);
};

(async () => {
  const errors = [];
  const ok = (cond, name) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) errors.push(name); };

  fs.rmSync(PLAYB, { force: true }); fs.rmSync(EVENTS, { force: true });

  // ---- run #1: 402 สองครั้ง + reflector ถอด rule ----
  reqs = []; assistantCount = 0;
  const ans = await agentLoop("find test thing about web_search", { depth: 0 });
  await whenLearned();
  ok(ans.includes("final summary"), "R1 final answer");

  const lines = fs.readFileSync(EVENTS, "utf8").split("\n").filter(Boolean);
  ok(lines.length === 1, `R2 event log: exactly 1 line (got ${lines.length})`);
  const ev = JSON.parse(lines[0]);
  ok(ev.errors.length === 2 && /402/.test(ev.errors[0]), `R3 event captures both 402 errors`);
  ok(ev.outcome === "answered-with-errors", `R4 outcome answered-with-errors (${ev.outcome})`);
  ok(ev.tools.web_search === 2, `R5 tool counts web_search=2 (${JSON.stringify(ev.tools)})`);
  ok(ev.steps === 3, `R6 steps=3 (${ev.steps})`);
  ok(!/sk-or-v1-[A-Za-z0-9]{20,}/.test(JSON.stringify(ev)), "R7 secret scrubbed in events");

  let pb = loadPlaybook();
  const learned = pb.find((r) => /Fallback: use web_fetch/.test(r.rule) && !r.rule.startsWith("seed-"));
  ok(!!learned, "R8 reflector created a rule from failed run");
  ok(learned && learned.tag === "web" && learned.usageCount === 1, `R9 rule tagged web, usageCount=1`);

  // ---- run #2: error เหมือนเดิม → dedupe = bump (ไม่สร้างกฎใหม่) ----
  reqs = []; assistantCount = 0;
  await agentLoop("find test thing about web_search", { depth: 0 });
  await whenLearned();
  pb = loadPlaybook();
  const countSame = pb.filter((r) => /Fallback: use web_fetch/.test(r.rule)).length;
  ok(countSame === 1, `R10 dedupe: exactly 1 copy of the rule (${countSame})`);
  const b = pb.find((r) => /Fallback: use web_fetch/.test(r.rule) && !r.rule.startsWith("seed-"));
  ok(b && b.usageCount === 2, `R11 bump usageCount=2 (${b && b.usageCount})`);
  ok(fs.readFileSync(EVENTS, "utf8").split("\n").filter(Boolean).length === 2, "R12 event log grows to 2");

  // ---- run #3: orchestrator ต้อง "เห็น" กฎใน system prompt จริง ----
  reqs = []; assistantCount = 0;
  await agentLoop("find test thing about web_search", { depth: 0 });
  await whenLearned();
  const sysReq = reqs.find((r) => (r.messages || []).some((m) => m.role === "system" && /playbook/.test(m.content)));
  const sys0 = sysReq.messages[0].content;
  ok(!!sysReq && /Fallback: use web_fetch/.test(sysReq.messages.find((m) => m.role === "system").content), "R13 system prompt next run includes learned rule");
  ok(!!sysReq && /never retry the same web_search/i.test(sys0), "R14 seed rules present in system prompt too");

  // ---- (f) summary API ----
  const s = playbookSummary();
  ok(s.rules.length >= 4 && s.events === 3, `R15 playbookSummary: ${s.rules.length} rules / ${s.events} events`);

  // cleanup
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(errors.length ? `\n${errors.length} FAILED` : "\nALL PASS ✅");
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
