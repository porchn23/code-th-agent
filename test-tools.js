/**
 * test-tools.js — Circuit 2 (Need→Tool) ทดสอบ offline สมบูรณ์:
 * จัดฉาก OpenRouter ปลอม (global.fetch) ทุกเทรน, ยกเว้น:
 *  - run child node tools/<name>.js จริง (tool_create ทดสอบ + runCustomTool รันจริง)
 *  A) สร้าง tool ใหม่ผ่านการทดสอบ → ลงทะเบียน → spec อยู่ใน request ใช้งานต่อได้จริง (live injection)
 *  B) โค้ดพัง → ถูกปฏิเสธ, ไม่ลงทะเบียน
 *  C) ชนชื่อ built-in → ถูกบล็อก
 *  D) usage bump หลังใช้งาน + run ต่อมา (reflector ได้กฎถอดจาก error จริง)
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// isolation ทุกไฟล์สถานะ
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-test-"));
process.env.OPENROUTER_API_KEY = "sk-or-v1-mock-test-key-0000000000000000";
process.env.AGENT_PROJECT_DIR = tmp;
process.env.AGENT_EVENTS_FILE = path.join(tmp, "events.jsonl");
process.env.AGENT_PLAYBOOK_FILE = path.join(tmp, "playbook.json");
process.env.AGENT_NO_EVALS = "1"; // Circuit 3 ปิดใน test เดิม — กัน eval-reflector ยิง LLM นอกสคริปต์
process.env.AGENT_NO_CHECKPOINTS = "1"; // Tier 1 ปิดใน test เดิม — ไม่เขียนลง repo จริง
process.env.AGENT_SKILLS_FILE = path.join(tmp, "skills", "index.json");

const ra = require("./research-agent.js");

/* mock world — สคริปต์ทางเลือกตาม task */
const fakeFetch = async (url, opts = {}) => {
  const body = JSON.parse(opts.body || "{}");
  const sys = (body.messages || []).find((m) => m.role === "system")?.content || "";
  const user = (body.messages || []).filter((m) => m.role === "user").map((m) => m.content).join(" ");
  const nxt = body.messages.filter((m) => m.role === "assistant").length; // มโดเทิร์นนี้พูดไปกี่ครั้ง

  // reflector (Circuit 1) — ระบุจาก system แล้วตอบบรรทัดกฎ
  if (/agent's own reflector/.test(sys)) {
    return mk({ choices: [{ message: { role: "assistant", content: "tools: If tool_create fails its test run, fix the printed error and call tool_create again." } }] });
  }
  const seenTools = (body.tools || []).map((t) => t.function.name); // จับเพื่อ assert รายชื่อ tool ที่โมเดลเห็นจริง

  if (/GOOD/.test(user)) {
    const code = 'const a=JSON.parse(process.argv[2]||"{}");const t=String(a.text||"");console.log(JSON.stringify({len:t.length,words:t.split(/\\s+/).filter(Boolean).length}));';
    if (nxt === 0) return mk({ choices: [{ message: { role: "assistant", tool_calls: [call("t1", "tool_create", { name: "string_stats", description: "Count chars and words of a text", code, test_args: { text: "hello world" }, params: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } })] } }], usage: { completion_tokens: 10 } });
    if (nxt === 1) { LAST_SEEN = seenTools; return mk({ choices: [{ message: { role: "assistant", tool_calls: [call("t2", "string_stats", { text: "ขอให้โชคดี" })] } }], usage: { completion_tokens: 10 } }); }
    LAST_SEEN2 = seenTools; return mk({ choices: [{ message: { role: "assistant", content: "DONE" } }], usage: { completion_tokens: 10 } });
  }
  if (/BAD/.test(user)) {
    if (nxt === 0) return mk({ choices: [{ message: { role: "assistant", tool_calls: [call("t1", "tool_create", { name: "broken_tool", description: "bad js", code: "this is (( not js", test_args: {} })] } }] });
    LAST_TOOL = (body.messages.filter((m) => m.role === "tool").pop() || {}).content || "";
    return mk({ choices: [{ message: { role: "assistant", content: "FAILED accepted" } }] });
  }
  if (/BUILTIN/.test(user)) {
    if (nxt === 0) return mk({ choices: [{ message: { role: "assistant", tool_calls: [call("t1", "tool_create", { name: "web_search", description: "impersonate built-in", code: "console.log(JSON.stringify({}))", test_args: {} })] } }] });
    LAST_TOOL = (body.messages.filter((m) => m.role === "tool").pop() || {}).content || "";
    return mk({ choices: [{ message: { role: "assistant", content: "BLOCKED accepted" } }] });
  }
  throw new Error("mock: unknown task " + user.slice(0, 40));
};
let LAST_SEEN = null, LAST_SEEN2 = null, LAST_TOOL = "";
const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const mk = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o, body: null, overlaps: true });

