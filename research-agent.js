/**
 * ============================================================
 *  Research Agent — single file, zero dependency (Node 18+)
 * ============================================================
 *  สถาปัตยกรรม: LLM + Tools + Loop  =  Agent
 *
 *  Loop: [
 *    1. ส่ง (task + ประวัติ + รายชื่อ tools) ให้โมเดล (stream ได้)
 *    2. โมเดลตอบกลับมาเป็น tool_call (เช่น web_fetch)
 *    3. รัน tool จริง ได้ผลลัพธ์  (เรียกคู่/หลายตัว = ขนาน, ซ้ำ = cache)
 *    4. ยัดผลลัพธ์กลับเข้า context แล้ว "ตัดของเก่า" ทิ้ง (กัน token บวม)
 *    5. วนกลับไปข้อ 1 จนกว่าโมเดลจะไม่ขอ tool อีก = เสร็จ
 *  ]
 *
 *  การรัน:  node research-agent.js "หัวข้อที่จะ research"
 * ============================================================
 */

const fs = require("node:fs");
const path = require("node:path");
const { safePathInRoot, fetchWithPublicRedirects } = require("./security-guards.js");
const os = require("node:os");
const readline = require("node:readline");
const { execFile } = require("node:child_process");

// ---------------------------------------------------------------
// CONFIG — ให้แก้ผ่าน environment variable ได้ ไม่ต้องแก้โค้ด
// ---------------------------------------------------------------
const CONFIG = {
  baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
  model: process.env.OPENROUTER_MODEL || "nvidia/nemotron-3.5-super-vl:free",
  apiKey: null, // ใส่ตอนรัน (ดู getApiKey) เพื่อไม่ commit key ลงโค้ด
  maxSteps: 12, // Safety: กัน loop ไม่รู้จบ
  fetchTimeoutMs: 20_000,
  fetchMaxChars: 4000, // Context engineering: output tool ต้องสั้น
  searchMaxChars: 3000,
  subagentFetchChars: 2600, // sub-agent นอกจักรวาลหลัก → เลี้ยงให้อ้วนน้อยกว่า
  // ---- token thrift ----
  maxHistoryMsgs: 8, // ประวัติดิบคงขนาดสั้น จนกว่าจะเพิ่มระบบสรุปบริบท
  maxHistoryChars: 1200,
  maxHistoryTotalChars: 8000,
  keepToolResults: 2, // ผล tool N อันล่าสุดเก็บเต็ม — อันเก่ากว่านั้นหั่นสั้น
  trimOldToolChars: 300,
  // ---- memory ----
  memFile: path.join(__dirname, ".agent_memory.json"),
  reportsDir: path.join(__dirname, "reports"),
};

// ---------------------------------------------------------------
// ประกาศ TOOLS — หน้าตาตามสเปก OpenAI function calling
// หัวใจ: description เขียนให้โมเดล "อ่านแล้วเลือกถูก"
// ---------------------------------------------------------------
const TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web. Use this FIRST before fetching. Returns titles, URLs and short summaries of top results. For finding sources on a topic.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query, English works best" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch a webpage by URL and return its text content (truncated). Use after web_search to read a promising source in detail. Only http/https URLs.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL starting with http:// or https://" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_datetime",
      description:
        "Get the current date/time and timezone. Cheap and instant — use it to judge how recent a source is before trusting it.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "calculator",
      description:
        "Evaluate ONE math expression exactly (floating point). Supports + - * / % and ** (power), parentheses. ALWAYS use this for any arithmetic; never compute in your head.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: 'e.g. "(1200 * 1.07) / 3"' },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "js_eval",
      description:
        "Run short JavaScript offline in a hardened sandbox (hard limit 5s) and receive its console output. The sandbox has NO filesystem, NO network, NO require/process — only plain JS builtins (Math, JSON, Date, Array, Object, Map, Set, ...). Use for text processing, date math, unit conversion, JSON manipulation, quick simulations — anything beyond one-line arithmetic. Your code MUST console.log() the results.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript source. Only plain JS builtins — require/process/fs/network are NOT available. End with console.log(...)" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_write",
      description:
        'Save a text file (markdown/txt/json/csv) into the "reports/" folder of the project. Paths outside reports/ are rejected. Use it when the user asks to keep the full report or the note is too long for chat.',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: 'relative path inside reports/, e.g. "webgpu-2026.md"' },
          content: { type: "string", description: "Full file content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_read",
      description:
        "Read a small text file (md/txt/json/csv/js/html, max ~20k chars) from the project directory. Use to re-read reports/notes you (or the user) saved earlier.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path, e.g. reports/webgpu-2026.md" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_save",
      description:
        "Persist ONE important fact to long-term memory (survives across sessions). key = short unique label (e.g. 'user-birthday'), note = the fact itself. Replaces a note with the same key. Use sparingly — only genuinely useful facts the user gives you, never trivia.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "short unique label, e.g. 'user-name'" },
          note: { type: "string", description: "the fact to remember" },
        },
        required: ["key", "note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_recall",
      description:
        "Search long-term memory by keywords (matches keys and contents). Check 'Known memory keys' in your instructions first — only call this when a key looks relevant to the current task.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "keywords, e.g. 'user name'" },
        },
        required: ["query"],
      },
    },
  },
  {
    // Multi-agent: orchestrator มอง sub-agent เป็น "tool" ตัวหนึ่ง
    type: "function",
    function: {
      name: "research_subagent",
      description:
        "Delegate ONE focused research sub-topic to a fresh sub-agent that has its own clean context. Use SPARINGLY — only when the task clearly needs it: the question splits into 2+ truly independent subtopics (e.g. compare different platforms), or a source needs deep investigation that would flood the main context. For simple, focused questions, do NOT call this — research directly with web_search/web_fetch yourself. Returns only a short report; the sub-agent's step-by-step work is hidden.",
      parameters: {
        type: "object",
        properties: {
          brief: {
            type: "string",
            description: "Self-contained research brief: sub-topic, what to find out, and any context the sub-agent needs (it cannot see the main conversation)",
          },
        },
        required: ["brief"],
      },
    },
  },
];

// ---------------------------------------------------------------
// CODE MODE TOOLS — เพิ่มเฉพาะเมื่อรันโหมด "เขียนโค้ด" (ส่งผ่าน getTools("code"))
// พื้นฐาน: SWE-agent ACI = ออกแบบ tool ให้ทำพลาดยาก (exact-match edit, แบบคำสั่งทำลาย)
// ---------------------------------------------------------------
const CODE_TOOLS = [
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in the project directory using the server process's full OS permissions. Available to admins only; command-pattern blocking is not an OS sandbox. Only use when the user explicitly asks for command execution or code verification. Returns stdout/stderr + exit code.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run, e.g. `node test-mock.js`" },
          timeoutMs: { type: "number", description: "Optional timeout in ms, default 15000, max 60000" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_edit",
      description:
        "Edit a text file in the project by exact string replacement. oldString must match the file EXACTLY (including indentation) and be unique; if it matches multiple places provide more surrounding context or set replace_all:true. Prefer several small edits over rewriting whole files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the project directory" },
          oldString: { type: "string", description: "Exact text to find (must be unique in the file unless replace_all)" },
          newString: { type: "string", description: "Replacement text (must differ from oldString)" },
          replace_all: { type: "boolean", description: "Replace every occurrence of oldString" },
        },
        required: ["path", "oldString", "newString"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_grep",
      description:
        "Search all text files in the project (regex, case-insensitive by default) for a pattern — use INSTEAD of reading whole files to find where to edit. Returns path:line matches (max 60).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for" },
          include: { type: "string", description: "Optional filename glob filter, e.g. *.js" },
        },
        required: ["pattern"],
      },
    },
  },
];

// ให้ caller เลือกชุด tool ตามโหมด (research = งานค้นคว้า, code = เพิ่มเติมงานโค้ด)
// Circuit 2 ทำให้ GETTOOLS เรียนรู้ตัวเอง: + tool_create (สร้าง tool ใหม่) และ
// + custom tools ตัวอื่นที่เคยลงทะเบียนไว้ใน skills/index.json (ทุกโหมด)
const TOOL_CREATE = {
  type: "function",
  function: {
    name: "tool_create",
    description:
      "Create a NEW persistent custom tool from JS code you write, e.g. a specific API caller or data transform that none of your existing tools cover. The tool must read its arguments as JSON from process.argv[2] and print exactly ONE JSON object to stdout. It is test-run once with test_args before registration — broken tools are rejected and nothing is registered. Registered tools persist across runs and appear as extra functions ('[custom tool] ...'). Check your tools list first; do not rebuild what already exists.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "snake_case tool name, e.g. thai_lottery_check (must NOT collide with built-ins)" },
        description: { type: "string", description: "What it does + when to use it (< 200 chars)" },
        code: { type: "string", description: "Full JS source (Node), max 10000 chars" },
        test_args: { type: "object", description: "Example args used for the mandatory test run" },
        params: { type: "object", description: "Optional JSON-schema of its arguments (object type)" },
      },
      required: ["name", "description", "code"],
    },
  },
};
const getTools = (mode, planExtra = {}) => {
  const trusted = planExtra.trusted !== false;
  const base = mode === "code" ? [...TOOL_SPECS, ...CODE_TOOLS] : [...TOOL_SPECS];
  return [
    ...base.filter((t) => trusted || t.function.name !== "run_command"),
    ...(trusted ? [TOOL_CREATE] : []),
    ...(planExtra.save ? [PLAN_SPECS[0]] : []),
    ...(planExtra.done ? [PLAN_SPECS[1]] : []),
    ...(trusted ? loadSkills() : []).map((s) => ({
      type: "function",
      function: {
        name: s.name,
        description: `[custom tool] ${s.description}`,
        parameters: s.params || { type: "object", properties: {} },
      },
    })),
  ];
};

// กฎเสริมของ Code Mode — ต่อท้าย SYSTEM_PROMPT เมื่อ ctx.mode === "code" (verification gate)
const CODE_RULES = `
== CODE MODE ==
- Understand before editing: file_grep/file_read first, then change ONE thing at a time.
- Edit with file_edit (exact oldString -> newString). Never rewrite whole files.
- VERIFICATION GATE: before claiming anything is fixed/done/works, run it with run_command (e.g. node tests, node file.js) and include the real output in your answer. If it fails, fix and re-run. A claim without command output is not allowed.`;
const MEMBER_CODE_RULES = `
== CODE MODE ==
- Understand before editing: file_grep/file_read first, then change ONE thing at a time.
- Edit with file_edit (exact oldString -> newString). Never rewrite whole files.
- Verification: inspect the edited files with file_read. Do not claim runtime verification; run_command is admin-only.`;
// Circuit 2 — สอนพอให้ model ใช้ tool_create ถูกเอง (contract: JSON argv[2] in / one JSON object out)
const TOOL_RULES = `
== EXTENDING YOURSELF (tool library) ==
- When a recurring need isn't covered by existing tools, build it once with tool_create: standalone JS reading JSON args from process.argv[2], printing exactly ONE JSON object to stdout. Pass small "test_args"; the tool is test-run automatically before registration and rejected if it fails.
- Custom tools persist in tools/ across runs and show up as extra functions prefixed "[custom tool]". Check your tools list first — never rebuild what already exists.`;
// ตัวกระตุ้นของทั้ง 3 วงจร (Compounding identity) — ฝังใน system prompt ทุก run, orchestrator เท่านั้น
const SPARK_RULES = `
== YOUR MISSION (compounding loop) ==
You are a compounding agent — every run should make the NEXT run faster, cheaper, or smarter.
Three loops to keep alive:
1. Failure → rule: your tool errors are being watched. If a repeated error appears, expect the playbook to carry a rule about it — read injected playbook rules first and follow them.
2. Need → tool: when no tool fits the job and the need will recur, build it once with tool_create instead of improvising every time.
3. Task → reusable: when you found a way that WORKS for a task type, save the key steps via memory_save so the next run starts closer to done. Only save genuinely reusable patterns, not one-off trivia.
Stay frugal with tokens — the compounding loop is only net-positive because each run spends less than the one before.`;
// Sub-agent ได้เฉพาะ tool ข้อมูลอ่านอย่างเดียว — ห้ามแตะไฟล์/memory/สร้างงานซ้อน
const SUBAGENT_EXCLUDE = new Set(["research_subagent", "memory_save", "memory_recall", "file_write", "file_read", "js_eval"]);
const SUBAGENT_TOOLS = TOOL_SPECS.filter((t) => !SUBAGENT_EXCLUDE.has(t.function.name));
const MAX_SUBAGENT_DEPTH = 1;

