/**
 * server.js — Web UI สำหรับ Research Agent (zero dependency)
 * รัน: node server.js  แล้วเปิดเบราว์เซอร์ http://localhost:8787
 *
 * Endpoint:
 *   GET  /          → หน้า ui.html
 *   POST /api/ask   → SSE stream: {type:"log"|"answer"|"error", data}
 *
 * แนวคิด: อย่าเขียน agent ใหม่ — ทำ "หน้าบ้าน" ที่เอา agentLoop ตัวเดิมมาใช้
 * log ทุก step ของ agent ถูก "ดัก" ผ่าน console.log แล้ว stream ไปหน้าเว็บสดๆ
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { CONFIG, agentLoop, getApiKey, playbookSummary, evalSummary, getTools, loadSkills } = require("./research-agent.js");

const PORT = 8787;
const ANSI_RE = /\x1b\[[0-9;]*m/g; // ลบสี ANSI ก่อนส่งไปหน้าเว็บ
const DEFAULT_MODEL = CONFIG.model; // เก็บ default ไว้ restore หลังแต่ละ run

// ---- รายการ models จาก OpenRouter (public endpoint, ไม่ต้อง key) + cache 10 นาที ----
let modelCache = null;
async function getModelList() {
  if (modelCache && Date.now() - modelCache.t < 10 * 60 * 1000) return modelCache.list;
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`Model list fetch failed: HTTP ${res.status}`);
  const { data } = await res.json();
  const list = data.map((m) => ({
    id: m.id,
    name: m.name,
    context: m.context_length,
    free: m.pricing && parseFloat(m.pricing.prompt) === 0 && parseFloat(m.pricing.completion) === 0,
    tools: (m.supported_parameters || []).includes("tools"), // agent ต้องการ function calling
  }));
  modelCache = { t: Date.now(), list };
  return list;
}

// โหลด key ตั้งแต่ boot (ไฟล์ .openrouter_key ต้องมีอยู่แล้วจากการรัน CLI ก่อนหน้า)
const keyReady = getApiKey().then((k) => { CONFIG.apiKey = k; console.log(`[ready] key loaded, model = ${CONFIG.model}`); })
  .catch((e) => { console.error("Key setup failed:", e.message); process.exit(1); });

let running = false; // กันวิ่งแข่งกันเอง (1 task ต่อ 1 process ชั่วคราว)
let queuedItem = null; // คิวรอลึก 1 — แทนการ 429 ทันที (งานถัดไปนั่งรอ run ปัจจุบัน)

// รันงาน 1 ชิ้นต่อ response — ใช้ทั้งเคส "ว่างรับเลย" และ "ดึงจากคิว" เมื่อ run ก่อนหน้าจบ
async function runTask(parsed, res) {
  running = true;
  const { task, model, temp, maxSteps, history, mode } = parsed;
  const modeN = mode === "code" ? "code" : "research"; // กันค่าที่ไม่รู้จัก
  // งานจากคิว: header ส่งไปแล้วตอนส่ง event "queued" — ห้าม writeHead ซ้ำ (throw = ค้าง running)
  if (!res.headersSent) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  }
  const send = (type, data) => {
    try { res.write(`data: ${JSON.stringify({ type, data })}\n\n`); } catch {}
  };
  // ปุ่ม Stop ของ UI → abort → ยกเลิก LLM call + tool ที่กำลังวิ่งจริง
  // (ใช้ response ไม่ใช่ request — req 'close' ไฟร์ตอน body อ่านจบ ไม่ใช่ตอนจบงาน)
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try {
    await keyReady;
    // เลือก model: ถ้า UI ส่งมา ต้อง list ของจริงมีและรองรับ tools
    // (validate จาก data ไม่รับคำมั่นจาก client — แนวทางเดียวกับทุก input ของ agent)
    let useModel = DEFAULT_MODEL;
    if (model) {
      const list = await getModelList();
      const found = list.find((m) => m.id === model && m.tools);
      if (!found) throw new Error(`Model "${model}" not found or doesn't support tool calling`);
      useModel = model;
    }
    CONFIG.model = useModel;
    // settings จาก UI — validate ทุกค่า ไม่เอาหม้อแห้งจาก client
    const useTemp = typeof temp === "number" && temp >= 0 && temp <= 2 ? temp : null;
    const useSteps = Number.isInteger(maxSteps) ? Math.min(Math.max(maxSteps, 4), 24) : undefined;
    // history: Q&A ย้อนหลังของแชตเดียวกัน → agent จำบริบทได้ cross-turn
    // (sanitize: role/content กลั่นมาแล้วตัดสั้น กล่องเก่าถูก agent หั่นอีกทีเอง)
    const cleanHistory = Array.isArray(history)
      ? history
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .slice(-8)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }))
      : [];
    const answer = await agentLoop(task.trim(), {
      depth: 0,
      temp: useTemp,
      maxSteps: useSteps != null ? useSteps : (modeN === "code" ? 24 : undefined),
      mode: modeN, // "research" (default) | "code" (เพิ่ม run_command/file_edit/file_grep + verification gate)
      tools: getTools(modeN),
      history: cleanHistory,
      signal: controller.signal,
      // log ของ agent → ส่งไปหน้าเว็บสด ๆ (ไม่ patch console.log แบบ global —
      // ถ้า patch แล้ว request ที่ถูก abort จะมา restore ทับ patch ของ request ที่วิ่งอยู่)
      onLog: (line) => send("log", line.replace(ANSI_RE, "").trim()),
      // streaming คำตอบ: delta สด → UI (null = ล้างเมื่อโมเดลสลับไป tool call)
      onDelta: (t) => (t === null ? send("answer-reset") : send("answer-delta", t)),
    });
    send("answer", answer);
  } catch (e) {
    // ถูกยกเลิกเอง (ผู้ใช้กด Stop) → ไม่ต้องส่ง error ให้ UI เห็น
    if (!controller.signal.aborted) send("error", e.message || String(e));
  } finally {
    CONFIG.model = DEFAULT_MODEL; // restore — run ถัดไปกลับไปใช้ default
    running = false;
    res.end();
    // คิว: มีงานรออยู่ (และ client ยังต่ออยู่) → เริ่มงานนั้นต่อทันที
    const nxt = queuedItem;
    if (nxt && !nxt.res.writableEnded) { queuedItem = null; try { await runTask(nxt.parsed, nxt.res); } catch { /* ห้ามพังหลัง res.end */ } }
    else { queuedItem = null; if (nxt) { try { nxt.res.end(); } catch {} } }
  }
}

