/**
 * test-server-mock.js â€” à¸—à¸”à¸ªà¸­à¸š Web UI + SSE stream à¸‚à¸­à¸‡ server.js à¹‚à¸”à¸¢à¹„à¸¡à¹ˆà¹ƒà¸Šà¹‰ key à¸ˆà¸£à¸´à¸‡
 * (à¹à¸™à¸§à¸„à¸´à¸”à¹€à¸”à¸µà¸¢à¸§à¸à¸±à¸š test-mock.js: à¹à¸­à¸šà¹à¸—à¸™ global.fetch à¹ƒà¸«à¹‰à¹€à¸›à¹‡à¸™ "à¹‚à¸¥à¸à¸ˆà¸³à¸¥à¸­à¸‡"
 *  à¹à¸¥à¹‰à¸§ require server.js à¸•à¸±à¸§à¸ˆà¸£à¸´à¸‡à¹ƒà¸«à¹‰à¸§à¸´à¹ˆà¸‡ à¹à¸¥à¹‰à¸§ POST /api/ask à¹€à¸Šà¹‡à¸„ stream à¸—à¸µà¹ˆà¹„à¸”à¹‰)
 *
 * à¸ªà¸´à¹ˆà¸‡à¸—à¸µà¹ˆ test à¸™à¸µà¹‰à¸žà¸´à¸ªà¸¹à¸ˆà¸™à¹Œ:
 *   1) GET / à¸„à¸·à¸™ ui.html
 *   2) POST /api/ask â†’ SSE stream à¸¡à¸µ log/answer à¸„à¸£à¸š
 *   3) concurrent guard â†’ request à¸—à¸µà¹ˆ 2 à¹„à¸”à¹‰ 429
 *   4) server à¹„à¸¡à¹ˆ patch console.log à¹à¸šà¸š global (log à¹à¸•à¹ˆà¸¥à¸° request à¹„à¸¡à¹ˆà¸Šà¸™à¸à¸±à¸™)
 *   5) à¸à¸” Stop (client abort) â†’ agent à¸«à¸¢à¸¸à¸”à¸ˆà¸£à¸´à¸‡ à¹„à¸¡à¹ˆà¸¢à¸´à¸‡ LLM à¸•à¹ˆà¸­
 *   6) parallel tool_calls à¸à¸¥à¸±à¸šà¸¡à¸²à¸•à¸²à¸¡à¸¥à¸³à¸”à¸±à¸š index à¸—à¸µà¹ˆà¹‚à¸¡à¹€à¸”à¸¥à¸ªà¸±à¹ˆà¸‡
 *
 * exit code: 0 = à¸œà¹ˆà¸²à¸™à¸—à¸¸à¸à¸‚à¹‰à¸­ / 1 = à¸¡à¸µà¸‚à¹‰à¸­à¸—à¸µà¹ˆ fail
 */

process.env.OPENROUTER_API_KEY = "sk-mock-test";
process.env.AGENT_EVENTS_FILE = require("node:path").join(require("node:os").tmpdir(), "agent-ev-test.jsonl");
process.env.AGENT_PLAYBOOK_FILE = require("node:path").join(require("node:os").tmpdir(), "agent-pb-test.jsonl");
process.env.AGENT_NO_EVALS = "1"; // Circuit 3 ปิดใน test เดิม — กัน eval-reflector ยิง LLM นอกสคริปต์
process.env.AGENT_NO_AUTH = "1"; // v16 ปิดใน test เดิม — ไม่ทำ login flow ใน suite เดิม (test-auth จัดการเอง)
process.env.AGENT_NO_CHECKPOINTS = "1"; // Tier 1 ปิดใน test เดิม — ไม่เขียนลง repo จริง

// à¸ˆà¸±à¸š console.log "à¸•à¸±à¸§à¸ˆà¸£à¸´à¸‡" à¹„à¸§à¹‰à¸à¹ˆà¸­à¸™ à¹€à¸žà¸·à¹ˆà¸­à¸¢à¸·à¸™à¸¢à¸±à¸™à¸§à¹ˆà¸² server à¹„à¸¡à¹ˆà¸¡à¸² patch à¸¡à¸±à¸™
const PRISTINE_CONSOLE_LOG = console.log;