const SYSTEM_PROMPT = `You are a careful web-research agent.
Rules:
1. Start with web_search to find sources, then web_fetch the most promising ones to read details.
2. Cross-check at least 2 sources for important claims.
3. Prefer RECENT sources — check publication dates; for evolving topics (software support, releases) the latest date should be within the last year. Ignore stale 2023-era pages when newer info exists.
4. Always cite URLs inline like [source](url).
5. Reply in the user's language (if they ask in Thai, answer in Thai).
6. Keep answers structured and concise (headings + bullets).
7. Use research_subagent ONLY when necessary: the question genuinely splits into several independent subtopics (e.g. comparing 2+ different platforms) or needs many separate deep dives. For simple or focused questions, research directly yourself with web_search/web_fetch — no sub-agents.
8. Token thrift: never repeat an identical tool call — earlier results are still in your context and duplicates are silently replaced by a cache notice. Read each result carefully before acting. Stop as soon as you can answer well.
9. Long-term memory: if the user reveals a useful personal fact (name, preferences, projects), save it once with memory_save. If "Known memory keys" are listed below and any is clearly relevant, memory_recall it. Never save trivia.
10. If the user asks to save/report to file, use file_write (goes to reports/) and mention the file path in your answer. Use calculator (or js_eval for anything complex) for all math.`;

const SESSION_FOCUS_RULES = `
== SESSION FOCUS AND CONVERSATION CONTINUITY ==
- Keep the session's original project goal as the main objective. Later messages may clarify, correct, ask a side question, or report status; do not replace the main objective just because a message is newer.
- Carry forward earlier requirements, decisions, constraints, and unfinished work. Treat a later message as a new main task only when the user clearly changes or ends the project.
- Separate emotional tone from project content. Insults or profanity are not requirements, scope, or project feedback; ignore them and act only on any clear, actionable request in the same message. Never let abusive wording redirect the project.`;

// Strip strong insults from natural language before sending it as project context.
// Preserve inline/fenced code so code, paths, and identifiers remain exact.
const PROJECT_ABUSE_RE = /(?:ไอ้\s*)?(?:เหี้ย|สัส|ควาย|ควย|โง่|ปัญญาอ่อน|ห่วย|ไร้ประโยชน์)|\b(?:idiot|stupid|moron|useless|dumb|fuck(?:ing)?|shit|asshole|bitch)\b/giu;
const PROJECT_ABUSE_CHECK_RE = new RegExp(PROJECT_ABUSE_RE.source, "iu");
const PROJECT_ACTION_RE = /(?:แก้|ทำ|ช่วย|เพิ่ม|เปลี่ยน|ปรับ|สร้าง|ลบ|ย้าย|แยก|โฟกัส|สนใจ|ตรวจ|ทดสอบ|รัน|เปิด|ปิด|ต่อ|พัฒนา|ต้อง|ควร|อยาก|ปัญหา|บั๊ก|พัง|ผิด|ไม่ผ่าน|error|fail|bug|issue|fix|add|change|update|build|create|remove|move|check|test|run|need|should|please|want|broken)/iu;
function cleanProjectContext(value) {
  const parts = String(value ?? "").split(/(```[\s\S]*?```|`[^`]*`)/g);
  let hasAbuse = false;
  const cleaned = parts.map((part, i) => {
    if (i % 2) return part;
    if (PROJECT_ABUSE_CHECK_RE.test(part)) hasAbuse = true;
    return part.replace(PROJECT_ABUSE_RE, " ");
  }).join("").replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();
  // Drop abuse-only remarks; keep a message that still contains an actionable request or issue.
  return hasAbuse && !PROJECT_ACTION_RE.test(cleaned) ? "" : cleaned;
}

function prepareSessionHistory(history) {
  const valid = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: cleanProjectContext(m.content).slice(0, CONFIG.maxHistoryChars) }))
    .filter((m) => m.content.length > 0);
  if (!valid.length) return [];

  // Keep the first meaningful user request as the session anchor even in long chats.
  const anchor = valid.find((m) => m.role === "user");
  const recent = valid.slice(-CONFIG.maxHistoryMsgs);
  const ordered = anchor && !recent.includes(anchor) ? [anchor, ...recent].slice(0, CONFIG.maxHistoryMsgs) : recent;
  const selected = [];
  let budget = CONFIG.maxHistoryTotalChars;
  if (anchor) {
    selected.push(anchor);
    budget -= anchor.content.length;
  }
  const tail = [];
  for (let i = ordered.length - 1; i >= 0 && budget > 0; i--) {
    const msg = ordered[i];
    if (msg === anchor) continue;
    const content = msg.content.slice(0, Math.min(CONFIG.maxHistoryChars, budget));
    if (!content) continue;
    tail.unshift({ role: msg.role, content });
    budget -= content.length;
  }
  return anchor ? [anchor, ...tail] : tail;
}

// ---------------------------------------------------------------
// เล็กๆ น้อยๆ: log มีสี + ตัดข้อความยาว + ประมาณ token
// (log ทุก step = ช่วย debug ว่า "มันคิดผิดตรงไหน")
// ---------------------------------------------------------------
const C = { reset: "\x1b[0m", dim: "\x1b[2m", cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m", green: "\x1b[32m" };
const log = (color, ...a) => console.log(color + a.join(" ") + C.reset);
const truncate = (s, n) => (s.length <= n ? s : s.slice(0, n) + `\n... [truncated, ${s.length} chars total]`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const estTok = (s) => Math.ceil(String(s || "").length / 4); // heuristic ~4 chars/token

// ---------------------------------------------------------------
// LONG-TERM MEMORY — ไฟล์ JSON ธรรมดา ใช้ข้าม session ได้
// หลักคิด: memory คือ "แคชของความจำ" — key สั้น อ่านเฉพาะเมื่อเกี่ยวเนื่อง
// ---------------------------------------------------------------
function loadMemory() {
  try { return JSON.parse(fs.readFileSync(CONFIG.memFile, "utf8")) || []; } catch { return []; }
}
function saveMemory(list) {
  fs.writeFileSync(CONFIG.memFile, JSON.stringify(list, null, 2));
}

// ---------------------------------------------------------------
// TOOL: calculator / get_datetime / js_eval / file_read / file_write
// ทุกตัวราดด้วย safety: sandbox + path containment + allowlist
// ---------------------------------------------------------------
function toolGetDatetime() {
  const now = new Date();
  const off = -now.getTimezoneOffset() / 60;
  return `ISO: ${now.toISOString()} | Local: ${now.toLocaleString()} | Timezone: UTC${off >= 0 ? "+" : ""}${off}`;
}

function toolCalculator({ expression }) {
  const expr = String(expression || "").replace(/\^/g, "**").trim();
  if (!/^[-+*/%().\d eE]+$/.test(expr) || expr.length > 200) {
    throw new Error("Only plain arithmetic allowed (+ - * / % ** parentheses), max 200 chars");
  }
  const val = new Function(`"use strict"; return (${expr});`)();
  return String(val);
}

function toolJsEval({ code }, signal) {
  const src = String(code ?? "");
  if (!src.trim()) throw new Error("code is required");
  if (src.length > 20000) throw new Error("Code too long (max 20000 chars)");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-eval-"));
  const codeFile = path.join(tmp, "code.js");
  const runner = path.join(__dirname, "js-eval-runner.js");
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
  try {
    fs.writeFileSync(codeFile, src, "utf8");
    return new Promise((resolve) => {
      const child = execFile(process.execPath, [runner, codeFile], {
        timeout: 5000, cwd: tmp, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 512,
      }, (err, stdout, stderr) => {
        cleanup();
        if (signal?.aborted) return resolve("Error: js_eval cancelled");
        if (err && err.killed) return resolve("Error: js_eval timed out after 5s");
        const out = ((stdout || "") + (stderr ? "\n[stderr] " + stderr : "")).trim();
        resolve(out || "(no output — did you forget console.log?)");
      });
      // ยกเลิก child ทันทีถ้า request ถูก abort (ปุ่ม Stop)
      const onAbort = () => { try { child.kill(); } catch {} };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  } catch (e) {
    cleanup();
    throw e;
  }
}

// รากของโปรเจ็คต์ที่ tool ไฟล์/คำสั่งจะจำกัดอยู่ใน (env ทับได้เพื่อ test isolation)
const PROJECT_ROOT = process.env.AGENT_PROJECT_DIR ? path.resolve(process.env.AGENT_PROJECT_DIR) : __dirname;
const DANGER_RE = /(\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)|\bdel\s+\/[sqf]\s|\brmdir\s+\/s|\bformat\s+\w:|\bshutdown\b|:\|\s*mkfs\w*\b|\bdd\s+if=|\btaskkill\s+\/f\b|\bdiskpart\b|\b Remove-Item .*-Recurse\b)/i;

// รากประจำ run: server เลือก workspace ไหน → runTool ทุกตัวใช้ root ของ workspace นั้น
// (ไม่มี ctx.root = ใช้รากหลักของตัว agent เหมือนเดิม)
const rootOf = (ctx) => (ctx && ctx.root) || PROJECT_ROOT;

// safe path: จำกัดทุก tool ไฟล์ให้อยู่ใต้ "รากประจำ run" + แบนไฟล์ลับ/รัฐของระบบ
function safeProjectPath(rel, root) {
  const R = root || PROJECT_ROOT;
  const abs = safePathInRoot(R, String(rel || ""));
  if (/openrouter_key|node_modules|\.git|\.agent_memory|agent_playbook\.json|agent-events\.jsonl/.test(abs)) {
    throw new Error("Access denied (protected file)");
  }
  return abs;
}

const TEXT_EXT = /\.(md|txt|json|csv|js|mjs|cjs|ts|jsx|tsx|py|sh|bat|ps1|yml|yaml|html?|css)$/i;
function toolFileRead({ path: rel }, ctx) {
  const abs = safeProjectPath(rel, rootOf(ctx));
  if (!TEXT_EXT.test(abs)) throw new Error("Only text file extensions are allowed (md/txt/json/csv/js/ts/jsx/html/css/py/sh/bat/ps1/yml)");
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${rel}`);
  const text = fs.readFileSync(abs, "utf8");
  return `### FILE ${rel}\n${truncate(text, 20000)}`;
}

