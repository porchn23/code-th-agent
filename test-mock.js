/**
 * test-mock.js â€” à¸—à¸”à¸ªà¸­à¸š research-agent à¹‚à¸”à¸¢à¹„à¸¡à¹ˆà¹ƒà¸Šà¹‰ API key à¸ˆà¸£à¸´à¸‡
 *
 * à¸§à¸´à¸˜à¸µ: à¹à¸­à¸š override global.fetch à¹€à¸žà¸·à¹ˆà¸­à¸ˆà¸³à¸¥à¸­à¸‡
 *   1) OpenRouter chat/completions API (à¸•à¸­à¸šà¸•à¸²à¸¡ script à¸—à¸µà¹ˆà¸£à¸°à¸šà¸¸à¹„à¸§à¹‰)
 *   2) `:online` search â†’ à¸œà¸¥à¸„à¹‰à¸™à¸«à¸²à¸ªà¸¡à¸¡à¸¸à¸•à¸´
 *   3) à¸«à¸™à¹‰à¸²à¹€à¸§à¹‡à¸šà¸—à¸µà¹ˆ tool à¸—à¸³ web_fetch â†’ HTML à¸ªà¸¡à¸¡à¸¸à¸•à¸´ (à¹à¸¥à¸° 404 à¸ªà¸³à¸«à¸£à¸±à¸šà¸«à¸™à¹‰à¸²à¸—à¸µà¹ˆà¹„à¸¡à¹ˆà¸¡à¸µ)
 * à¹‚à¸„à¹‰à¸” agent (research-agent.js) à¸—à¸³à¸‡à¸²à¸™à¸ˆà¸£à¸´à¸‡à¸—à¸¸à¸à¸ªà¹ˆà¸§à¸™ loop/tool/dispatch
 * à¹à¸„à¹ˆ "à¹‚à¸¥à¸à¸ à¸²à¸¢à¸™à¸­à¸" à¸–à¸¹à¸à¹à¸—à¸™à¸”à¹‰à¸§à¸¢ fake â€” à¹à¸™à¸§à¸„à¸´à¸”à¹€à¸”à¸µà¸¢à¸§à¸à¸±à¸š mock à¸—à¸µà¹ˆà¹ƒà¸Šà¹‰à¸ˆà¸£à¸´à¸‡à¸•à¸­à¸™ test
 *
 * à¸ªà¸´à¹ˆà¸‡à¸—à¸µà¹ˆ test à¸™à¸µà¹‰ "à¸žà¸´à¸ªà¸¹à¸ˆà¸™à¹Œ" (à¹„à¸¡à¹ˆà¹ƒà¸Šà¹ˆà¹à¸„à¹ˆà¸£à¸±à¸™à¸œà¹ˆà¸²à¸™):
 *   A. orchestrator â†’ spawn sub-agent â†’ à¹„à¸”à¹‰à¸„à¸³à¸•à¸­à¸šà¸ªà¸¸à¸”à¸—à¹‰à¸²à¸¢
 *   B. tool error â†’ à¸–à¸¹à¸à¸«à¹ˆà¸­à¸à¸¥à¸±à¸šà¹€à¸‚à¹‰à¸² context â†’ à¹‚à¸¡à¹€à¸”à¸¥à¸§à¸²à¸‡à¹à¸œà¸™à¹à¸à¹‰à¹€à¸­à¸‡
 *   C. js_eval sandbox: require/process/eval/Function/WebAssembly à¸«à¸¥à¸¸à¸”à¹„à¸¡à¹ˆà¹„à¸”à¹‰
 *   D. js_eval à¸¢à¸±à¸‡à¸„à¸³à¸™à¸§à¸“à¹€à¸à¹ˆà¸‡à¸•à¸²à¸¡à¸›à¸à¸•à¸´
 *
 * exit code: 0 = à¸œà¹ˆà¸²à¸™à¸—à¸¸à¸à¸‚à¹‰à¸­ / 1 = à¸¡à¸µà¸‚à¹‰à¸­à¸—à¸µà¹ˆ fail
 */