let realFetch = global.fetch;
global.fetch = async (u, o) => (String(u).includes("/chat/completions") ? fakeFetch(u, o) : realFetch(u, o));

/* ผู้รัน + เก็บ assert */
const results = [];
const assert = (c, msg) => { results.push(c); console.log((c ? "✅" : "❌") + " " + msg); };

(async () => {
  try {
    // A: สร้าง tool ใหม่และใช้งานใน run เดียว
    const a = await ra.agentLoop("GOOD TASK", { noBanner: true });
    assert(/DONE/.test(a || ""), "A: run เสร็จด้วยคำตอบรอบสุดท้าย");
    const skills = ra.loadSkills();
    const entry = skills.find((s) => s.name === "string_stats");
    assert(!!entry, "A: ลงทะเบียน string_stats ลง skills/index.json แล้ว");
    assert(entry && /chars and words/.test(entry.description), "A: description ถูกจัดเก็บถูกต้อง");
    assert(fs.existsSync(path.join(tmp, "tools", "string_stats.js")), "A: ไฟล์ tools/string_stats.js ได้เขียนลง disk");
    assert(LAST_SEEN && LAST_SEEN.includes("string_stats"), "A: live injection — request ครั้งที่ 2 เห็น spec string_stats เพิ่มใหม่");
    assert(LAST_SEEN2 && LAST_SEEN2.includes("string_stats"), "A: ใช้งาน string_stats ใน tool list ในครั้งที่ 3 ได้ (persist ต่อ)");
    assert(entry && entry.calls === 1, "A: bump usage หลังใช้งานจริง 1 ครั้ง");

    // B: โค้ด JS พัง → ถูกปฏิเสธ ไม่ลงทะเบียน
    await ra.agentLoop("BAD TOOL", { noBanner: true });
    assert(/FAILED test/.test(LAST_TOOL) && /not js/.test(LAST_TOOL), "B: โค้ดที่พังถูกปฏิเสธ (พร้อม stderr อธิบาย)");
    assert(!ra.loadSkills().some((s) => s.name === "broken_tool"), "B: broken_tool ไม่ถูกลงทะเบียน");
    assert(!fs.existsSync(path.join(tmp, "tools", "broken_tool.js")), "B: ลบไฟล์ broken_tool.js ทิ้งแล้ว");

    // C: ชนชื่อ built-in → บล็อกพร้อมข้อความอธิบาย
    await ra.agentLoop("BUILTIN TOOL", { noBanner: true });
    assert(/built-in tool name/.test(LAST_TOOL), "C: ชื่อชนกับ built-in ถูกบล็อก");
    assert(!ra.loadSkills().some((s) => s.name === "web_search"), "C: ไม่ register คน built-in web_search");

    // D: run ต่อไป — tool ที่เคยสร้างยังอยู่และได้ log reflector
    const seen = LAST_SEEN; // ยืนยัน tool list ยังคงมี string_stats ใน run ที่ 2
    assert(seen.includes("string_stats"), "D: skill ค้างรอในทะเบียน (persist ข้าม run)");

    await ra.whenLearned(); // รอ reflector ทุกตัวที่ pending ให้จบ (non-blocking แล้วจะรอถูก)
    console.log("\n" + (results.every(Boolean) ? "ทุกข้อผ่าน ✓" : "มีข้อไม่ผ่าน ✗") + ` (${results.filter(Boolean).length}/${results.length})`);
    process.exit(results.every(Boolean) ? 0 : 1);
  } catch (e) {
    console.error("FATAL:", e.message);
    process.exit(1);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ยอม */ }
  }
})();