function toolFileWrite({ path: rel, content }, ctx) {
  const R = rootOf(ctx);
  const abs = safeProjectPath(rel, R);
  const reportsDir = path.join(R, "reports");
  if (!abs.startsWith(reportsDir + path.sep)) {
    throw new Error("Writes are only allowed inside reports/ (e.g. reports/my-report.md)");
  }
  if (!TEXT_EXT.test(abs)) throw new Error("Only text file extensions are allowed (md/txt/json/csv/js/ts/jsx/html/css/py/sh/bat/ps1/yml)");
  fs.mkdirSync(reportsDir, { recursive: true });
  const c = String(content ?? "");
  fs.writeFileSync(abs, c, "utf8");
  return `Saved ${c.length} chars to ${path.relative(R, abs).replace(/\\/g, "/")} (${path.basename(abs)})`;
}

// ---------------------------------------------------------------
// CIRCUIT 2: SELF-EXTENDING TOOLS (Need → Tool) — ต้นแบบ Alita + Voyager
// agent สร้าง tool ใหม่เองได้พร้อม "ลงทะเบียนอย่างรับผิดชอบ":
//  1) tool_create เขียน tools/<name>.js
//  2) ทดสอบรันจริง 1 ครั้งด้วย test_args ก่อนลงทะเบียน (พัง = ถูกปฏิเสธ+ลบไฟล์)
//  3) สัญญา tool ที่สร้าง: อ่าน JSON args จาก process.argv[2] → print 1 JSON object
//     ออก stdout พอดีตัว (แยก process เป็น child node เหมือน js_eval — ไม่เข้าห้องเรา)
//  4) skills/index.json = ทะเบียน persist ข้าม run + นับจำนวนการใช้จริง (calls)
// แต่ละ tool รันแยก child (timeout 10s, abort-aware) — พังไม่ดึงห้อง process หลัก
// ---------------------------------------------------------------
const SKILLS_FILE = process.env.AGENT_SKILLS_FILE || path.join(__dirname, "skills", "index.json");
const TOOLS_DIR = path.join(PROJECT_ROOT, "tools");
const SKILLS_CAP = 30;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,29}$/;

function loadSkills() {
  try {
    const list = JSON.parse(fs.readFileSync(SKILLS_FILE, "utf8"));
    return Array.isArray(list) ? list.filter((s) => s && s.name && TOOL_NAME_RE.test(s.name)) : [];
  } catch { return []; }
}
function saveSkills(list) {
  fs.mkdirSync(path.dirname(SKILLS_FILE), { recursive: true });
  fs.writeFileSync(SKILLS_FILE, JSON.stringify(list, null, 2));
}
// upsert + cap (ตัวออก = calls น้อยสุด/เก่าสุด) — กันทะเบียนบวมเหมือน playbook
function saveSkill(list, entry) {
  const i = list.findIndex((s) => s.name === entry.name);
  if (i >= 0) list[i] = entry; else list.push(entry);
  let out = list;
  if (out.length > SKILLS_CAP) {
    out = [...out]
      .sort((a, b) => ((b.calls || 0) - (a.calls || 0)) || ((b.lastUsed || 0) - (a.lastUsed || 0)))
      .slice(0, SKILLS_CAP);
  }
  saveSkills(out);
}

// ห้ามชนชื่อกับ built-in (web_search/file_edit/...)
const BUILT_IN_NAMES = new Set([...TOOL_SPECS, ...CODE_TOOLS].map((t) => t.function.name));

async function toolToolCreate({ name, description, code, test_args, params }) {
  name = String(name || "");
  if (!TOOL_NAME_RE.test(name)) throw new Error('tool name must match /^[a-z][a-z0-9_]{2,29}$/');
  if (BUILT_IN_NAMES.has(name)) throw new Error(`"${name}" is a built-in tool name — choose another name`);
  const desc = truncate(String(description || "").replace(/\s+/g, " ").trim(), 200);
  const src = String(code ?? "");
  if (!src.trim()) throw new Error("code is required");
  if (src.length > 10000) throw new Error("code too long (max 10000 chars)");
  if (/\.openrouter_key|agent_playbook|agent-events/.test(src)) throw new Error("code must not touch protected files");
  const schema = params && params.type === "object" ? params : { type: "object", properties: {} };

  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const file = path.join(TOOLS_DIR, name + ".js");
  fs.writeFileSync(file, src, "utf8");

  // ทดสอบจริง 1 ครั้ง: ผ่าน = exit 0 + stdout เป็น JSON ได้เท่านั้น
  const test = await new Promise((resolve) => {
    execFile(process.execPath, [file, JSON.stringify(test_args ?? {})], {
      cwd: PROJECT_ROOT, timeout: 10000, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 512,
    }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
  const rejectTool = (msg) => {
    try { fs.rmSync(file, { force: true }); } catch { /* ลบไม่ได้ก็ปล่อย */ }
    return `${msg}\n${truncate((test.stderr || "").trim(), 600)}`;
  };
  if (test.err && test.err.killed) return { text: rejectTool(`Tool "${name}" FAILED test: timeout after 10s (infinite loop?) — nothing registered`) };
  if (test.err) return { text: rejectTool(`Tool "${name}" FAILED test: exit code non-zero — nothing registered`) };
  let parsed;
  try { parsed = JSON.parse(test.stdout.trim()); } catch {
    return { text: rejectTool(`Tool "${name}" FAILED test: stdout was not valid JSON. Remember the contract: read JSON args from process.argv[2], print ONE JSON object to stdout — nothing registered`) };
  }

  saveSkill(loadSkills(), { name, description: desc, params: schema, createdAt: Date.now(), lastUsed: Date.now(), calls: 0 });
  const spec = { type: "function", function: { name, description: `[custom tool] ${desc}`, parameters: schema } };
  return {
    text: `### REGISTERED TOOL ${name}\nTest run output: ${truncate(JSON.stringify(parsed), 400)}\nIt is now available as an extra function call (persists across runs). Use it when relevant; rebuild it only if you need different behavior.`,
    spec,
  };
}

function runCustomTool(name, args, signal) {
  const sk = loadSkills().find((s) => s.name === name);
  if (!sk) throw new Error(`Unknown tool: ${name}`);
  const file = path.join(TOOLS_DIR, name + ".js");
  if (!fs.existsSync(file)) {
    throw new Error(`Custom tool "${name}" is registered but its file is missing under tools/ — recreate it with tool_create`);
  }
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [file, JSON.stringify(args || {})], {
      cwd: PROJECT_ROOT, timeout: 10000, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 512,
    }, (err, stdout, stderr) => {
      // นับการใช้จริงลงทะเบียน (ให้ชั้นทะเบียนรู้ว่า tool ไหนคนใช้จริง — evict อิงตรงนี้)
      const list = loadSkills();
      const s = list.find((x) => x.name === name);
      if (s) { s.lastUsed = Date.now(); s.calls = (s.calls || 0) + 1; saveSkills(list); }
      if (signal?.aborted) return resolve("Error: custom tool cancelled");
      if (err && err.killed) return resolve(`Error: custom tool "${name}" timed out after 10s`);
      const raw = String(stdout || "").trim();
      let parsed;
      try { parsed = JSON.parse(raw); } catch {
        return resolve(`Error: custom tool "${name}" did not print valid JSON to stdout${stderr ? " — " + truncate(String(stderr), 200) : ""}`);
      }
      resolve(`### TOOL ${name}\n${truncate(scrubSecrets(JSON.stringify(parsed)), 6000)}`);
    });
    // ยกเลิกตามปุ่ม Stop เหมือน tool อื่น
    const onAbort = () => { try { child.kill(); } catch { /* ปล่อย */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ---------------------------------------------------------------
// CODE MODE tools — รันคำสั่ง / แก้ไฟล์แบบ exact-match / grep โปรเจ็คต์
// หลักการ SWE-agent: ผู้โทร (โมเดล) ทำพลาดได้ยากที่สุดที่เท่าที่ออกแบบได้
// ---------------------------------------------------------------
function toolRunCommand({ command, timeoutMs }, ctx) {
  const cmd = String(command || "");
  if (!cmd.trim()) throw new Error("command required");
  if (DANGER_RE.test(cmd)) throw new Error("Blocked: potentially destructive command");
  const { exec } = require("node:child_process");
  const t = Math.min(Math.max(Number(timeoutMs) || 15000, 2000), 60000);
  const t0 = Date.now();
  return new Promise((resolve) => {
    exec(cmd, { cwd: rootOf(ctx), windowsHide: true, timeout: t, maxBuffer: 1024 * 1024, shell: true }, (err, stdout, stderr) => {
      const out = scrubSecrets(String(stdout || "").slice(0, 6000));
      const to = scrubSecrets(String(stderr || "").slice(0, 2000));
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      const tail = err && err.killed ? "…[killed on timeout]" : "";
      const result = `### RUN: ${cmd}\nexit ${code}${tail}\n${out ? "--- stdout ---\n" + out : ""}${to ? "--- stderr ---\n" + to : ""}`.trim();
      // v16 run panel: ส่งผลการรันแบบมีโครงสร้างไป UI (SSE type 'run') — log เดิมไม่กระทบ
      try { ctx?.onRun?.({ cmd, code, ms: Date.now() - t0, text: truncate(String(stdout || "") + (to ? "\n[stderr] " + to : ""), 2000) }); } catch { /* แผงรันพังไม่กระทบ run */ }
      resolve(result);
    });
  });
}

function toolFileEdit({ path: rel, oldString, newString, replace_all }, ctx) {
  const R = rootOf(ctx);
  const abs = safeProjectPath(rel, R);
  if (!TEXT_EXT.test(abs)) throw new Error("Only text files can be edited");
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${rel} (read it first with file_read)`);
  const oldStr = String(oldString ?? "");
  const newStr = String(newString ?? "");
  if (!oldStr) throw new Error("oldString is required");
  if (oldStr === newStr) throw new Error("oldString and newString must differ");
  const text = fs.readFileSync(abs, "utf8");
  let count = 0;
  let idx = text.indexOf(oldStr);
  while (idx !== -1) { count++; idx = text.indexOf(oldStr, idx + 1); }
  if (count === 0) throw new Error("oldString not found in file — file_read the file, then copy the exact text");
  if (count > 1 && !replace_all) throw new Error(`oldString matches ${count} places — add surrounding context to make it unique, or set replace_all:true`);
  const updated = replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
  fs.writeFileSync(abs, updated, "utf8");
  const replaced = (replace_all ? count : 1);
  return `Edited ${path.relative(R, abs).replace(/\\/g, "/")}: replaced ${replaced} occurrence${replaced > 1 ? "s" : ""} (${text.length} → ${updated.length} chars)`;
}

function toolFileGrep({ pattern, include }, ctx) {
  const R = rootOf(ctx);
  const re = new RegExp(String(pattern || ""), "i");
  const glob = include ? new RegExp("^" + String(include).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "␀").replace(/\*/g, "[^.]*").replace(/␀/g, ".+") + "$", "i") : null;
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      let st; try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (/^(node_modules|\.git|reports)$/.test(name)) continue; walk(p); continue; }
      if (glob && !glob.test(name)) continue;
      if (!TEXT_EXT.test(name) || /openrouter_key|\.agent_memory|agent_playbook|agent-events/.test(name)) continue;
      let lines; try { lines = fs.readFileSync(p, "utf8").split(/\r?\n/); } catch { continue; }
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${path.relative(R, p).replace(/\\/g, "/")}:${i + 1}: ${truncate(lines[i].trim(), 200)}`);
          if (hits.length >= 60) return true;
        }
      }
    }
    return false;
  };
  const full = walk(R);
  if (!hits.length) return `No matches for /${pattern}/`;
  return `### GREP /${pattern}/ (${hits.length} hits${full ? ", truncated" : ""})\n${hits.join("\n")}`;
}

