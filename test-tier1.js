/**
 * test-tier1.js â€” à¸—à¸”à¸ªà¸­à¸š Tier 1 (à¸„à¸§à¸²à¸¡à¸ªà¸°à¸”à¸§à¸à¸‚à¸­à¸‡à¸œà¸¹à¹‰à¹ƒà¸Šà¹‰):
 *   1) ðŸ“ AGENTS.md â€” à¸à¸Žà¸‚à¸­à¸‡à¸œà¸¹à¹‰à¹ƒà¸Šà¹‰ inject à¹€à¸‚à¹‰à¸² system à¸—à¸¸à¸ run
 *   2) ðŸ“‹ plan mode â€” save_plan à¹€à¸‚à¸µà¸¢à¸™à¹„à¸Ÿà¸¥à¹Œ + onPlan callback + PLAN_RULES à¸–à¸¹à¸ inject
 *   3) ðŸ“‹ approved plan â€” inject approved plan + plan_done à¸­à¸±à¸›à¹€à¸”à¸• status à¸ˆà¸£à¸´à¸‡
 *   4) ðŸ”’ checkpoints â€” snapshot à¸à¹ˆà¸­à¸™ file_edit / run_command + diff + restore à¸ˆà¸£à¸´à¸‡
 *   5) ðŸ”’ à¸à¸±à¸™à¸šà¸§à¸¡ â€” depth>0 à¹„à¸¡à¹ˆ snapshot, cap à¸šà¸¥à¹‡à¸­à¸ same à¸¢à¸²à¸§à¸¢à¸¸à¸šà¹€à¸­à¸‡
 * offline world à¸—à¸±à¹‰à¸‡à¸«à¸¡à¸” (mock fetch + tmp project/state files) â€” à¹„à¸¡à¹ˆà¹€à¸ªà¸µà¸¢ cost, à¹„à¸¡à¹ˆà¹à¸•à¸°à¹„à¸Ÿà¸¥à¹Œà¸ˆà¸£à¸´à¸‡à¹ƒà¸™ repo
 */
process.env.OPENROUTER_API_KEY = "sk-or-v1-mock-test-key-0000000000000000";
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tier1-test-"));
const proj = path.join(tmp, "proj");
fs.mkdirSync(proj, { recursive: true });
process.env.AGENT_PROJECT_DIR = proj;
process.env.AGENT_AGENTS_FILE = path.join(tmp, "AGENTS.md");
process.env.AGENT_PLAN_FILE = path.join(tmp, "plan.json");
process.env.AGENT_CHECKPOINT_DIR = path.join(tmp, "ckpts");
process.env.AGENT_CHECKPOINT_FILE = path.join(tmp, "checkpoints.json");
process.env.AGENT_EVENTS_FILE = path.join(tmp, "events.jsonl");
process.env.AGENT_PLAYBOOK_FILE = path.join(tmp, "pb.json");
process.env.AGENT_EVALS_FILE = path.join(tmp, "evals.json");
process.env.AGENT_SKILLS_FILE = path.join(tmp, "skills.json");
process.env.AGENT_NO_EVALS = "1";

const ra = require("./research-agent.js");
const { CONFIG, agentLoop, loadAgentsRules, AGENTS_FILE, PLAN_FILE, loadPlan, getTools, loadCkpts, checkpointBefore, diffCheckpoint, restoreCheckpoint, diffText } = ra;
CONFIG.apiKey = "mock";