const server = http.createServer(async (req, res) => {  // ---- หน้าเว็บ ----
  if (req.method === "GET" && (req.url === "/" || req.url === "/ui.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "ui.html")));
  }

  // ---- ตัวเลือก model สำหรับหน้า UI ----
  if (req.method === "GET" && req.url === "/api/models") {
    try {
      const list = await getModelList();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ default: DEFAULT_MODEL, models: list }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ---- Circuit 1: playbook ที่ agent เรียนรู้จาก run ที่ล้มเหลว ----
  if (req.method === "GET" && req.url === "/api/playbook") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(playbookSummary()));
  }

  // ---- Circuit 2: tool library (custom tools ที่ agent สร้างเอง) ----
  if (req.method === "GET" && req.url === "/api/skills") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ tools: loadSkills() }));
  }

  // ---- Circuit 3: eval checklists ที่ agent เก็บจากงานที่สำเร็จ ----
  if (req.method === "GET" && req.url === "/api/evals") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(evalSummary()));
  }

  // ---- API: ถาม agent (stream) + คิวรอลึก 1 ----
  if (req.method === "POST" && req.url === "/api/ask") {
    // คิวเต็ม (งานวิ่ง + มีของรอ) → 429 ทันที ระดับ headers กัน race
    if (running && queuedItem) {
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Agent is busy and the queue is full — try again soon" }));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      if (!parsed.task || !String(parsed.task).trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Missing task" }));
      }
      if (running) {
        if (queuedItem) { // กัน race: คิวถูกกินไประหว่างรอ body
          res.writeHead(429, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Agent is busy and the queue is full — try again soon" }));
        }
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const send = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, data })}\n\n`); } catch {} };
        send("queued", "รองานก่อนหน้าเสร็จ — จะเริ่มงานของคุณทันทีเมื่อว่าง");
        const item = { parsed, res };
        res.on("close", () => { if (!res.writableEnded && queuedItem === item) queuedItem = null; }); // client ปิดระหว่างรอคิว → ทิ้ง
        queuedItem = item;
        return;
      }
      await runTask(parsed, res);
    });
    return; // ไม่ให้ไหลต่อไปเจอ handler 404
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

// เปิดพอร์ตต่อเมื่อ key พร้อมเท่านั้น — ไม่จำเป็นต้องรับ request ตั้งแต่ key ยังไม่แน่
keyReady
  .then(() => server.listen(PORT, () => console.log(`Research Agent UI → http://localhost:${PORT}`)))
  .catch(() => process.exit(1));