process.env.OPENROUTER_API_KEY = "sk-mock-test";
process.env.AGENT_EVENTS_FILE = require("node:path").join(require("node:os").tmpdir(), "agent-ev-test.jsonl");
process.env.AGENT_PLAYBOOK_FILE = require("node:path").join(require("node:os").tmpdir(), "agent-pb-test.jsonl");
process.env.AGENT_NO_EVALS = "1"; // Circuit 3 ปิดใน test เดิม — กัน eval-reflector ยิง LLM นอกสคริปต์
process.env.AGENT_NO_CHECKPOINTS = "1"; // Tier 1 ปิดใน test เดิม — ไม่เขียนลง repo จริง

// ---------------------------------------------------------------
// helper: à¸«à¹ˆà¸­ response à¸£à¸¹à¸›à¹à¸šà¸š OpenAI-compatible
// ---------------------------------------------------------------
const llmResponse = (content, toolCalls) => ({
  status: 200, ok: true, text: async () => "",
  json: async () => ({ choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }] }),
});
const toolCall = (name, args) => ({
  id: "call_" + Math.random().toString(36).slice(2, 8),
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

// ---------------------------------------------------------------
// SCRIPTS: à¸à¸³à¸«à¸™à¸”à¸¥à¹ˆà¸§à¸‡à¸«à¸™à¹‰à¸²à¸§à¹ˆà¸² "à¹‚à¸¡à¹€à¸”à¸¥" à¸ˆà¸°à¸•à¸­à¸šà¸­à¸°à¹„à¸£à¸•à¸­à¸™à¹„à¸«à¸™
// ---------------------------------------------------------------
// Orchestrator: spawn sub-agent Chrome â†’ spawn sub-agent Firefox â†’ final
const MAIN_SCRIPT = [
  llmResponse(null, [toolCall("research_subagent", { brief: "Research WebGPU support in Chrome" })]),
  llmResponse(null, [toolCall("research_subagent", { brief: "Research WebGPU support in Firefox" })]),
  llmResponse("## WebGPU Support Summary\n\n**Chrome:** ships WebGPU on Windows/macOS since v113. [src](https://example.com/webgpu-chrome)\n**Firefox:** shipped on Windows, expansion ongoing. [src](https://example.com/webgpu-firefox)\n\nDone via 2 sub-agents."),
];
// Sub-agent Chrome: search â†’ fetch à¸«à¸™à¹‰à¸²à¸—à¸µà¹ˆà¸žà¸±à¸‡ (404) â†’ fetch à¸«à¸™à¹‰à¸²à¸—à¸µà¹ˆà¸”à¸µ â†’ à¸£à¸²à¸¢à¸‡à¸²à¸™
// (à¸ˆà¸‡à¹ƒà¸ˆà¹ƒà¸«à¹‰ fetch 1 à¸­à¸±à¸™à¹€à¸›à¹‡à¸™à¸«à¸™à¹‰à¸²à¸—à¸µà¹ˆ mock à¹„à¸¡à¹ˆà¸£à¸¹à¹‰à¸ˆà¸±à¸ à¹€à¸žà¸·à¹ˆà¸­à¸—à¸”à¸ªà¸­à¸šà¸§à¹ˆà¸²à¹€à¸¡à¸·à¹ˆà¸­ tool error
//  à¹à¸¥à¹‰à¸§ sub-agent à¸¢à¸±à¸‡à¸§à¸²à¸‡à¹à¸œà¸™à¹à¸à¹‰à¹€à¸­à¸‡à¸•à¹ˆà¸­à¹„à¸”à¹‰)
const CHROME_SCRIPT = [
  llmResponse(null, [toolCall("web_search", { query: "WebGPU Chrome availability" })]),
  llmResponse(null, [toolCall("web_fetch", { url: "https://example.com/webgpu-chrome-broken" })]),
  llmResponse(null, [toolCall("web_fetch", { url: "https://example.com/webgpu-chrome" })]),
  llmResponse("Chrome: WebGPU shipped on Windows/macOS in Chrome 113; Linux has limited support. Reference: example.com/webgpu-chrome."),
];
// Sub-agent Firefox: search â†’ report (à¸•à¸±à¹‰à¸‡à¹ƒà¸ˆà¹„à¸¡à¹ˆ fetch à¹€à¸žà¸·à¹ˆà¸­à¸”à¸¹ path à¹€à¸ªà¸£à¹‡à¸ˆà¸ªà¸±à¹‰à¸™à¹†)
const FIREFOX_SCRIPT = [
  llmResponse(null, [toolCall("web_search", { query: "WebGPU Firefox support" })]),
  llmResponse("Firefox: WebGPU shipped on Windows; rollout to other platforms ongoing. Reference: example.com/webgpu-firefox."),
];

// ---------------------------------------------------------------
// Sandbox probe: à¸žà¸¢à¸²à¸¢à¸²à¸¡à¸«à¸¥à¸¸à¸”à¸ˆà¸²à¸ js_eval à¸—à¸¸à¸à¸—à¸²à¸‡à¸—à¸µà¹ˆà¸„à¸´à¸”à¸­à¸­à¸
// ---------------------------------------------------------------
const SANDBOX_PAYLOAD = `
function attempt(name, fn) {
  try { const v = fn(); console.log(name + " => LEAKED: " + String(v)); }
  catch (e) { console.log(name + " => blocked: " + (e && e.message ? e.message : String(e))); }
}
attempt("require", () => require('fs'));
attempt("process", () => process.env);
attempt("globalThis.process", () => globalThis.process.env);
attempt("constructor-constructor", () => this.constructor.constructor('return process')());
attempt("eval", () => eval('1+1'));
attempt("Function-ctor", () => new Function('return 1')());
attempt("wasm", () => WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])));
import('fs').then(
  () => console.log("dynamic-import => LEAKED"),
  (e) => console.log("dynamic-import => blocked: " + e.message)
);
console.log("plain-math => " + (2 ** 10));
console.log("plain-json => " + JSON.stringify({ ok: true }));
Promise.reject(new Error("async boom"));
while (true) {}
`;
const SANDBOX_SCRIPT = [
  llmResponse(null, [toolCall("js_eval", { code: SANDBOX_PAYLOAD })]),
  llmResponse("sandbox probe complete"),
];

// à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œà¹€à¸§à¹‡à¸šà¸ªà¸¡à¸¡à¸¸à¸•à¸´à¸ªà¸³à¸«à¸£à¸±à¸š web_fetch
const FAKE_PAGES = {
  "https://example.com/webgpu-chrome": "<html><head><title>WebGPU in Chrome</title></head><body><h1>Chrome WebGPU</h1><p>WebGPU ships on Windows and macOS since Chrome 113, Linux limited.</p></body></html>",
};

// à¹€à¸à¹‡à¸šà¸—à¸¸à¸ request à¸—à¸µà¹ˆà¸¢à¸´à¸‡à¹€à¸‚à¹‰à¸² LLM à¹„à¸§à¹‰à¸•à¸£à¸§à¸ˆà¸¢à¹‰à¸­à¸™à¸«à¸¥à¸±à¸‡ (à¹ƒà¸Šà¹‰ assert à¸§à¹ˆà¸² error à¸–à¸¹à¸à¸«à¹ˆà¸­à¸à¸¥à¸±à¸šà¹€à¸‚à¹‰à¸² context)
const llmRequests = [];

global.fetch = async (url, opts = {}) => {
  const urlStr = String(url);
  // â€”â€” à¸à¸£à¸“à¸µ 1: à¹€à¸£à¸µà¸¢à¸ OpenRouter â€”â€”
  if (urlStr.startsWith("https://openrouter.ai")) {
    const body = JSON.parse(opts.body);
    llmRequests.push(body);
    // (a) model à¸•à¹ˆà¸­ :online = toolWebSearch â†’ à¸„à¸·à¸™à¸œà¸¥ search à¸ªà¸¡à¸¡à¸¸à¸•à¸´
    if (body.model.endsWith(":online")) {
      const q = JSON.stringify(body.messages[0].content);
      return llmResponse(`1. WebGPU browser support overview â€” https://example.com/webgpu-overview â€” Chromium browsers and Firefox ship WebGPU; Safari adds support recently. (query=${q})`);
    }
    // (b) à¹€à¸¥à¸·à¸­à¸ script à¸ˆà¸²à¸ "user à¸„à¸™à¸¥à¹ˆà¸²à¸ªà¸¸à¸”" (brief à¸‚à¸­à¸‡ sub-agent à¸«à¸£à¸·à¸­ task à¸‚à¸­à¸‡à¸«à¸¥à¸±à¸)
    const lastUser = [...body.messages].reverse().find((m) => m.role === "user")?.content || "";
    const assistantCount = body.messages.filter((m) => m.role === "assistant").length;
    let script = null;
    if (/sandbox probe/i.test(lastUser)) script = SANDBOX_SCRIPT;
    else if (/Summarize WebGPU support on Chrome and Firefox/.test(lastUser)) script = MAIN_SCRIPT;
    else if (/Research WebGPU support in Chrome/.test(lastUser)) script = CHROME_SCRIPT;
    else if (/Research WebGPU support in Firefox/.test(lastUser)) script = FIREFOX_SCRIPT;
    if (!script) throw new Error("mock: no script for task: " + lastUser.slice(0, 80));
    // à¸„à¸·à¸™à¸‚à¸±à¹‰à¸™à¸–à¸±à¸”à¹„à¸›à¸‚à¸­à¸‡ script
    return script[Math.min(assistantCount, script.length - 1)];
  }
  // â€”â€” à¸à¸£à¸“à¸µ 2: tool à¸—à¸³ web_fetch à¹„à¸›à¹€à¸§à¹‡à¸šà¸ˆà¸£à¸´à¸‡à¹ƒà¸™à¹‚à¸¥à¸à¸‚à¸­à¸‡ mock â€”â€”
  if (FAKE_PAGES[urlStr]) {
    return {
      status: 200, ok: true,
      headers: { get: () => "text/html; charset=utf-8" },
      text: async () => FAKE_PAGES[urlStr],
    };
  }
  // à¸à¸£à¸“à¸µ 3: à¹€à¸§à¹‡à¸šà¹„à¸¡à¹ˆà¸¡à¸µà¹ƒà¸™ mock â†’ à¸”à¸¹à¸§à¹ˆà¸² error handling à¸‚à¸­à¸‡ agent à¸—à¸³à¸‡à¸²à¸™à¹„à¸«à¸¡
  return { status: 404, ok: false, text: async () => "not found in mock world" };
};

// ---------------------------------------------------------------
// assertions
// ---------------------------------------------------------------
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  â€” " + detail : ""}`);
}

(async () => {
  console.error("=== MOCK WORLD READY â€” running real agent code against fake network ===\n");
  const { agentLoop, CONFIG } = require("./research-agent.js");
  CONFIG.apiKey = "sk-mock-test";

  // -----------------------------------------------------------------
  console.error("--- TEST A: orchestrator + sub-agents ---");
  const answer = await agentLoop("Summarize WebGPU support on Chrome and Firefox", {
    depth: 0, noBanner: true,
  });
  check("A1 final answer à¸¡à¸µà¸ªà¸£à¸¸à¸›", /WebGPU Support Summary/.test(answer || ""), (answer || "").slice(0, 40));
  const briefs = llmRequests
    .map((b) => [...b.messages].reverse().find((m) => m.role === "user")?.content || "")
    .filter((t) => /Research WebGPU support in/.test(t));
  check("A2 sub-agent à¸–à¸¹à¸ spawn à¸—à¸±à¹‰à¸‡ 2 à¹€à¸£à¸·à¹ˆà¸­à¸‡",
    briefs.some((b) => /Chrome/.test(b)) && briefs.some((b) => /Firefox/.test(b)),
    briefs.map((b) => b.replace(/Research WebGPU support in /, "")).join(" / "));

  // -----------------------------------------------------------------
  console.error("\n--- TEST B: tool error â†’ à¸«à¹ˆà¸­à¸à¸¥à¸±à¸šà¹€à¸‚à¹‰à¸² context â†’ à¹‚à¸¡à¹€à¸”à¸¥à¹à¸à¹‰à¹€à¸­à¸‡ ---");
  const toolMsgs = llmRequests.flatMap((b) => b.messages.filter((m) => m.role === "tool").map((m) => m.content));
  const errTool = toolMsgs.find((t) => /^Error: HTTP 404/.test(String(t)));
  check("B1 tool error à¸–à¸¹à¸à¸«à¹ˆà¸­à¸à¸¥à¸±à¸šà¹€à¸‚à¹‰à¸² context à¹„à¸¡à¹ˆ crash", !!errTool, errTool ? String(errTool).slice(0, 60) : "à¹„à¸¡à¹ˆà¹€à¸ˆà¸­ error");
  const chromeFetchOk = toolMsgs.find((t) => /Chrome WebGPU/.test(String(t)));
  check("B2 à¸«à¸¥à¸±à¸‡ error à¹à¸¥à¹‰à¸§à¸¢à¸±à¸‡ fetch à¸«à¸™à¹‰à¸²à¸—à¸µà¹ˆà¸”à¸µà¹„à¸”à¹‰", !!chromeFetchOk);

  // -----------------------------------------------------------------
  console.error("\n--- TEST C: js_eval sandbox à¸•à¹‰à¸­à¸‡à¸«à¸¥à¸¸à¸”à¹„à¸¡à¹ˆà¹„à¸”à¹‰ ---");
  await agentLoop("sandbox probe", { depth: 0, noBanner: true });
  // à¸”à¸¶à¸‡à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œ js_eval à¸¥à¹ˆà¸²à¸ªà¸¸à¸”à¸ˆà¸²à¸ context à¸—à¸µà¹ˆà¸–à¸¹à¸à¸ªà¹ˆà¸‡à¸à¸¥à¸±à¸šà¹ƒà¸«à¹‰à¹‚à¸¡à¹€à¸”à¸¥
  const sandboxTool = llmRequests
    .flatMap((b) => b.messages.filter((m) => m.role === "tool").map((m) => m.content))
    .filter((t) => /plain-math/.test(String(t)))
    .pop();
  const sbText = String(sandboxTool || "");
  const leaked = /=> LEAKED/.test(sbText);
  check("C1 à¹„à¸¡à¹ˆà¸¡à¸µà¸—à¸²à¸‡à¸«à¸¥à¸¸à¸”à¹ƒà¸” à¹† (require/process/eval/Function/wasm/import)",
    !!sbText && !leaked, leaked ? "à¸¡à¸µ LEAKED!" : (sbText.split("\n").filter((l) => l.includes("=>")).join(" | ").slice(0, 90)));
  check("C2 à¹„à¸¡à¹ˆà¸¡à¸µ secret à¸«à¸£à¸·à¸­ process à¹ƒà¸«à¹‰à¹€à¸£à¸µà¸¢à¸à¹ƒà¸Šà¹‰à¸ˆà¸£à¸´à¸‡",
    !/sk-or-v1/.test(sbText) && !/process\.env\s*=/.test(sbText));
  check("C3 à¸„à¸³à¸™à¸§à¸“à¸›à¸à¸•à¸´à¹„à¸”à¹‰", /plain-math => 1024/.test(sbText), (sbText.match(/plain-math => \d+/) || [""])[0]);
  check("C4 JSON à¸›à¸à¸•à¸´à¹„à¸”à¹‰", /plain-json => \{"ok":true\}/.test(sbText));
  check("C5 infinite loop à¸–à¸¹à¸à¸•à¸±à¸”à¸”à¹‰à¸§à¸¢ timeout (à¹„à¸¡à¹ˆà¸„à¹‰à¸²à¸‡)",
    /timed out/i.test(sbText), (sbText.match(/timed out[^\n]*/i) || [""])[0]);
  check("C6 unhandled rejection à¹„à¸¡à¹ˆà¸—à¸³à¹ƒà¸«à¹‰ runner à¸•à¸²à¸¢",
    /unhandled rejection/i.test(sbText), (sbText.match(/unhandled rejection[^\n]*/i) || [""])[0]);

  // -----------------------------------------------------------------
  console.error("\n--- TEST D: markdown renderer à¸‚à¸­à¸‡ UI à¸•à¹‰à¸­à¸‡à¸à¸±à¸™ attribute injection ---");
  const fs = require("node:fs");
  const path = require("node:path");
  const uiHtml = fs.readFileSync(path.join(__dirname, "ui.html"), "utf8");
  // à¸”à¸¶à¸‡à¸Ÿà¸±à¸‡à¸à¹Œà¸Šà¸±à¸™ esc()/md() à¸ˆà¸²à¸ ui.html à¸‚à¸­à¸‡à¸ˆà¸£à¸´à¸‡ (à¹„à¸¡à¹ˆà¸„à¸±à¸”à¸¥à¸­à¸à¹‚à¸„à¹‰à¸”à¸¡à¸²à¹€à¸­à¸‡) à¹à¸¥à¹‰à¸§à¹€à¸­à¸²à¹„à¸›à¸£à¸±à¸™
  const extractFn = (src, header) => {
    const start = src.indexOf(header);
    if (start < 0) throw new Error("à¹„à¸¡à¹ˆà¹€à¸ˆà¸­ " + header + " à¹ƒà¸™ ui.html");
    let i = src.indexOf("{", start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error("à¸§à¸‡à¹€à¸¥à¹‡à¸šà¹„à¸¡à¹ˆà¸ªà¸¡à¸”à¸¸à¸¥: " + header);
  };
  const md = new Function(extractFn(uiHtml, "function esc(s)") + "\n" + extractFn(uiHtml, "function md(src)") + "\nreturn md;")();
  // à¸•à¸±à¸§à¸•à¸£à¸§à¸ˆ: tag à¸ˆà¸£à¸´à¸‡à¸—à¸µà¹ˆà¸¡à¸µ event-handler attribute (on*=)
  const injected = (html) => (html.match(/<[a-zA-Z][^>]*>/g) || [])
    .filter((tag) => /(["\s])on[a-z]+\s*=/i.test(tag));

  const payloads = [
    ['[x](https://evil.com/"onmouseover="alert)', "onmouseover"],
    ['[x](https://evil.com/"onclick="fetch)', "onclick"],
    ['[x](https://evil.com/"onmouseover=alert)', "onmouseover"],
  ];
  let anyInjected = null;
  for (const [payload, handler] of payloads) {
    const out = md(payload);
    const hits = injected(out);
    if (hits.length) anyInjected = { payload, out, hits };
  }
  check("D1 markdown link à¸—à¸µà¹ˆà¸¡à¸µ quote à¹ƒà¸™ URL à¹„à¸¡à¹ˆà¸«à¸¥à¸¸à¸”à¹€à¸›à¹‡à¸™ handler",
    !anyInjected, anyInjected ? anyInjected.out : "à¸—à¸¸à¸ payload à¸–à¸¹à¸ neutralize à¹à¸¥à¹‰à¸§");
  check("D2 raw HTML à¸¢à¸±à¸‡à¸–à¸¹à¸ escape à¸•à¸²à¸¡à¹€à¸”à¸´à¸¡",
    !injected(md('<img src=x onerror=alert(4)>')).length);
  check("D3 à¸¥à¸´à¸‡à¸à¹Œà¸›à¸à¸•à¸´à¸¢à¸±à¸‡à¸—à¸³à¸‡à¸²à¸™",
    /<a href="https:\/\/example\.com\/a"/.test(md("à¸”à¸¹ [à¸­à¹ˆà¸²à¸™à¸•à¹ˆà¸­](https://example.com/a)")),
    md("à¸”à¸¹ [à¸­à¹ˆà¸²à¸™à¸•à¹ˆà¸­](https://example.com/a)"));

  // -----------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.error("\n===== à¸ªà¸£à¸¸à¸› =====");
  console.error(`à¸œà¹ˆà¸²à¸™ ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.error("FAIL:");
    failed.forEach((f) => console.error("  - " + f.name));
    process.exit(1);
  }
  console.error("à¸—à¸¸à¸à¸‚à¹‰à¸­à¸œà¹ˆà¸²à¸™ âœ“");
  process.exit(0);
})().catch((e) => {
  console.error("FATAL à¹ƒà¸™ test:", e && e.stack ? e.stack : e);
  process.exit(1);
});