// ------- à¹‚à¸¥à¸à¸ˆà¸³à¸¥à¸­à¸‡ (script à¹€à¸”à¸µà¸¢à¸§à¸à¸±à¸š test-mock.js) -------
// à¸ˆà¸³à¸¥à¸­à¸‡ latency à¸‚à¸­à¸‡ LLM à¸ˆà¸£à¸´à¸‡ (à¸–à¹‰à¸²à¸•à¸­à¸šà¹€à¸£à¹‡à¸§à¹€à¸à¸´à¸™ à¸ˆà¸°à¸à¸¥à¸·à¸™à¸—à¸¸à¸ logic à¸—à¸µà¹ˆà¸à¸±à¸™à¸žà¸£à¹‰à¸­à¸¡à¸à¸±à¸™/guard)
const slow = (r, ms = 400, signal) => new Promise((ok, bad) => {
  const t = setTimeout(() => ok(r), ms);
  if (signal) {
    const onAbort = () => { clearTimeout(t); bad(new Error("aborted")); };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
});
const llmResponse = (content, toolCalls) => ({
  status: 200, ok: true, text: async () => "",
  json: async () => ({ choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }] }),
});
const toolCall = (name, args) => ({ id: "call_" + Math.random().toString(36).slice(2, 8), type: "function", function: { name, arguments: JSON.stringify(args) } });