function toolMemorySave({ key, note }) {
  const k = String(key || "").trim().toLowerCase().slice(0, 60);
  const v = String(note || "").trim().slice(0, 1000);
  if (!k || !v) throw new Error("Both key and note are required");
  const list = loadMemory();
  const found = list.find((m) => m.key === k);
  if (found) found.note = v; else list.push({ key: k, note: v, ts: Date.now() });
  saveMemory(list.slice(-50));
  return `Saved memory "${k}" (${list.length} notes total)`;
}

function toolMemoryRecall({ query }) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) throw new Error("query required");
  const words = q.split(/\s+/).filter(Boolean);
  const hits = loadMemory().filter((m) =>
    words.some((w) => m.key.toLowerCase().includes(w) || m.note.toLowerCase().includes(w))
  );
  if (!hits.length) return `No memory matches "${q}".`;
  return `### MEMORY MATCHES\n` + hits.map((m) => `- [${m.key}] ${m.note}`).join("\n");
}

// ---------------------------------------------------------------
// CIRCUIT 1: PLAYBOOK — agent เรียนกฎจากความล้มเหลวของตัวเอง (Compounding)
//  agent-events.jsonl  = event log ต่อรัน (append-only, cap 500 บรรทัด)
//  agent_playbook.json = กฎที่ "เรียนรู้ได้" {rule, tag, usageCount, lastSeen}
//  Reflector  = 1 LLM call เฉพาะตอน run มี error → แปลความผิดพลาดเป็นกฎ 1 บรรทัด
//  Curator    = โค้ดล้วน (dedupe เหมือนกัน = bump usageCount) ไม่ใช้ LLM ไม่ติดค่า token
//  Injection  = 5 กฎที่เกี่ยวกับงาน ~400 tok ใส่ system prompt "orchestrator เท่านั้น"
// ความปลอดภัย: ห้ามมี secret (sk-or-...) ติดไปกับ event/playbook — scrub ทุกครั้ง
// ---------------------------------------------------------------
const EVENTS_FILE = process.env.AGENT_EVENTS_FILE || path.join(__dirname, "agent-events.jsonl");
const PLAYBOOK_FILE = process.env.AGENT_PLAYBOOK_FILE || path.join(__dirname, "agent_playbook.json");
const EVENTS_CAP = 500;
const PLAYBOOK_CAP = 50;
const RULE_CHARS = 220;
const INJECT_BUDGET_TOK = 400;
const RULE_TAGS = new Set(["web", "provider", "tools", "context", "model"]);

const scrubSecrets = (s) => String(s ?? "").replace(/sk-or-[A-Za-z0-9_-]+/g, "sk-or-***");

const SEED_RULES = [
  { id: "seed-402", tag: "web", rule: "If web_search returns HTTP 402 (insufficient credits), never retry the same web_search. Fallback: web_fetch stable sources directly (en.wikipedia.org, raw.githubusercontent.com) or tell the user the search backend has no credit." },
  { id: "seed-404", tag: "web", rule: "If web_fetch fails on guessed/made-up URLs twice in one run, stop guessing URL patterns — get real URLs from web_search results first." },
  { id: "seed-502", tag: "provider", rule: "HTTP 502/429 from the provider is already retried with backoff. After 3 consecutive failures stop and suggest the user switch model in the UI dropdown." },
];

function scrubRule(s) {
  return scrubSecrets(String(s || "")).replace(/\s+/g, " ").trim().slice(0, RULE_CHARS);
}

function loadPlaybook() {
  try {
    const j = JSON.parse(fs.readFileSync(PLAYBOOK_FILE, "utf8"));
    if (Array.isArray(j.rules)) return j.rules;
  } catch { /* ไม่มีไฟล์ → seed */ }
  const rules = SEED_RULES.map((r) => ({ ...r, usageCount: 1, lastSeen: Date.now(), created: Date.now() }));
  savePlaybook(rules);
  return rules;
}

function savePlaybook(rules) {
  fs.writeFileSync(PLAYBOOK_FILE, JSON.stringify({ rules, _cap: PLAYBOOK_CAP }, null, 2));
}

// Curator: พิสูจน์ "กฎเดียวกัน" ด้วย token overlap (Jaccard ≥ 0.6) — ซ้ำ = bump usageCount
function addRule(rawText, tag = "tools") {
  const rule = scrubRule(rawText);
  if (!rule) return null;
  const rules = loadPlaybook();
  const tok = (s) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const a = tok(rule);
  const jack = (x, y) => {
    const b = tok(y);
    const inter = [...x].filter((w) => b.has(w)).length;
    return inter / (x.size + b.size - inter);
  };
  const found = rules.find((r) => jack(a, String(r.rule || "")) >= 0.6);
  let bumped = false;
  if (found) {
    found.usageCount += 1;
    found.lastSeen = Date.now();
    if (RULE_TAGS.has(tag)) found.tag = tag;
    bumped = true;
  } else {
    rules.push({
      id: "r-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      rule, tag: RULE_TAGS.has(tag) ? tag : "tools",
      usageCount: 1, lastSeen: Date.now(), created: Date.now(),
    });
    if (rules.length > PLAYBOOK_CAP) {
      rules.sort((x, y) => y.usageCount * 1e12 + y.lastSeen - (x.usageCount * 1e12 + x.lastSeen));
      rules.length = PLAYBOOK_CAP; // กัน playbook บวม: คอยรอดเป็นกฎที่ใช้บ่อย/ใหม่
    }
  }
  savePlaybook(rules);
  return bumped ? { bumped, rule: found } : { bumped, rule: rules[rules.length - 1] };
}

// เลือกกฎเกี่ยวเนื่องกับงาน (word overlap × usage × ความสด) — ไม่เกิน budget token
function loadPlaybookForTask(task) {
  const rules = loadPlaybook();
  if (!rules.length) return "";
  const tWords = new Set(String(task).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const scored = rules.map((r) => {
    const rw = new Set(String(r.rule).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
    let overlap = 0;
    for (const w of rw) if (tWords.has(w)) overlap++;
    const fresh = Date.now() - (r.lastSeen || 0) < 7 * 86400e3 ? 1 : 0;
    return { r, score: overlap * 10 + Math.min(r.usageCount, 5) + fresh };
  }).sort((x, y) => y.score - x.score);
  let out = "", n = 0;
  for (const { r } of scored) {
    if (n >= 5) break;
    const line = `- [${r.tag}] ${r.rule}\n`;
    if (estTok(out + line) > INJECT_BUDGET_TOK) break;
    out += line; n++;
  }
  return n ? `Learned rules from past failed runs (playbook) — follow these when relevant:\n${out}` : "";
}

// Reflector: 1 LLM call (เท่านั้น) — "run นี้พังเพราะอะไร → กฎ 1 บรรทัดสำหรับรันหน้า"
const REFLECT_SYSTEM = `You are the agent's own reflector. A research run just finished with errors. Write ONE short, general rule (max 120 chars, imperative) that would prevent or handle this kind of failure next time. Format exactly: TAG: rule-text — TAG must be one of: web, provider, tools, context, model. Output only that line.`;

async function reflectOnRun(userTask, errors) {
  const msg = await callLLM({
    model: CONFIG.model,
    messages: [
      { role: "system", content: REFLECT_SYSTEM },
      { role: "user", content: `Task: ${truncate(String(userTask || ""), 200)}\nErrors observed:\n${errors.map((e, i) => `${i + 1}. ${e}`).join("\n")}` },
    ],
    temperature: 0,
    max_tokens: 100,
  });
  const m = /(\w+)\s*:\s*(.+)/s.exec(String(msg.content || "").trim());
  if (!m) return null;
  const tg = m[1].toLowerCase();
  return { tag: RULE_TAGS.has(tg) ? tg : "tools", rule: scrubRule(m[2]) };
}

// บันทึก event ของรัน + (มี error →) ให้ Reflector ถอดกฎ ก่อนจบ process ขนานไป
function learnFromRun(ctx, userTask) {
  try {
    appendEvent({
      runId: ctx.runId,
      ts: Date.now(),
      task: scrubSecrets(userTask).slice(0, 200),
      steps: ctx.stepsUsed || 0,
      tools: ctx.tools || {},
      outcome: ctx.outcome || "ok",
      errors: (ctx.errors || []).slice(-8),
      tok: ctx.tok || 0,
      model: CONFIG.model,
    });
  } catch { /* logging ห้ามสะเทือนหลัก */ }
  if (!(ctx.errors || []).length) return Promise.resolve();
  return (async () => {
    try {
      const r = await reflectOnRun(userTask, ctx.errors);
      if (r && r.rule) {
        const res = addRule(r.rule, r.tag);
        ctx.log(C.dim, `  📓 playbook ${res.bumped ? `⬆ bump ×${res.rule.usageCount}` : "➕ new rule"}: [${res.rule.tag}] ${truncate(res.rule.rule, 80)}`);
      }
    } catch (e) {
      ctx.log(C.red, `  📓 reflect skipped (non-fatal): ${e.message}`);
    }
  })();
}

function appendEvent(ev) {
  try {
    let lines = [];
    if (fs.existsSync(EVENTS_FILE)) lines = fs.readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean);
    lines.push(JSON.stringify(ev));
    if (lines.length > EVENTS_CAP) lines = lines.slice(-EVENTS_CAP);
    fs.writeFileSync(EVENTS_FILE, lines.join("\n") + "\n");
  } catch { /* บันทึกไม่ได้ไม่ต้องรื้องาน */ }
}

let LAST_LEARN = Promise.resolve(); // CLI ใช้ tie เสร็จ constructor ก่อน exit

function playbookSummary() {
  let events = 0;
  try { events = fs.readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean).length; } catch {}
  const rules = loadPlaybook().map(({ rule, tag, usageCount, lastSeen }) => ({ rule, tag, usageCount, lastSeen }));
  return { rules, events };
}

function printPlaybook() {
  const { rules, events } = playbookSummary();
  console.log(`📓 Playbook — ${rules.length} rules (events logged: ${events})\n`);
  for (const r of rules)
    console.log(`  [${r.tag}] ${r.rule}\n        ×${r.usageCount} uses, last seen ${new Date(r.lastSeen).toLocaleString()}`);
}

// ---------------------------------------------------------------
// วงจร 3: Task→Eval — งานที่สำเร็จแบบมีขั้นตอน → ถอด checklist กลายๆ
// (run หน้าที่งานคล้ายกัน จะได้ "จุดเริ่ม/สิ่งที่ตรวจ" ฟรี ๆ ใน system prompt)
// ---------------------------------------------------------------
const EVALS_FILE = process.env.AGENT_EVALS_FILE || path.join(__dirname, "agent_evals.json");
const EVALS_CAP = 20; // กันบวมเหมือน playbook
const EVAL_INJECT_TOK = 300;
// สวิตช์ปิด: env AGENT_NO_EVALS=1 — อ่านสด ๆ ใน learnEvalFromRun (toggle runtime ได้)

