/**
 * ตัวหยั่งคีย์ OpenRouter (utility) — node check-key.js
 * อ่าน .openrouter_key (หลายบรรทัด = หลายคีย์), ตรวจว่า key ไหน:
 *  1) valid (GET /api/v1/key ฟรี, ไม่กิน credit)
 *  2) web plugin `:online` ใช้ได้ (echo 502/ข้ามได้ — สำคัญที่ 402 กับ 2xx)
 * เลือกคีย์ดีสุดตามลำดับ: `:online` OK > เครดิตเหลือมากสุด
 * แสดงคีย์ที่เลือกโดยไม่แก้ไฟล์ต้นฉบับ; ใช้ --write เมื่อต้องการเขียนคีย์ที่เลือกทับไฟล์
 * ไม่พิมพ์คีย์เต็มออกจอ = กัน leak ผ่าน log
 */
const fs = require("node:fs");
const path = require("node:path");
const base = "https://openrouter.ai/api/v1";
const keyFile = path.join(__dirname, ".openrouter_key");

const mask = (k) => `${k.slice(0, 6)}...${k.slice(-4)}`;
const creditLeft = (d) => (d.limit == null ? 1e12 : (d.limit || 0) - (d.usage || 0));

async function meta(key) {
  const res = await fetch(base + "/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data: data?.data || {} };
}

async function onlineProbe(key) {
  try {
    const res = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: (process.env.OPENROUTER_MODEL || "nvidia/nemotron-3.5-super-vl:free") + ":online",
        messages: [{ role: "user", content: 'Search the web now for: "node.js current version". List top 3 results with title, URL, one-sentence summary. Output only the list.' }],
        max_tokens: 400,
      }),
      signal: AbortSignal.timeout(90000),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, err: e.message };
  }
}

(async () => {
  const keys = fs.readFileSync(keyFile, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!keys.length) { console.error("ไฟล์คีย์ว่าง"); process.exit(1); }
  console.log("พบคีย์ในไฟล์:", keys.length, "ตัว");

  const cands = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const m = await meta(k);
    const d = m.data;
    if (!m.ok) { console.log(`#${i + 1} ${mask(k)} คีย์ไม่ valid (HTTP ${m.status})`); continue; }
    console.log(`#${i + 1} ${mask(k)} valid — label=${d.label || "-"} limit=${String(d.limit)} usage=${String(d.usage)}`);
    const on = await onlineProbe(k);
    console.log(`    :online → ${on.status === 200 ? "OK ✅ (web plugin ใช้ได้)" : `HTTP ${on.status} ${on.status === 402 ? "❌ ต้องซื้อ credit" : "(transient อื่น ~ ลองใหม่)"}`}`);
    cands.push({ k, onlineOK: on.status === 200, left: creditLeft(d) });
  }
  if (!cands.length) { console.error("ไม่มีคีย์ไหนใช้ได้เลย"); process.exit(1); }

  cands.sort((a, b) => (b.onlineOK - a.onlineOK) || (b.left - a.left));
  const best = cands[0];
  console.log(`เลือกคีย์: ${mask(best.k)} (${best.onlineOK ? "`:online` ใช้ได้" : "เครดิตเหลือมากสุด — web plugin ยังไม่ได้"})`);

  if (process.argv.includes("--write") && (keys.length > 1 || keys[0] !== best.k)) {
    fs.writeFileSync(keyFile, best.k + "\n");
    console.log("เขียน .openrouter_key ทับแล้ว (คีย์เดียว)");
  } else if (keys.length > 1 || keys[0] !== best.k) {
    console.log("ไฟล์ยังไม่ถูกแก้ — หากต้องการเขียนคีย์นี้ทับ ให้รัน node check-key.js --write");
  } else {
    console.log("ไฟล์คีย์อยู่ถูกของแล้ว — ไม่แตะต้อง");
  }
})();
