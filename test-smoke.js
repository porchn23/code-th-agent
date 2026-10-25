/**
 * test-smoke.js — smoke test ฝั่ง server (HTTP surface จริง, ไม่ต้องใช้เครดิต)
 *
 * ตรวจ:
 *   1) GET /            → 200 + หน้า UI
 *   2) GET /api/models  → 200 + JSON ที่มีรายการโมเดล
 *   3) GET /ไม่รู้จัก    → 404 (กัน handler รั่วลงไปเจอ 404 ตอน POST ทำงาน)
 *   4) POST /api/ask ที่ไม่มี task → 400 (guard ของ input ทำงาน)
 *   5) ทุก route ที่ไม่รู้จักต้องเป็น 404 ไม่ใช่ 500/หลุด
 *
 * หมายเหตุ: ใส่ key ปลอมเป็น env เพราะ /api/models เป็น public endpoint ของ OpenRouter
 *           → ไม่ต้องใช้เครดิตจริง และไม่ยิง LLM ใน test นี้เลย
 *
 * exit code: 0 = ผ่าน / 1 = ไม่ผ่าน
 */

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "sk-smoke-test-placeholder";

const { spawn } = require("node:child_process");
const path = require("node:path");

const PORT = 8787;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// รอให้ server ฟังพอร์ต
async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

(async () => {
  // กันกลืน server ของ developer: ถ้าพอร์ตถูกใช้อยู่แล้ว "ก่อน" spawn → แจ้งและยอมแพ้ ไม่เชื่อผลปลอม
  try {
    const pre = await fetch(`http://localhost:${PORT}/`);
    if (pre.ok) {
      console.log(`  FAIL  พอร์ต ${PORT} มี server รันอยู่แล้ว (อาจเป็น dev server)`);
      console.log("        → ปิด dev server ก่อน (หรือเปลี่ยน PORT ในไฟล์นี้) แล้วรัน smoke test ใหม่");
      process.exit(1);
    }
  } catch {} // ยังว่าง = ปกติ

  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    cwd: __dirname, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let serverOut = "";
  child.stdout.on("data", (d) => { serverOut += d.toString(); });
  child.stderr.on("data", (d) => { serverOut += d.toString(); });

  const finish = (code) => {
    try { child.kill(); } catch {}
    process.exit(code);
  };

  const up = await waitForServer();
  if (!up) {
    console.log("  FAIL  server ไม่ยอมฟังพอร์ต " + PORT);
    console.log(serverOut);
    finish(1);
  }
  console.log("  server boot: OK");

  // 1) หน้า UI
  const page = await fetch(`http://localhost:${PORT}/`);
  const html = await page.text();
  check("1 GET / → 200 + หน้า UI", page.status === 200 && html.includes("Research Agent"),
    "status=" + page.status);

  // 2) รายการโมเดล
  const mr = await fetch(`http://localhost:${PORT}/api/models`);
  const mj = await mr.json();
  check("2 GET /api/models → 200 + มีโมเดล", mr.status === 200 && Array.isArray(mj.models) && mj.models.length > 0,
    `status=${mr.status} models=${mj.models ? mj.models.length : "?"}`);

  // 3) route ที่ไม่รู้จัก
  const nr = await fetch(`http://localhost:${PORT}/definitely-not-a-route`);
  check("3 route ไม่รู้จัก → 404", nr.status === 404, "status=" + nr.status);

  // 4) POST /api/ask ที่ไม่มี task → 400
  const ar = await fetch(`http://localhost:${PORT}/api/ask`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
  });
  check("4 POST /api/ask ไม่มี task → 400", ar.status === 400, "status=" + ar.status);

  // 5) POST /api/ask ที่ body มั่ว → ต้องไม่ 500
  const br = await fetch(`http://localhost:${PORT}/api/ask`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json",
  });
  check("5 POST /api/ask body มั่ว → 400 (ไม่ใช่ 500)", br.status === 400, "status=" + br.status);

  const failed = results.filter((r) => !r.ok);
  console.log("\n===== สรุป =====");
  console.log(`ผ่าน ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log("FAIL:");
    failed.forEach((f) => console.log("  - " + f.name));
    finish(1);
  }
  console.log("ทุกข้อผ่าน ✓");
  finish(0);
})().catch((e) => {
  console.error("FATAL ใน smoke test:", e && e.stack ? e.stack : e);
  process.exit(1);
});