const EVAL_SYSTEM = `You are the agent's own eval curator. A task just succeeded. Write a compact reusable checklist for this TYPE of task (max 3 steps, max 140 chars total) + keywords identifying this task type. Format exactly: PATTERN: keywords | CHECK: step1; step2; step3. Output only that line.`;

// แตกคำจากภาษาไทย+อังกฤษ (ทุก token ยาวเกิน 2) → เช็คความคล้ายของงาน
const taskWords = (s) => (String(s || "").match(/[a-zA-Z0-9\u0E00-\u0E7F]{2,}/g) || []).map((w) => w.toLowerCase());

function loadEvals() {
  try {
    const list = JSON.parse(fs.readFileSync(EVALS_FILE, "utf8"));
    return Array.isArray(list) ? list.filter((e) => Array.isArray(e.keywords) && Array.isArray(e.check)) : [];
  } catch { return []; }
}
function saveEvals(list) {
  fs.mkdirSync(path.dirname(EVALS_FILE), { recursive: true });
  fs.writeFileSync(EVALS_FILE, JSON.stringify(list, null, 2));
}

// jaccard ของ 2 อาร์เรย์คำ — ใช้ dedupe checklist ซ้ำ (โค้ดเท่านั้น ไม่ใช้ LLM)
const jac = (a, b) => {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
};

function addEval(rawKeywords, rawCheck) {
  const keywords = [...new Set(taskWords(rawKeywords.join(" ")))].slice(0, 6);
  const check = rawCheck.map((s) => String(s).trim()).filter(Boolean).slice(0, 3).map((s) => s.slice(0, 80));
  const list = loadEvals();
  const found = list.find((e) => jac(keywords, e.keywords) >= 0.5);
  if (found) {
    found.usageCount = (found.usageCount || 1) + 1;
    found.lastSeen = Date.now();
    saveEvals(list);
    return { bumped: true, eval: found };
  }
  const entry = { id: `e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, keywords, check, usageCount: 1, lastSeen: Date.now() };
  list.push(entry);
  if (list.length > EVALS_CAP)
    list.sort((a, b) => b.usageCount * 1e12 + b.lastSeen - (a.usageCount * 1e12 + a.lastSeen)), saveEvals(list.slice(0, EVALS_CAP));
  else saveEvals(list);
  return { bumped: false, eval: entry };
}

// เลือก eval ที่ "งานคล้ายกัน" ด้วย intersection ของคำ + budget ~EVAL_INJECT_TOK
function loadEvalsForTask(task) {
  const ws = taskWords(task);
  const scored = loadEvals()
    .map((e) => { const inter = e.keywords.filter((k) => ws.includes(k)).length; return inter ? { e, s: inter * 10 + Math.min(e.usageCount, 5) } : null; })
    .filter(Boolean)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  if (!scored.length) return "";
  const lines = [];
  for (const { e } of scored) {
    const line = `- When done: ${e.check.join("; ")} (task type: ${e.keywords.join(", ")})`;
    if (estTok(lines.join("\n") + line) > EVAL_INJECT_TOK) break;
    lines.push(line);
  }
  if (!lines.length) return "";
  return `\n\nEval hints (how similar past tasks were verified):\n${lines.join("\n")}`;
}

// Eval curator — 1 LLM call เท่านั้น (mirror ของ reflectOnRun แต่ฝั่งงานสำเร็จ)
async function evalOnRun(userTask) {
  const msg = await callLLM({
    model: CONFIG.model,
    messages: [
      { role: "system", content: EVAL_SYSTEM },
      { role: "user", content: `Task: ${truncate(String(userTask || ""), 200)}` },
    ],
    temperature: 0,
    max_tokens: 120,
  });
  const m = /PATTERN:\s*(.+?)\s*\|\s*CHECK:\s*(.+)/s.exec(String(msg.content || "").trim());
  if (!m) return null;
  const keywords = taskWords(m[1]).slice(0, 6);
  const check = m[2].split(";").map((s) => s.trim()).filter(Boolean).slice(0, 3).map((s) => s.slice(0, 80));
  if (!keywords.length || !check.length) return null;
  return { keywords, check };
}

// Gate: งานสำเร็จจริง + มีเครื่องมือ + ไม่ใช่งานเล็ก (steps>=3) — กัน checklist ป่องโดยใช้เปล่า
// (อ่าน env สด ๆ ทุกครั้ง — ให้ toggle runtime ได้ เช่น ใน tests)
function learnEvalFromRun(ctx, userTask, depth) {
  if (process.env.AGENT_NO_EVALS === "1" || depth !== 0) return Promise.resolve();
  if (ctx.outcome !== "ok" || (ctx.stepsUsed || 0) < 3 || !Object.keys(ctx.tools || {}).length) return Promise.resolve();
  return (async () => {
    try {
      const r = await evalOnRun(userTask);
      if (r) {
        const res = addEval(r.keywords, r.check);
        ctx.log(C.dim, `  🎯 eval ${res.bumped ? `⬆ bump ×${res.eval.usageCount}` : "➕ new checklist"}: ${res.eval.check.join(" → ").slice(0, 90)}`);
      }
    } catch (e) {
      ctx.log(C.red, `  🎯 eval skipped (non-fatal): ${e.message}`);
    }
  })();
}

function evalSummary() {
  let ok = 0, totalTok = 0;
  try {
    for (const line of fs.readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean)) {
      try { const ev = JSON.parse(line); if (ev.outcome === "ok") { ok++; totalTok += ev.tok || 0; } } catch { /* โยนบรรทัดเสมอเมื่อได้รู้ */ }
    }
  } catch { /* ไม่มี log ก็ไม่ต้องฟ้อง */ }
  return {
    evals: loadEvals().map(({ keywords, check, usageCount, lastSeen }) => ({ keywords, check, usageCount, lastSeen })),
    runs: { ok, avgTok: ok ? Math.round(totalTok / ok) : 0 },
  };
}

// ---------------------------------------------------------------
// Tier 1 — ความสะดวกของผู้ใช้: 📝 AGENTS.md rules / 📋 Plan mode / 🔒 Checkpoints
// (เพิ่มเติมจาก 3 วงจรของ agent เอง — ส่วนนี้คือ "ราวกันตก" ของผู้ใช้)
// ---------------------------------------------------------------
const AGENTS_FILE = process.env.AGENT_AGENTS_FILE || path.join(__dirname, "AGENTS.md");

// กฎที่ "ผู้ใช้เขียนเอง" (ต่างจาก playbook ที่ agent เรียนเอง) — inject ทุก run depth 0
function loadAgentsRules() {
  try {
    const t = fs.readFileSync(AGENTS_FILE, "utf8").trim();
    return t ? t.slice(0, 8000) : "";
  } catch { return ""; }
}

// ---- Plan mode: agent วางแผนก่อน → ผู้ใช้กดอนุมัติในแชต → รันตามแผน ----
const PLAN_FILE = process.env.AGENT_PLAN_FILE || path.join(__dirname, "agent_plan.json");
const PLAN_RULES = `
== PLAN MODE ==
- งานนี้อยู่ในโหมดวางแผน: research/อ่านไฟล์ได้เท่านั้น ห้าม run_command/file_edit/file_write
- เมื่อเข้าใจงานพอแล้ว ให้เรียก tool save_plan ครั้งเดียวด้วย {title, steps:[...]} (3-8 steps รูปธรรม ตรวจสอบได้)
- ห้ามทำงานตามแผนเอง — จบคำตอบด้วยข้อความสั้นว่าแผนพร้อมอนุมัติแล้ว (ผู้ใช้จะกดปุ่มอนุมัติในหน้าเว็บ)`;
function loadPlan() {
  try {
    const p = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
    return p && Array.isArray(p.steps) ? p : null;
  } catch { return null; }
}
function savePlan({ title, steps } = {}, ctx) {
  const list = (Array.isArray(steps) ? steps : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 10)
    .map((text) => ({ text: text.slice(0, 200), done: false }));
  if (list.length < 2) throw new Error("plan needs at least 2 steps");
  const plan = { id: "p-" + Date.now().toString(36), ts: Date.now(), title: String(title || "").trim().slice(0, 120) || "แผนงาน", steps: list };
  fs.mkdirSync(path.dirname(PLAN_FILE), { recursive: true });
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));
  try { if (ctx && ctx.onPlan) ctx.onPlan(plan); } catch {}
  return plan;
}
function planMarkDone({ step } = {}, ctx) {
  const n = Number(step);
  const plan = loadPlan();
  if (!plan) throw new Error("No approved plan to update");
  const s = plan.steps[n - 1];
  if (!s) throw new Error(`step ${n} doesn't exist (plan has ${plan.steps.length} steps)`);
  s.done = true;
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));
  try { if (ctx && ctx.onPlan) ctx.onPlan(plan); } catch {}
  return `✓ step ${n} marked done: ${s.text.slice(0, 80)}`;
}
// spec ของ tool ฝั่งแผน — ต่อท้าย tool list เฉพาะเมื่อ planMode (save_plan) / รันตามแผนอนุมัติ (plan_done)
const PLAN_SPECS = [
  {
    type: "function",
    function: {
      name: "save_plan",
      description: "PLAN MODE: record the execution plan after finishing your research. Call exactly once, then end with a short 'plan is ready for approval' message. Do NOT execute anything.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short plan title" },
          steps: { type: "array", items: { type: "string" }, description: "Ordered steps (3-8), each concrete and checkable" },
        },
        required: ["title", "steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_done",
      description: "Mark one step of the APPROVED plan as complete. Call right after finishing that step so the user sees live progress.",
      parameters: {
        type: "object",
        properties: { step: { type: "integer", description: "Step number, 1-based" } },
        required: ["step"],
      },
    },
  },
];

// ---- Checkpoints: snapshot ก่อนแตะไฟล์ → ดู diff / ย้อนกลับได้ (เหมือน /rewind ของ Claude) ----
const CKPT_DIR = process.env.AGENT_CHECKPOINT_DIR || path.join(__dirname, "agent_checkpoints");
const CKPT_FILE = process.env.AGENT_CHECKPOINT_FILE || path.join(__dirname, "agent_checkpoints.json");
const CKPT_CAP = 30;
const CKPT_SKIP = /(^|[\\\/])(node_modules|\.git|agent_checkpoints|tools|skills|reports)([\\\/]|$)|(^|[\\\/])(agent_[\w-]+\.(json|jsonl)|\.agent_memory\.json|\.openrouter_key|agent-app\.vbs)$/i;