// à¸ˆà¸³à¸¥à¸­à¸‡ developer à¹à¸šà¸š SSE stream (server à¸¢à¸´à¸‡ stream:true à¸•à¸­à¸™à¸£à¸µà¹€à¸¥à¸¢à¹Œà¹ƒà¸«à¹‰ UI)
const sseChunksFrom = (message) => {
  let s = "data: " + JSON.stringify({ choices: [{ delta: { role: "assistant" } }] }) + "\n\n";
  if (message.content) {
    const mid = Math.max(1, Math.floor(message.content.length / 2));
    s += "data: " + JSON.stringify({ choices: [{ delta: { content: message.content.slice(0, mid) } }] }) + "\n\n";
    s += "data: " + JSON.stringify({ choices: [{ delta: { content: message.content.slice(mid) } }] }) + "\n\n";
  }
  (message.tool_calls || []).forEach((tc, i) => {
    s += "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] } }] }) + "\n\n";
  });
  s += "data: [DONE]\n\n";
  return s;
};
const llmStream = (message) => ({
  status: 200, ok: true, headers: { get: () => "text/event-stream" },
  text: async () => sseChunksFrom(message),
});
const MAIN_SCRIPT = [
  llmResponse(null, [toolCall("research_subagent", { brief: "Research WebGPU support in Chrome" })]),
  llmResponse(null, [toolCall("research_subagent", { brief: "Research WebGPU support in Firefox" })]),
  llmResponse("## WebGPU Support Summary\n\n**Chrome:** ships WebGPU on Windows/macOS since v113. [src](https://example.com/webgpu-chrome)\n**Firefox:** shipped on Windows, expansion ongoing."),
];
const SUB_SCRIPT = [
  llmResponse(null, [toolCall("web_search", { query: "WebGPU availability" })]),
  llmResponse("Report: available in Chromium browsers and Firefox (see example.com)."),
];
// à¸‡à¸²à¸™à¸Šà¹‰à¸²: turn 0 à¸‚à¸­ tool â†’ à¸–à¹‰à¸² agent à¸¢à¸±à¸‡à¸§à¸´à¹ˆà¸‡à¸•à¹ˆà¸­à¸ˆà¸°à¸¢à¸´à¸‡ LLM à¸£à¸­à¸šà¸—à¸µà¹ˆ 2 (à¹ƒà¸Šà¹‰à¸—à¸”à¸ªà¸­à¸šà¸›à¸¸à¹ˆà¸¡ Stop)
const SLOW_SCRIPT = [
  llmResponse(null, [toolCall("get_datetime", {})]),
  llmResponse("SHOULD NEVER REACH HERE"),
];
// à¸‡à¸²à¸™à¸—à¸”à¸ªà¸­à¸šà¸¥à¸³à¸”à¸±à¸š tool: 2 tool call à¸žà¸£à¹‰à¸­à¸¡à¸à¸±à¸™ à¹‚à¸”à¸¢ id à¹€à¸£à¸µà¸¢à¸‡à¸•à¸²à¸¡à¸•à¸±à¸§à¸­à¸±à¸à¸©à¸£à¹à¸¢à¸à¸ˆà¸²à¸ index
const ORDER_SCRIPT = [
  llmResponse(null, [
    { id: "call_ZZZ", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://example.com/x" }) } },
    { id: "call_AAA", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://example.com/y" }) } },
  ]),
  llmResponse("order test done"),
];
const FAKE_PAGES = {
  "https://example.com/x": "<html><body><h1>t</h1><p>c</p></body></html>",
  "https://example.com/y": "<html><body><h1>u</h1><p>d</p></body></html>",
};
// web_fetch uses DNS-pinned node:https requests; keep those deterministic and offline too.
const EventEmitter = require("node:events");
require("node:dns").promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
require("node:https").request = (url, _options, onResponse) => {
  const req = new EventEmitter();
  req.end = () => {
    const response = new EventEmitter();
    const page = FAKE_PAGES[String(url)] || "<html><body>mock page</body></html>";
    response.statusCode = 200;
    response.headers = { "content-type": "text/html" };
    onResponse(response);
    process.nextTick(() => { response.emit("data", Buffer.from(page)); response.emit("end"); });
  };
  req.destroy = (err) => { if (err) req.emit("error", err); };
  return req;
};

// à¸šà¸±à¸™à¸—à¸¶à¸à¸—à¸¸à¸ request à¹„à¸› LLM (à¸™à¸±à¸š call + à¹€à¸à¹‡à¸š messages à¸‚à¸­à¸‡ request à¸–à¸±à¸”à¹„à¸›à¹„à¸§à¹‰à¸•à¸£à¸§à¸ˆà¸¥à¸³à¸”à¸±à¸š tool)
const llmCalls = [];
const toolOrderSeen = [];

const realFetch = global.fetch; // request à¹„à¸›à¸¢à¸±à¸‡ server à¸‚à¸­à¸‡à¹€à¸£à¸²à¹€à¸­à¸‡ (localhost) à¸•à¹‰à¸­à¸‡à¹ƒà¸Šà¹‰à¸ˆà¸£à¸´à¸‡
global.fetch = async (url, opts = {}) => {
  const urlStr = String(url);
  if (urlStr.startsWith("http://localhost")) return realFetch(url, opts);
  if (urlStr.startsWith("https://openrouter.ai")) {
    const body = JSON.parse(opts.body);
    if (body.model.endsWith(":online")) return llmResponse("1. WebGPU overview â€” https://example.com/x â€” Chromium & Firefox ship it.");
    const lastUser = [...body.messages].reverse().find((m) => m.role === "user")?.content || "";
    const count = body.messages.filter((m) => m.role === "assistant").length;
    llmCalls.push({ at: Date.now(), task: lastUser, turn: count });
    const script = /SLOW STOP TEST/i.test(lastUser) ? SLOW_SCRIPT
      : /ORDER TEST/i.test(lastUser) ? ORDER_SCRIPT
      : /Summarize WebGPU support on Chrome and Firefox/.test(lastUser) ? MAIN_SCRIPT
      : /Research WebGPU support in (Chrome|Firefox)/.test(lastUser) ? SUB_SCRIPT
      : MAIN_SCRIPT;
    const chosen = script[Math.min(count, script.length - 1)];
    // à¹€à¸à¹‡à¸šà¸¥à¸³à¸”à¸±à¸š tool result à¸—à¸µà¹ˆà¸–à¸¹à¸à¸ªà¹ˆà¸‡à¸à¸¥à¸±à¸šà¹ƒà¸«à¹‰à¹‚à¸¡à¹€à¸”à¸¥ (request à¸–à¸±à¸”à¹„à¸›à¸‚à¸­à¸‡ task à¹€à¸”à¸´à¸¡)
    if (count >= 1) {
      const tms = body.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
      if (tms.length && !toolOrderSeen.some((x) => x.task === lastUser)) toolOrderSeen.push({ task: lastUser, ids: tms });
    }
    const delay = /SLOW STOP TEST/i.test(lastUser) ? 3000 : 400;
    return body.stream
      ? slow(chosen, delay, opts.signal).then(async (mk) => llmStream((await mk.json()).choices[0].message))
      : slow(chosen, delay, opts.signal);
  }
  if (FAKE_PAGES[urlStr]) return { status: 200, ok: true, headers: { get: () => "text/html" }, text: async () => FAKE_PAGES[urlStr] };
  return { status: 404, ok: false, text: async () => "nf" };
};

// ------- à¸£à¸±à¸™ server à¸•à¸±à¸§à¸ˆà¸£à¸´à¸‡à¹à¸¥à¹‰à¸§à¸¢à¸´à¸‡ request à¸ˆà¸£à¸´à¸‡à¹€à¸‚à¹‰à¸²à¸¡à¸±à¸™ -------
require("./server.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- assertions ----
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  â€” " + detail : ""}`);
}

async function ask(task, { abortAfter } = {}) {
  const ctl = new AbortController();
  let httpStatus = null;
  const p = fetch(`http://localhost:8787/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task }),
    signal: ctl.signal,
  }).then(async (res) => {
    httpStatus = res.status;
    if (!res.ok) return { status: res.status, events: [], aborted: false };
    const text = await res.text();
    const events = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    return { status: res.status, events, aborted: false };
  }).catch((e) => ({ status: httpStatus ?? ("ERR:" + e.name), events: [], aborted: e.name === "AbortError" }));
  if (abortAfter) setTimeout(() => ctl.abort(), abortAfter);
  return p;
}

// à¸£à¸­à¸ˆà¸™à¸à¸§à¹ˆà¸² agent à¸—à¸¸à¸à¸•à¸±à¸§à¸ˆà¸°à¸™à¸´à¹ˆà¸‡à¸ˆà¸š (à¹„à¸¡à¹ˆà¸¡à¸µ LLM call à¹ƒà¸«à¸¡à¹ˆ) â€” à¸à¸±à¸™ test à¸Šà¸™à¸à¸±à¸š request à¸à¹ˆà¸­à¸™à¸«à¸™à¹‰à¸²
async function waitForIdle(stableMs = 900, maxMs = 25000) {
  const t0 = Date.now();
  let last = llmCalls.length;
  let stableSince = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(200);
    if (llmCalls.length !== last) { last = llmCalls.length; stableSince = Date.now(); }
    else if (Date.now() - stableSince > stableMs) return true;
  }
  return false;
}

(async () => {
  await sleep(500); // à¸£à¸­à¹ƒà¸«à¹‰ listen + à¹‚à¸«à¸¥à¸” key (mock)

  // 1) GET / à¸„à¸§à¸£à¸„à¸·à¸™ ui.html
  const page = await fetch(`http://localhost:8787/`);
  const html = await page.text();
  console.log("GET / â†’", page.status, "| ui.html served:", html.includes("Research Agent"));
  check("1 GET / à¸„à¸·à¸™à¸«à¸™à¹‰à¸² UI", page.status === 200 && html.includes("Research Agent"));

  // 2) POST /api/ask â€” à¸­à¹ˆà¸²à¸™ SSE stream à¸ˆà¸™à¸ˆà¸š
  const res = await fetch(`http://localhost:8787/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: "Summarize WebGPU support on Chrome and Firefox" }),
  });
  console.log("POST /api/ask â†’", res.status, "| content-type:", res.headers.get("content-type"));

  const text = await res.text();
  const events = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  const logs = events.filter((e) => e.type === "log");
  const answers = events.filter((e) => e.type === "answer");
  const errors = events.filter((e) => e.type === "error");

  console.log("\n===== RESULTS =====");
  console.log("log events:", logs.length, "| answers:", answers.length, "| errors:", errors.length);
  console.log("first 3 logs:");
  logs.slice(0, 3).forEach((e) => console.log("  >", JSON.stringify(e.data)));
  console.log("answer contains summary:", answers[0] && /WebGPU Support Summary/.test(answers[0].data));
  check("2 SSE stream à¸¡à¸µ log + answer à¸„à¸£à¸š",
    logs.length > 0 && answers.length === 1 && errors.length === 0, `logs=${logs.length} answers=${answers.length}`);
  check("2b answer à¸–à¸¹à¸à¸•à¹‰à¸­à¸‡", !!answers[0] && /WebGPU Support Summary/.test(answers[0].data));

  // 3) concurrent guard â€” à¹ƒà¸Šà¹‰ raw http client (à¸«à¸¥à¸š queue à¸‚à¸­à¸‡ undici fetch pool)
  const http = require("node:http");
  const rawPost = () => new Promise((resolve) => {
    const r = http.request({ host: "localhost", port: 8787, method: "POST", path: "/api/ask", headers: { "Content-Type": "application/json" } }, (res) => {
      resolve({ status: res.statusCode });
      res.resume();
    });
    r.end(JSON.stringify({ task: "Summarize WebGPU support on Chrome and Firefox" }));
    setTimeout(() => resolve({ status: "timeout" }), 8000);
  });
  const [p, q, r] = await Promise.all([rawPost(), rawPost(), rawPost()]);
  console.log("concurrent guard (raw):", p.status, "/", q.status, "/", r.status, "(expect two 200 [one queued], one 429 when queue full)");
  check("3 concurrent guard → คิวลึก 1 (2×200, คิวเต็มได้ 429)",
    [p.status, q.status, r.status].filter((s) => s === 200).length === 2 &&
    [p.status, q.status, r.status].filter((s) => s === 429).length === 1, `${p.status}/${q.status}/${r.status}`);

  // 4) server à¸•à¹‰à¸­à¸‡à¹„à¸¡à¹ˆ patch console.log à¹à¸šà¸š global
  check("4 console.log à¹„à¸¡à¹ˆà¸–à¸¹à¸ patch (à¹„à¸¡à¹ˆà¸¡à¸µ restore à¸‹à¹‰à¸­à¸™à¸à¸±à¸™)", console.log === PRISTINE_CONSOLE_LOG);

  // 5) à¸à¸” Stop (client abort) â†’ agent à¸•à¹‰à¸­à¸‡à¸«à¸¢à¸¸à¸”à¸ˆà¸£à¸´à¸‡ à¹„à¸¡à¹ˆà¸¢à¸´à¸‡ LLM à¸•à¹ˆà¸­
  await waitForIdle(); // à¸£à¸­ request à¸à¹ˆà¸­à¸™à¸«à¸™à¹‰à¸²à¸ˆà¸š à¹„à¸¡à¹ˆà¸‡à¸±à¹‰à¸™à¸ˆà¸°à¹‚à¸”à¸™ 429
  const stopRes = await ask("SLOW STOP TEST", { abortAfter: 300 });
  await sleep(4000); // à¸£à¸­à¹ƒà¸«à¹‰ agent à¸—à¸µà¹ˆà¸„à¹‰à¸²à¸‡ (à¸–à¹‰à¸²à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸–à¸¹à¸à¸«à¸¢à¸¸à¸”) à¸žà¸¢à¸²à¸¢à¸²à¸¡à¸¢à¸´à¸‡à¸£à¸­à¸šà¸—à¸µà¹ˆ 2
  const stopCalls = llmCalls.filter((c) => /SLOW STOP TEST/i.test(c.task));
  check("5a request à¸–à¸¹à¸à¸£à¸±à¸šà¸ˆà¸£à¸´à¸‡ (à¹„à¸¡à¹ˆà¹‚à¸”à¸™ 429)", stopRes.status === 200, "status=" + stopRes.status);
  check("5b à¸à¸” Stop à¹à¸¥à¹‰à¸§ agent à¸«à¸¢à¸¸à¸”à¸ˆà¸£à¸´à¸‡ (à¹„à¸¡à¹ˆà¸¢à¸´à¸‡ LLM à¸£à¸­à¸šà¸—à¸µà¹ˆ 2)",
    stopCalls.length === 1,
    `LLM calls = ${stopCalls.length} (à¸•à¹‰à¸­à¸‡à¹€à¸›à¹‡à¸™ 1 = call à¸—à¸µà¹ˆà¸„à¹‰à¸²à¸‡à¸­à¸¢à¸¹à¹ˆà¸•à¸­à¸™ abort à¹€à¸—à¹ˆà¸²à¸™à¸±à¹‰à¸™)`);

  // 6) parallel tool_calls à¸à¸¥à¸±à¸šà¸¡à¸²à¸•à¸²à¸¡à¸¥à¸³à¸”à¸±à¸š index
  await ask("ORDER TEST");
  const order = toolOrderSeen.find((o) => /ORDER TEST/i.test(o.task));
  check("6 à¸¥à¸³à¸”à¸±à¸š parallel tool à¸•à¸£à¸‡à¸à¸±à¸šà¸—à¸µà¹ˆà¹‚à¸¡à¹€à¸”à¸¥à¸ªà¸±à¹ˆà¸‡",
    !!order && order.ids[0] === "call_ZZZ" && order.ids[1] === "call_AAA",
    order ? order.ids.join(", ") : "à¹„à¸¡à¹ˆà¹€à¸ˆà¸­à¸‚à¹‰à¸­à¸¡à¸¹à¸¥");

  const failed = results.filter((r) => !r.ok);
  console.log("\n===== à¸ªà¸£à¸¸à¸› =====");
  console.log(`à¸œà¹ˆà¸²à¸™ ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log("FAIL:");
    failed.forEach((f) => console.log("  - " + f.name));
    process.exit(1);
  }
  console.log("à¸—à¸¸à¸à¸‚à¹‰à¸­à¸œà¹ˆà¸²à¸™ âœ“");
  process.exit(errors.length ? 1 : 0);
})().catch((e) => {
  console.error("FATAL à¹ƒà¸™ test:", e && e.stack ? e.stack : e);
  process.exit(1);
});