// ---- mock world ----
const llmResponse = (content, toolCalls) => ({ status: 200, ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }] }) });
const toolCall = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const savedPlans = [];
const onPlan = (p) => savedPlans.push(p);
const mainSys = [];   // system prompt à¸‚à¸­à¸‡ PE calls à¹à¸•à¹ˆà¸¥à¸°à¸£à¸±à¸™ (à¸ˆà¸±à¸šà¸ˆà¸²à¸ msg[0])
let sysPush = true;
global.fetch = async (url, opts = {}) => {
  if (!String(url).includes("openrouter")) throw new Error("unexpected fetch: " + url);
  const body = JSON.parse(opts.body);
  if (body.model.endsWith(":online")) return llmResponse("mock results â€” https://example.com/a");
  const sys = body.messages.find((m) => m.role === "system")?.content || "";
  const count = body.messages.filter((m) => m.role === "assistant").length;
  if (/agent's own eval curator/.test(sys)) return llmResponse("");
  if (/agent's own reflector/.test(sys)) return llmResponse("tools: test rule");
  llmCalls.push({ task: [...body.messages].reverse().find((m) => m.role === "user")?.content || "" });
  if (sysPush) mainSys.push(sys);
  const lastUser = llmCalls[llmCalls.length - 1].task || "";
  if (/PLAN IT/.test(lastUser)) {
    if (count === 0) return llmResponse(null, [toolCall("t1", "save_plan", { title: "scraper plan", steps: ["à¸«à¸² endpoint", "à¹€à¸‚à¸µà¸¢à¸™ script", "à¸—à¸”à¸ªà¸­à¸š 3 à¸à¸£à¸“à¸µ"] })]);
    if (count === 1) return llmResponse("à¹à¸œà¸™à¸žà¸£à¹‰à¸­à¸¡à¹ƒà¸«à¹‰à¸­à¸™à¸¸à¸¡à¸±à¸•à¸´");
    return llmResponse("done");
  }
  if (/APPROVED TASK/.test(lastUser)) {
    if (count === 0) return llmResponse(null, [toolCall("t2", "plan_done", { step: 1 })]);
    if (count === 1) return llmResponse(null, [toolCall("t3", "plan_done", { step: 2 })]);
    return llmResponse("à¸—à¸³à¹à¸œà¸™à¹€à¸ªà¸£à¹‡à¸ˆ 2 step");
  }
  return llmResponse("misc answer");
};
const llmCalls = [];

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " â€” " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- 1) AGENTS.md inject ----
  fs.writeFileSync(AGENTS_FILE, "# à¸à¸Žà¸‚à¸­à¸‡à¹‚à¸›à¸£à¹€à¸ˆà¹‡à¸à¸•à¹Œ\n- à¸•à¸­à¸šà¸ à¸²à¸©à¸²à¹„à¸—à¸¢à¹€à¸ªà¸¡à¸­\n- à¸«à¹‰à¸²à¸¡à¸ªà¸¡à¸¡à¸¸à¸•à¸´à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸—à¸µà¹ˆà¹„à¸¡à¹ˆà¸¡à¸µà¹à¸«à¸¥à¹ˆà¸‡à¸­à¹‰à¸²à¸‡à¸­à¸´à¸‡\n");
  sysPush = true; mainSys.length = 0;
  await agentLoop("AGENTS RULES CHECK à¸‡à¸²à¸™à¸‡à¹ˆà¸²à¸¢", { depth: 0 });
  await sleep(200);
  check("1 AGENTS.md inject à¹€à¸‚à¹‰à¸² system", mainSys[0]?.includes("# Project rules") && mainSys[0]?.includes("à¸«à¹‰à¸²à¸¡à¸ªà¸¡à¸¡à¸¸à¸•à¸´à¸‚à¹‰à¸­à¸¡à¸¹à¸¥"),
    "len=" + (mainSys[0] || "").length);
  check("1a ê·œà¸à¸Žà¹„à¸Ÿà¸¥à¹Œà¹€à¸à¸´à¸™ cap 8000 à¸•à¸±à¸”à¹€à¸­à¸‡", loadAgentsRules().length <= 8000);

  // ---- 2) plan mode ----
  sysPush = false; mainSys.length = 0; sysPush = true;
  const planSpecs = getTools("research", { save: true }).map((s) => s.function.name);
  check("2 getTools(save) à¸¡à¸µ save_plan à¹à¸¥à¸°à¹„à¸¡à¹ˆà¸¡à¸µ plan_done", planSpecs.includes("save_plan") && !planSpecs.includes("plan_done"), planSpecs.join(","));
  await agentLoop("PLAN IT: à¸—à¸³ hook web scraper", { depth: 0, planMode: true, tools: getTools("research", { save: true }), onPlan });
  await sleep(300);
  const plan = loadPlan();
  check("2a plan mode à¸ªà¸£à¹‰à¸²à¸‡ plan à¸œà¹ˆà¸²à¸™ tool save_plan", !!plan && plan.steps.length === 3 && plan.title === "scraper plan", plan ? plan.title + "/" + plan.steps.length : "none");
  check("2b onPlan callback à¸–à¸¹à¸à¹€à¸£à¸µà¸¢à¸ (à¸ªà¸³à¸«à¸£à¸±à¸š SSE)", savedPlans.length >= 1, "plans=" + savedPlans.length);
  check("2c PLAN_RULES inject à¹ƒà¸™à¸£à¸­à¸šà¸§à¸²à¸‡à¹à¸œà¸™", mainSys[0]?.includes("== PLAN MODE =="));
  await sleep(600); // à¹ƒà¸«à¹‰ learn hook à¸ˆà¸š

  // ---- 3) approved plan + plan_done ----
  mainSys.length = 0;
  const fresh = JSON.parse(JSON.stringify(plan)); // à¹à¸œà¸™à¸—à¸µà¹ˆà¸œà¸¹à¹‰à¹ƒà¸Šà¹‰ "à¸à¸”à¸­à¸™à¸¸à¸¡à¸±à¸•à¸´" (steps à¸¢à¸±à¸‡à¸§à¹ˆà¸²à¸‡à¸«à¸¡à¸”)
  await agentLoop("APPROVED TASK: à¸—à¸³à¸•à¸²à¸¡à¹à¸œà¸™ scraper", { depth: 0, approvedPlan: fresh, tools: getTools("research", { done: true }), onPlan });
  await sleep(600);
  const after = loadPlan();
  check("3 approved plan inject à¹€à¸‚à¹‰à¸² system", mainSys[0]?.includes("Approved plan") && mainSys[0]?.includes(fresh.steps[0].text));
  check("3a plan_done à¸—à¸³à¸‡à¸²à¸™: step 1-2 done à¸ˆà¸£à¸´à¸‡", after.steps[0].done === true && after.steps[1].done === true && after.steps[2].done === false,
    after.steps.map((s) => (s.done ? "x" : " ")).join(""));
  check("3b getTools(done) à¸¡à¸µ plan_done à¹€à¸‰à¸žà¸²à¸°à¸•à¸­à¸™à¸­à¸™à¸¸à¸¡à¸±à¸•à¸´", getTools("research", { done: true }).some((s) => s.function.name === "plan_done") && !getTools("research").some((s) => s.function.name === "plan_done"));

  // ---- 4) checkpoints: file_edit ----
  const ticket = path.join(proj, "ticket.txt");
  fs.writeFileSync(ticket, "line1\nline2\n");
  const ctx1 = { depth: 0, runId: "run-file", log: () => {} };
  const beforeCount = loadCkpts().length;
  checkpointBefore("file_edit", { path: "ticket.txt" }, ctx1);
  let cks = loadCkpts();
  check("4 checkpoint à¸à¹ˆà¸­à¸™ file_edit", cks.length === beforeCount + 1 && cks[0].files[0].rel === "ticket.txt");
  const id1 = cks[0].id;
  fs.writeFileSync(ticket, "line1\nline2\nline3 new\n"); // à¸ˆà¸³à¸¥à¸­à¸‡à¸à¸²à¸£à¹à¸à¹‰à¹„à¸‚
  const diff1 = diffCheckpoint(id1);
  check("4a diff à¹€à¸«à¹‡à¸™ + line3 new", diff1[0].diff.some((l) => l.t === "add" && l.text.includes("line3 new")));
  restoreCheckpoint(id1);
  check("4b restore à¹„à¸Ÿà¸¥à¹Œà¸à¸¥à¸±à¸šà¹€à¸›à¹‡à¸™à¹€à¸™à¸·à¹‰à¸­à¹€à¸”à¸´à¸¡", fs.readFileSync(ticket, "utf8") === "line1\nline2\n");

  // ---- 4c) checkpoints: run_command â†’ snapshot à¸—à¸±à¹‰à¸‡à¹‚à¸›à¸£à¹€à¸ˆà¹‡à¸à¸•à¹Œ ----
  fs.writeFileSync(path.join(proj, "b.md"), "# b");
  const ctx2 = { depth: 0, runId: "run-cmd", log: () => {} };
  checkpointBefore("run_command", {}, ctx2);
  cks = loadCkpts();
  const cmdRec = cks[0];
  check("4c snapshot à¸à¹ˆà¸­à¸™ run_command à¸„à¸¥à¸¸à¸¡à¹„à¸Ÿà¸¥à¹Œà¸—à¸±à¹‰à¸‡à¹‚à¸›à¸£à¹€à¸ˆà¹‡à¸à¸•à¹Œ", cmdRec.kind === "run" && cmdRec.files.length >= 2, "files=" + cmdRec.files.length);

  // ---- 5) à¸à¸±à¸™à¸šà¸§à¸¡: depth>0 à¹„à¸¡à¹ˆ snapshot ----
  const cBefore = loadCkpts().length;
  checkpointBefore("file_edit", { path: "ticket.txt" }, { depth: 1, runId: "sub", log: () => {} });
  check("5 depth>0 à¹„à¸¡à¹ˆà¸ªà¸£à¹‰à¸²à¸‡ checkpoint", loadCkpts().length === cBefore);

  // ---- 5a) diffText à¸¢à¸¸à¸šà¸šà¸¥à¹‡à¸­à¸ same à¸¢à¸²à¸§ ----
  const bigA = Array.from({ length: 20 }, (_, i) => "s" + i).join("\n");
  const bigB = "s0\ns1\nCHANGED\n" + Array.from({ length: 16 }, (_, i) => "s" + (3 + i)).join("\n");
  const d = diffText(bigA, bigB);
  check("5a same à¸šà¸¥à¹‡à¸­à¸à¸¢à¸²à¸§à¸–à¸¹à¸à¸¢à¸¸à¸š à¹€à¸«à¸¥à¸·à¸­à¸«à¸¡à¸²à¸¢à¹€à¸«à¸•à¸¸", d.length <= 12 && d.some((l) => l.t === "add" && l.text === "CHANGED"), "len=" + d.length);

  const failed = results.filter((r) => !r.ok);
  console.log(`\nà¸œà¹ˆà¸²à¸™ ${results.length - failed.length}/${results.length}`);
  if (failed.length) { failed.forEach((f) => console.log("  FAIL: " + f.name)); process.exit(1); }
  console.log("à¸—à¸¸à¸à¸‚à¹‰à¸­à¸œà¹ˆà¸²à¸™ âœ“");
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