function loadCkpts() {
  try { const l = JSON.parse(fs.readFileSync(CKPT_FILE, "utf8")); return Array.isArray(l) ? l : []; } catch { return []; }
}
function saveCkpts(list) {
  fs.mkdirSync(path.dirname(CKPT_FILE), { recursive: true });
  fs.writeFileSync(CKPT_FILE, JSON.stringify(list, null, 2));
}
function addBackup(abs, rec) {
  try {
    const buf = fs.readFileSync(abs);
    if (buf.length > 300000) return; // กันไฟล์ใหญ่ผิดปกติเต็มดิสก์
    const dir = path.join(CKPT_DIR, rec.id);
    fs.mkdirSync(dir, { recursive: true });
    const bk = path.join(dir, "f" + rec.files.length + ".bak");
    fs.writeFileSync(bk, buf);
    rec.files.push({ rel: path.relative(rec.root, abs).replace(/\\/g, "/"), backup: bk });
  } catch { /* snapshot ต้องไม่มีสิทธิ์ทำ run พัง */ }
}
// snapshot ไฟล์เดียว (ก่อน file_edit/file_write)
function snapshotOne(abs, kind, ctx) {
  const rec = { id: "ck-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), runId: ctx.runId, kind, files: [], root: rootOf(ctx) };
  addBackup(abs, rec);
  return rec.files.length ? rec : null;
}
// snapshot ทั้งโปรเจ็กต์ (ก่อน run_command — ไม่รู้ล่วงหน้าว่าคำสั่งจะแก้อะไร)
function snapshotProject(ctx) {
  const R = rootOf(ctx);
  const rec = { id: "ck-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), runId: ctx.runId, kind: "run", files: [], root: R };
  try {
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        if (rec.files.length >= 120) return;
        const abs = path.join(dir, name);
        const relw = path.relative(R, abs);
        if (CKPT_SKIP.test(relw)) continue;
        let st = null;
        try { st = fs.lstatSync(abs); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) { walk(abs); continue; }
        if (TEXT_EXT.test(abs) && st.size <= 300000) addBackup(abs, rec);
      }
    };
    walk(R);
  } catch { /* ไม่มีข้อกังวลเรื่อง fail ที่นี่ */ }
  return rec.files.length ? rec : null;
}
// hook ก่อนรัน tool ที่แก้ไฟล์ — sync เสมอ เกิด error ก็ต้องไม่พัง run
function checkpointBefore(name, args, ctx) {
  try {
    if (process.env.AGENT_NO_CHECKPOINTS === "1" || ctx.depth !== 0) return;
    let rec = null;
    if ((name === "file_edit" || name === "file_write") && args && args.path)
      rec = snapshotOne(safeProjectPath(String(args.path), rootOf(ctx)), "file", ctx);
    else if (name === "run_command") rec = snapshotProject(ctx);
    if (!rec) return;
    const list = loadCkpts();
    list.unshift(rec);
    const dropped = list.length > CKPT_CAP ? list.splice(CKPT_CAP) : [];
    saveCkpts(list);
    for (const d of dropped) { try { fs.rmSync(path.join(CKPT_DIR, d.id), { recursive: true, force: true }); } catch {} }
    ctx.log(C.dim, `  🔒 checkpoint (${rec.files.length} file${rec.files.length > 1 ? "s" : ""}) ก่อน ${name}`);
  } catch { /* ไม่มีข้อกังวลเรื่อง snapshot */ }
}
// diff แบบเรียบง่าย (LCS + ยุบบล็อกบรรทัดเดิมยาว ๆ) → [{t:'same'|'add'|'del', text}]
function diffText(aText, bText) {
  const a = String(aText || "").split("\n"), b = String(bText || "").split("\n");
  const N = 600;
  if (a.length > N || b.length > N) {
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < Math.min(a.length, b.length) - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return [{ t: "same", text: `≈${p} บรรทัดต้นเหมือนกัน` }, { t: "mod", text: `เปลี่ยน ~${a.length - p - s} → ${b.length - p - s} บรรทัด (ไฟล์ใหญ่เกิน diff แบบละเอียด)` }];
  }
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ t: "same", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "del", text: a[i++] });
    else out.push({ t: "add", text: b[j++] });
  }
  while (i < m) out.push({ t: "del", text: a[i++] });
  while (j < n) out.push({ t: "add", text: b[j++] });
  // ยุบบล็อก "same" ที่ยาวเกิน 6 บรรทัด (เหลือ 2 แรก + หมายเหตุ + 2 ท้าย)
  const c = [];
  for (let k = 0; k < out.length; k++) {
    if (out[k].t !== "same") { c.push(out[k]); continue; }
    let e = k;
    while (e + 1 < out.length && out[e + 1].t === "same") e++;
    if (e - k + 1 > 6) {
      c.push(out[k], out[k + 1], { t: "same", text: `… (อีก ${e - k - 3} บรรทัดเหมือนเดิม) …` }, out[e - 1], out[e]);
    } else for (let x = k; x <= e; x++) c.push(out[x]);
    k = e;
  }
  return c.slice(0, 500);
}
function diffCheckpoint(id) {
  const rec = loadCkpts().find((r) => r.id === id);
  if (!rec) throw new Error("checkpoint not found: " + id);
  const R = rec.root || PROJECT_ROOT; // record เก่า (v15) ไม่มี root → ใช้รากหลัก
  return rec.files.map(({ rel, backup }) => {
    const before = fs.existsSync(backup) ? fs.readFileSync(backup, "utf8") : "";
    const abs = path.resolve(R, rel);
    const after = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    return { rel, diff: diffText(before, after) };
  });
}
function restoreCheckpoint(id) {
  const rec = loadCkpts().find((r) => r.id === id);
  if (!rec) throw new Error("checkpoint not found: " + id);
  const R = rec.root || PROJECT_ROOT;
  const restored = [];
  for (const { rel, backup } of rec.files) {
    if (!fs.existsSync(backup)) continue;
    const abs = path.resolve(R, rel);
    if (!abs.startsWith(R + path.sep)) continue; // กัน path escape
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(backup, abs);
    restored.push(rel);
  }
  return restored;
}

function printEvals() {
  const s = evalSummary();
  console.log(`🎯 Evals — ${s.evals.length} checklists (ok runs: ${s.runs.ok}, avg ~${s.runs.avgTok} tok/run)\n`);
  for (const e of s.evals)
    console.log(`  (${e.keywords.join(", ")})\n     ✓ ${e.check.join("\n     ✓ ")}\n        ×${e.usageCount} uses`);
}

// ---------------------------------------------------------------
// หา API key: env -> ไฟล์ .openrouter_key -> ถามผู้ใช้แล้วบันทึกไว้
// ---------------------------------------------------------------
async function getApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const keyFile = path.join(__dirname, ".openrouter_key");
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, "utf8").trim();
  // ถ้าไม่ได้รันแบบโต้ตอบใน terminal (เช่น เป็น server/background) — fail fast
  // พร้อมวิธีแก้ไขเป็นข้อ ๆ สื่อสารทันที แทนการแขวนรอให้คนนึกว่า "รันไม่ได้"
  if (!process.stdin.isTTY) {
    throw new FatalError(
      "API key not found! Fix with ONE of these:\n" +
      "  1) setx OPENROUTER_API_KEY \"sk-or-v1-...\"   (then open a NEW terminal)\n" +
      '  2) Set-Content -Path .openrouter_key -Value "sk-or-v1-..." -NoNewline\n' +
      '  3) Interactive once: node research-agent.js "hello"  (asks key, saves it)'
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const key = await new Promise((r) => rl.question("Paste your OpenRouter API key: ", r));
  rl.close();
  if (!key.startsWith("sk-")) throw new Error("That doesn't look like an OpenRouter key (should start with sk-)");
  fs.writeFileSync(keyFile, key.trim());
  log(C.dim, `Key saved to ${keyFile} (add it to .gitignore!)`);
  return key.trim();
}

// ---------------------------------------------------------------
// โครงสร้างผล error ล้มเหลวถาวร (ไม่ต้อง retry เช่น 401 key ผิด)
// ---------------------------------------------------------------
class FatalError extends Error {}

// ---------------------------------------------------------------
// HTTP: ส่ง request ไป provider (ทั้งโหมด JSON และ stream ใช้ร่วมกัน)
// หลักการ: อย่าป้องกัน error ให้ error กลายเป็นข้อมูลที่โมเดลใช้แก้
// ---------------------------------------------------------------
async function sendRequest(body, { signal } = {}) {
  // signal ภายนอก (ปุ่ม Stop) + timeout 60s → รวมเป็น signal เดียว
  const timeout = AbortSignal.timeout(60_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(CONFIG.baseUrl + "/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: combined,
  });
  if (res.status === 401 || res.status === 403) {
    throw new FatalError(`Auth failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new Error(`Transient HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new FatalError(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res;
}

// เรียก LLM แบบ JSON ธรรมดา พร้อม retry
async function callLLM(body, { retries = 4, signal, logger = log } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await sendRequest(body, { signal });
      const data = await res.json();
      return data.choices[0].message;
    } catch (err) {
      if (signal?.aborted) throw err; // ถูกยกเลิก → ไม่ retry
      if (err instanceof FatalError || attempt === retries) throw err;
      const wait = 1000 * 2 ** (attempt - 1);
      logger(C.dim, `  (attempt ${attempt} failed: ${err.message} — retrying in ${wait}ms)`);
      await sleep(wait);
    }
  }
}

// ---------------------------------------------------------------
// STREAMING: parse SSE จาก OpenRouter — ได้ content แต่ละ delta ปล่อยผ่าน
// onDelta(text) ทันที (typewriter effect ที่ UI) ; onDelta(null) = "ล้างข้อความค้าง"
// เก็บ tool_calls ที่ไหลมาเป็น ๆ มาต่อกันให้ครบก่อนคืนค่า
// ---------------------------------------------------------------
function makeSSEAccumulator(onDelta) {
  const acc = { content: "", usage: null };
  const tcs = new Map();
  let buf = "";
  const feed = (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
      if (d && d.content) { acc.content += d.content; if (onDelta) onDelta(d.content); }
      if (d && Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          if (!tcs.has(i)) tcs.set(i, { id: tc.id || `call_${i}`, type: "function", index: i, function: { name: "", arguments: "" } });
          const t = tcs.get(i);
          if (tc.id) t.id = tc.id;
          if (tc.function && tc.function.name) t.function.name += tc.function.name;
          if (tc.function && tc.function.arguments) t.function.arguments += tc.function.arguments;
        }
      }
      if (ev.usage) acc.usage = ev.usage; // OpenRouter ส่ง usage ใน chunk สุดท้าย
    }
  };
  const message = () => {
    if (!tcs.size) return { content: acc.content };
    return {
      content: acc.content || null,
      // เรียงตาม index ที่โมเดลสั่ง — ไม่ใช่ sort ตาม id (id เป็น string สุ่ม → ลำดับผิด)
      // index เป็น field ภายในของเราเท่านั้น → ตัดออกก่อนส่ง API
      tool_calls: [...tcs.values()]
        .sort((a, b) => a.index - b.index)
        .map(({ index, ...t }) => t),
    };
  };
  return { feed, message };
}

async function callLLMStream(body, onDelta, { retries = 4, signal, logger = log } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    let emitted = false;
    const wrapDelta = (t) => { emitted = true; onDelta(t); };
    try {
      const res = await sendRequest({ ...body, stream: true }, { signal });
      const acc = makeSSEAccumulator(wrapDelta);
      if (res.body && typeof res.body.getReader === "function") {
        // แบบสมจริง: ไหลมาทีละ chunk → ปล่อย delta สดๆ
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          acc.feed(dec.decode(value, { stream: true }));
        }
      } else {
        // mock/สภาพทดสอบ: ได้ text เป็นก้อนใหญ่ครั้งเดียว
        acc.feed(await res.text());
      }
      const msg = acc.message();
      if (acc.usage) {
        logger(C.dim, `  ⛁ ${acc.usage.prompt_tokens ?? "?"} tok in / ${acc.usage.completion_tokens ?? "?"} tok out`);
        return { msg, usage: acc.usage };
      }
      return { msg };
    } catch (err) {
      if (emitted) onDelta(null); // stream พังกลางทาง → ให้ UI ล้างข้อความค้างก่อน retry
      if (signal?.aborted) throw err; // ถูกยกเลิก → ไม่ retry
      if (err instanceof FatalError || attempt === retries) throw err;
      const wait = 1000 * 2 ** (attempt - 1);
      logger(C.dim, `  (attempt ${attempt} failed: ${err.message} — retrying in ${wait}ms)`);
      await sleep(wait);
    }
  }
}

// TOOL: web_fetch — ดึงหน้าเว็บแล้วแปลง HTML เป็นข้อความเท่านั้น
// Safety: อนุญาตเฉพาะ http/https (กัน file:, gopher:)+ timeout
// Context: ตัดเหลือไม่เกิน maxChars (sub-agent ใช้งบเล็กกว่า) เพื่อไม่รื้อ context

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

async function toolWebFetch({ url }, maxChars = CONFIG.fetchMaxChars, signal) {
  const timeout = AbortSignal.timeout(CONFIG.fetchTimeoutMs);
  const res = await fetchWithPublicRedirects(url, {
    headers: { "User-Agent": "Mozilla/5.0 research-agent-tutorial" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("html") && !ct.includes("text")) {
    return `[${ct} — binary/content type not supported, try another source]`;
  }
  const text = stripHtml(await res.text());
  return `### CONTENT OF ${url}\n${truncate(text, maxChars)}`;
}

// TOOL: web_search — ใช้เคล็ดลับของ OpenRouter: ต่อ model ด้วย ":online"
// เปิด web plugin (มีให้ในทุกโมเดลของ OpenRouter โดยไม่ต้องมี key เพิ่ม)
// ยิง request เล็กๆ 1 รอบ ให้โมเดล "search แล้วสรุป top results พร้อม URL"
async function toolWebSearch({ query }, ctx) {
  const msg = await callLLM({
    model: CONFIG.model + ":online",
    messages: [
      {
        role: "user",
        content: `Search the web now for: "${query}". List the top 5 results. For each one give: title, URL, and a one-sentence summary. Output only the list.`,
      },
    ],
    max_tokens: 800,
  }, { signal: ctx?.signal, logger: ctx?.log });
  return `### SEARCH RESULTS for "${query}"\n${truncate(msg.content||"", CONFIG.searchMaxChars)}`;
}

// ---------------------------------------------------------------
// MULTI-AGENT: sub-agent = agentLoop ครั้งหนึ่งด้วย context สดใหม่
// คุณสมบัติสำคัญ:
//  - sub-agent เห็นเฉพาะ "brief" ที่ orchestrator เขียน ไม่เห็นบทสนทนาหลัก
//  - orchestrator เห็นเฉพาะ "รายงานสรุป" ที่ sub-agent ตอบ ไม่เห็นขั้นตอนย่อย
//    => context ของทั้งสองฝั่งสะอาดอยู่เสมอ (จุดขายจริงของ multi-agent)
//  - depth limit = ห้าม spawn ซ้อนกันไม่รู้จบ
//  - งบของ sub-agent เคร่งกว่า: fetch สั้นลง + ไม่มี history/memory preload
// ---------------------------------------------------------------
async function runSubagent(brief, ctx) {
  const label = `${C.dim}[sub-agent d${ctx.depth}]${C.reset} `;
  ctx.log(C.cyan, `  ${label}spawning d${ctx.depth + 1} for brief: "${brief.slice(0, 80)}..."`);
  const report = await agentLoop(brief, {
    depth: ctx.depth + 1,
    tools: SUBAGENT_TOOLS,
    maxSteps: 6,
    noBanner: true,
    temp: ctx.temp,
    signal: ctx.signal,   // กด Stop → ยกเลิก sub-agent ด้วย
    onLog: ctx.onLog,     // log ของ sub-agent ยังไหลขึ้น UI เหมือนเดิม
    trusted: ctx.trusted,
  });
  return `### SUB-AGENT REPORT\n${truncate(report, 4000)}`;
}

async function runTool(name, args, ctx) {
  if (!ctx.trusted && (name === "run_command" || name === "tool_create" || loadSkills().some((s) => s.name === name)))
    throw new Error("This tool is available to admins only");
  if (name === "web_fetch") return toolWebFetch(args, ctx.fetchChars, ctx.signal);
  if (name === "web_search") return toolWebSearch(args, ctx);
  if (name === "get_datetime") return toolGetDatetime();
  if (name === "calculator") return toolCalculator(args);
  if (name === "js_eval") return toolJsEval(args, ctx.signal);
  if (name === "file_read") return toolFileRead(args, ctx);
  if (name === "file_write") return toolFileWrite(args, ctx);
  if (name === "run_command") return toolRunCommand(args, ctx);
  if (name === "file_edit") return toolFileEdit(args, ctx);
  if (name === "file_grep") return toolFileGrep(args, ctx);
  if (name === "memory_save") return toolMemorySave(args);
  if (name === "memory_recall") return toolMemoryRecall(args);
  if (name === "save_plan") {
    const p = savePlan(args, ctx);
    ctx.log(C.dim, `  📋 plan saved (${p.steps.length} steps) → รอผู้ใช้อนุมัติ`);
    return `Plan "${p.title}" saved with ${p.steps.length} steps. End now with ONE short message saying the plan is ready and waiting for the user to approve it in the web UI.`;
  }
  if (name === "plan_done") return planMarkDone(args, ctx);
  // Circuit 2: สร้าง tool ใหม่ → ถ้าผ่านการทดสอบ = inject spec เข้า tool list ของ run นี้ทันที
  if (name === "tool_create") {
    const r = await toolToolCreate(args);
    if (r.spec) {
      try {
        ctx.toolsRef.push(r.spec);
        ctx.log(C.dim, `  🛠 live-spec: ${r.spec.function.name} added to this run's tool list`);
      } catch { /* ค่าปลอดภัยเสมอ: spec จะพร้อมใช้ตั้งแต่ run ถัดไปถูกมากไป */ }
    }
    return r.text;
  }
  if (name === "research_subagent") {
    if (ctx.depth + 1 > MAX_SUBAGENT_DEPTH) {
      throw new Error("Depth limit reached: this agent cannot spawn further sub-agents");
    }
    if (!args.brief) throw new Error("Missing required argument: brief");
    return runSubagent(args.brief, ctx);
  }
  // Circuit 2: ชื่อไม่ใช่ built-in → หาจาก skills library แล้วรันแบบ child process
  if (loadSkills().some((s) => s.name === name)) return runCustomTool(name, args, ctx.signal);
  throw new Error(`Unknown tool: ${name}`);
}

// ---------------------------------------------------------------
// MAIN LOOP — หัวใจของ agent ทั้งหมดอยู่หมวดนี้
// agentLoop = ฟังก์ชันเดียวที่ทั้ง orchestrator และ sub-agent ใช้ร่วมกัน
// ต่างกันแค่ depth (0 = orchestrator), tools, และ maxSteps
//
// โหมดพิเศษ (option):
//  - history: Q&A เก่าของแชตเดียวกัน (compiled + ตัดสั้นแล้วจากผู้เรียก)
//  - temp:    temperature ที่ UI ตั้ง (นอกจากนั้น null)
//  - onDelta: ถ้ามี → ตัวโมเดลจะโดนเรียกแบบ stream:true และไหลข้อความออก
//             ทันทีทีละคำ (null event = ล้างข้อความค้างเมื่อโมเดลสลับไป tool call)
//  - onLog:   callback รับ log ทุกบรรทัด (แทนการ patch console.log แบบ global)
//  - signal:  AbortSignal ภายนอก → กด Stop แล้วหยุดจริงทั้ง LLM call และ tool
// ---------------------------------------------------------------
async function agentLoopCore(userTask, {
  depth = 0, tools, maxSteps = CONFIG.maxSteps,
  noBanner = false, temp = null, history = [], onDelta = null,
  onLog = null, signal = null, mode = "research",
  planMode = false, approvedPlan = null, onPlan = null,
  root = null, onRun = null, trusted = true,
} = {}) {
  const tools2 = tools ?? getTools(mode); // โหมด code = เพิ่ม run_command/file_edit/file_grep
  const tag = depth > 0 ? `${C.dim}[sub d${depth}]${C.reset} ` : "";
  const ctx = {
    depth, temp, tag, signal, onLog, mode, trusted,
    // logger ของ agent: พิมพ์ลง terminal เหมือนเดิม + ส่งไป UI ถ้ามี onLog
    // (เลิก patch console.log แบบ global แล้ว — request ซ้อนกันจะชนกัน)
    log: (color, ...a) => {
      const line = color + a.join(" ") + C.reset;
      console.log(line);
      if (onLog) onLog(line);
    },
    fetchChars: depth > 0 ? CONFIG.subagentFetchChars : CONFIG.fetchMaxChars,
    cache: new Map(), // dedupe: key = name + args → ผลเดิม ไม่ต้องยิงซ้ำ (ประหยัด token)
    tok: 0,
    // Circuit 1 สะสมข้อมูลตลอดรัน: tools ที่ใช้, error ที่โดน (สำหรับ event log + reflector)
    runId: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    errors: [], tools: {}, stepsUsed: 0, outcome: null, t0: Date.now(),
    // Circuit 2: อ้างอิงชุด tool ของ run นี้ (tool_create สำเร็จ = push spec เข้านี่แบบ live)
    toolsRef: tools2,
    onPlan, // Tier 1 plan mode: save_plan/plan_done → callback (server ส่ง SSE ไป UI)
    root: root ? path.resolve(root) : null, // v16 workspace: run นี้ทำงานในโปรเจค/วงจรไหน (null = ตัว agent เอง)
    onRun, // v16 run panel: ผล run_command จริง ๆ ส่งให้ UI แสดงเป็นแผง
  };
  LAST_CTX = ctx; // ให้ wrapper (agentLoop) เรียนรู้จาก ctx ของรันนี้ได้แม้ throw กลางทาง

  // system prompt: ผนวกวันที่ + memory keys + playbook เฉพาะ orchestrator (sub-agent ตัดของฟุ่มเฟือย)
  let system = SYSTEM_PROMPT;
  if (depth === 0) system += SESSION_FOCUS_RULES;
  if (mode === "code" && depth === 0) system += trusted ? CODE_RULES : MEMBER_CODE_RULES;
  if (depth === 0) system += trusted ? TOOL_RULES : "\n== CUSTOM TOOL ACCESS ==\nCustom tools can only be created or run by admins.\n";
  if (depth === 0) system += trusted ? SPARK_RULES : SPARK_RULES.replace("build it once with tool_create instead of improvising every time.", "custom tools are admin-only; ask an admin to create a recurring tool.");
  if (depth === 0) {
    system += `\n\nCurrent date: ${new Date().toISOString().slice(0, 10)}.`;
    const keys = loadMemory().map((m) => m.key);
    if (keys.length) system += `\nKnown memory keys: ${keys.join(", ")}.`;
    const pb = loadPlaybookForTask(userTask);
    if (pb) {
      system += `\n\n${pb}`;
      ctx.log(C.dim, `📓 playbook injected (~${estTok(pb)} tok)`);
    }
    const ev = loadEvalsForTask(userTask); // วงจร 3 — checklist จากงานคล้ายที่ผ่านมา
    if (ev) {
      system += ev;
      ctx.log(C.dim, `🎯 eval hints injected (~${estTok(ev)} tok)`);
    }
    const ag = loadAgentsRules(); // Tier 1 — กฎของผู้ใช้จาก AGENTS.md (inject ทุก run)
    if (ag) {
      system += `\n\n# Project rules (AGENTS.md — กฎของผู้ใช้ บังคับก่อนเสมอ)\n${ag}`;
      ctx.log(C.dim, `📝 AGENTS.md injected (~${estTok(ag)} tok)`);
    }
    if (planMode) {
      system += PLAN_RULES;
      ctx.log(C.dim, `📋 plan mode เปิด — วางแผนก่อน ห้ามลงมือแก้ไข`);
    }
    if (approvedPlan) {
      const steps = (approvedPlan.steps || [])
        .map((s, i) => `- [${s.done ? "x" : " "}] ${i + 1}. ${s.text}`)
        .join("\n");
      system += `\n\n# Approved plan (ผู้ใช้อนุมัติแล้ว) — ทำตามขั้นตอน ตามลำดับ\nและเรียก plan_done {step: N} ทันทีที่ขั้นใดเสร็จ เพื่อให้หน้าเว็บโชว์ progress สด\n${steps}`;
      ctx.log(C.dim, `📋 approved plan injected (${(approvedPlan.steps || []).length} steps)`);
    }
  }

  // messages = context ทั้งหมดที่โมเดลมองเห็น (system -> history -> user -> tool results -> ...)
  const sessionHistory = prepareSessionHistory(history);
  const messages = [
    { role: "system", content: system },
    ...sessionHistory,
    { role: "user", content: userTask },
  ];

  if (!noBanner) {
    ctx.log(C.cyan, `Task: ${userTask}`);
    ctx.log(C.cyan, `Model: ${CONFIG.model} | maxSteps: ${maxSteps}${temp != null ? ` | temp: ${temp}` : ""}${mode === "code" ? " | mode: 💻 code" : ""}`);
  }
  const specsTok = estTok(JSON.stringify(tools2)); // ค่าคงที่ของ schema tools ต่อ run

  // ------------------------------------------------------------- LOOP
  for (let step = 1; step <= maxSteps; step++) {
    ctx.log(C.dim, `\n${tag}── step ${step} ───────────────────────────────`);
    ctx.stepsUsed = step;

    // token thrift: ตัดผล tool อันเก่าเก็บแค่หัวเหตุผลเดียวกันกับ "ช่วยไม่หาย" แต่ context เล็กลงเยอะ
    trimToolResults(messages);

    const inTok = specsTok + estTok(JSON.stringify(messages));
    ctx.log(C.dim, `  ${tag}⛁ ~${inTok} tok in`);
    ctx.tok += inTok;

    const body = { model: CONFIG.model, messages, tools: tools2 };
    if (temp != null) body.temperature = temp;

    let msg, usageTok = 0;
    if (onDelta) {
      const r = await callLLMStream(body, onDelta, { signal, logger: ctx.log });
      msg = r.msg; usageTok = r.usage ? r.usage.completion_tokens : 0;
    } else {
      msg = await callLLM(body, { signal, logger: ctx.log });
    }
    const outTok = usageTok || estTok(msg.content || "") + estTok(JSON.stringify(msg.tool_calls || []));
    ctx.log(C.dim, `  ${tag}⛁ ~${outTok} tok out`);
    ctx.tok += outTok;

    // สำคัญ: เก็บเฉพาะฟิลด์ที่ API ต้องการ (โมเดลบางตัวแอบแนบ field แปลกๆ มา)
    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
    });

    //  กรณีที่ 1: โมเดลขอใช้ tool
    if (msg.tool_calls?.length) {
      if (onDelta) onDelta(null); // ล้างข้อความค้างที่ไหลออกไปแล้วก่อน — รอบนี้ไม่ใช่คำตอบสุดท้าย
      ctx.log(C.yellow, `  ${tag}Model requests: ${msg.tool_calls.map((t) => t.function.name).join(", ")}`);
      const results = await runToolCalls(msg.tool_calls, ctx);
      for (const r of results)
        messages.push({ role: "tool", tool_call_id: r.id, content: truncate(r.result, 8000) });
      continue; // กลับไปถามโมเดลขั้นตอนถัดไป
    }

    //  กรณีที่ 2: ไม่มี tool call อีกแล้ว = โมเดลพร้อมตอบ -> เสร็จ
    if (!noBanner) {
      ctx.log(C.green, "\n══════════ FINAL ANSWER ══════════\n");
    }
    ctx.outcome = ctx.errors.length ? "answered-with-errors" : "ok";
    ctx.log(C.dim, `${tag}⛁ session total ~${ctx.tok} tok`);
    return msg.content;
  }
  // ถ้าวนครบ maxSteps แล้วยังต้องการ tool อยู่ = ปลอดภัยกว่าหยุด
  const stopMsg = `Stopped: reached max steps (${maxSteps}).`;
  ctx.log(C.red, `\n${tag}Reached maxSteps (${maxSteps}) — stopping to avoid runaway loop.`);
  ctx.outcome = "maxsteps";
  ctx.log(C.dim, `${tag}⛁ session total ~${ctx.tok} tok`);
  return stopMsg;
}

// ปิดงาน Circuit 1: บันทึก event + (ถ้ามี error) สะท้อนแบบ 1 LLM call — fire-and-forget ไม่กระทบผู้ใช้
let LAST_CTX = null; // ctx ของรันล่าสุด (ให้ wrapper จัดการตอน throw กลางทาง)

function finalizeLearning(ctx, userTask, depth) {
  if (depth !== 0 || !ctx) return;
  try {
    if (!ctx.outcome) ctx.outcome = ctx.signal?.aborted ? "stopped" : "crashed";
  } catch {}
  try { LAST_LEARN = Promise.all([learnFromRun(ctx, userTask), learnEvalFromRun(ctx, userTask, depth)]); } catch { /* ห้ามพังเพราะสะท้อน */ }
}

// agentLoop = agentLoopCore + Circuit 1 learn-hook ที่ห้ามพลาด (จับทั้ง return ปกติและ throw เช่น กด Stop)
async function agentLoop(userTask, opts = {}) {
  const depth = opts.depth ?? 0;
  const focusedTask = cleanProjectContext(userTask);
  if (!focusedTask) {
    return "ถ้าต้องการให้ช่วยงานในโปรเจกต์ โปรดบอกสิ่งที่อยากให้ทำหรือแก้ต่อได้เลยครับ";
  }
  const focusedOpts = { ...opts, history: prepareSessionHistory(opts.history) };
  try {
    return await agentLoopCore(focusedTask, focusedOpts);
  } finally {
    try { finalizeLearning(depth === 0 ? LAST_CTX : null, focusedTask, depth); } catch { /* ไม่มีข้อผิดพลาดจากการเรียนรู้ */ }
  }
}

// ตัด chicken feed เก่า: tool message ยกเว้น 2 ทีล่าสุด → เหลือหัวสั้น ๆ
function trimToolResults(messages) {
  const idx = [];
  messages.forEach((m, i) => { if (m.role === "tool") idx.push(i); });
  const keepFrom = idx.length - CONFIG.keepToolResults;
  for (let k = 0; k < keepFrom; k++) {
    const i = idx[k];
    if (messages[i].content.length > CONFIG.trimOldToolChars) {
      messages[i] = {
        ...messages[i],
        content: messages[i].content.slice(0, CONFIG.trimOldToolChars) + " …[trimmed to save context]",
      };
    }
  }
}

// ---------------------------------------------------------------
// TOOL DISPATCH: เรียกขนานได้ (Promise.all) + dedupe cache ต่อ run
// เผื่อโมเดลถามซ้ำ query เดิม — cache เลย ไม่เสียค่าใช้จ่าย/เวลา
// ---------------------------------------------------------------
async function runToolCalls(toolCalls, ctx) {
  const parsed = toolCalls.map((tc) => {
    let args = {};
    try { args = JSON.parse(tc.function.arguments || "{}"); }
    catch { /* โมเดลบางทีเขียน JSON พัง — ให้ error กลับไปเอง */ }
    ctx.log(C.yellow, `  ${ctx.tag}→ ${tc.function.name}(${truncate(JSON.stringify(args), 120)})`);
    return { tc, args, key: tc.function.name + "::" + JSON.stringify(args) };
  });
  return Promise.all(parsed.map(async ({ tc, args, key }) => {
    if (ctx.cache.has(key)) {
      ctx.log(C.dim, `  ${ctx.tag}↻ cached (${tc.function.name}) — reused to save cost`);
      return { id: tc.id, result: ctx.cache.get(key) };
    }
    let result;
    try {
      checkpointBefore(tc.function.name, args, ctx); // Tier 1: snapshot ก่อนแตะไฟล์ (ห้ามทำ run พัง — จับ error ข้างในแล้ว)
      result = await runTool(tc.function.name, args, ctx);
    } catch (err) {
      // Error Handling: ไม่ crash — ห่อ error กลับเข้า context
      // ให้โมเดล "เห็นข้อผิดพลาดแล้ววางแผนแก้เอง" + Circuit 1 เก็บไปเรียนเป็นกฎ
      result = `Error: ${err.message}`;
      ctx.errors.push(scrubSecrets(err.message).slice(0, 200));
      if (ctx.errors.length > 8) ctx.errors.shift();
      ctx.log(C.red, `  ${ctx.tag}✗ ${result}`);
    }
    ctx.cache.set(key, result);
    ctx.tools[tc.function.name] = (ctx.tools[tc.function.name] || 0) + 1;
    return { id: tc.id, result };
  }));
}

// ---------------------------------------------------------------
// ENTRY POINT — รับงานจากผู้ใช้ แล้วส่งให้ orchestrator
// ---------------------------------------------------------------
async function main() {
  // CLI: โชว์ playbook/evals ที่ agent เรียนไว้โดยไม่เสียค่า token (ไม่ต้องมี key)
  if (process.argv.includes("--evals")) return printEvals();
  if (process.argv.includes("--playbook")) return printPlaybook();
  CONFIG.apiKey = await getApiKey();
  const task = process.argv.slice(2).join(" ");
  if (!task) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    task = await new Promise((r) => rl.question("Research topic: ", r));
    rl.close();
  }
  const answer = await agentLoop(task, { depth: 0 });
  console.log(answer);
  await Promise.race([LAST_LEARN, sleep(15000)]); // ให้ reflector เขียน playbook ลงไฟล์เสร็จก่อนปิด
}

// ----- รันโหมด CLI เฉพาะเมื่อถูกเรียกตรงๆ เช่น `node research-agent.js ...`
// (ถูก require โดย server.js จะไม่รัน เพื่อให้เรียก agentLoop เองได้)
if (require.main === module) {
  main().catch((e) => {
    console.error("FATAL:", e.message);
    process.exit(1);
  });
}

module.exports = { CONFIG, agentLoop, prepareSessionHistory, getApiKey, log, C, truncate, loadPlaybookForTask, addRule, loadPlaybook, playbookSummary, reflectOnRun, learnFromRun, getTools, CODE_TOOLS, SUBAGENT_TOOLS, loadSkills, loadEvalsForTask, addEval, loadEvals, evalSummary, loadAgentsRules, AGENTS_FILE, PLAN_FILE, loadPlan, getToolsPlanSpec: PLAN_SPECS, loadCkpts, checkpointBefore, restoreCheckpoint, diffCheckpoint, diffText, whenLearned: () => LAST_LEARN };
