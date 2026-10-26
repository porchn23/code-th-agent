/**
 * js-eval-runner.js — รันโค้ดที่โมเดลเขียนใน "sandbox" จริง
 * (เรียกจาก toolJsEval ใน research-agent.js — ไม่ควรเรียกตรงจากผู้ใช้)
 *
 * ⚠️ สำเนาจาก js-eval-runner.js ที่รากโปรเจกต์ (Rust port) — ใช้ include_str! ฝังใน binary
 *    ถ้าแก้ไฟล์ต้นฉบับ ต้องคัดลอกมาใหม่ที่นี่ด้วย
 *
 * หลักการ (ทำตามลำดับ):
 *  1. ใช้ node:vm สร้าง context ใหม่ → ไม่มี require / process / fs โดยธรรมชาติ
 *  2. codeGeneration.strings = false → เรียก eval / new Function ใน context ไม่ได้
 *     กันทางหลุดคลาวนี้: this.constructor.constructor('return process')()
 *  3. codeGeneration.wasm = false → กันทางหลุดผ่าน WebAssembly
 *  4. console.log ถูกสร้าง "ภายใน" context เอง — ห้ามส่ง host function เข้าไป!
 *     เพราะ host function จะพา .constructor ของ host realm ติดมาด้วย = ทางหลุด
 *  5. timeout ทั้งใน vm (4s) และที่ process แม่ (5s)
 */

const vm = require("node:vm");
const fs = require("node:fs");

const file = process.argv[2];
let code = "";
try {
  code = fs.readFileSync(file, "utf8");
} catch (e) {
  process.stdout.write("Error: cannot read code file: " + e.message);
  process.exit(0);
}

const sandbox = Object.create(null);
vm.createContext(sandbox, {
  codeGeneration: { strings: false, wasm: false },
  contextCodeGeneration: { strings: false, wasm: false },
});

// สร้าง console ภายใน context เอง (ทั้งหมดอยู่ใน IIFE → ไม่มี lexical global ตกค้าง)
vm.runInContext(
  `(function () {
    globalThis.__logs = [];
    function push(prefix, args) {
      var s = Array.prototype.map.call(args, function (x) {
        return typeof x === "string" ? x : String(x);
      }).join(" ");
      globalThis.__logs.push(prefix + s);
    }
    globalThis.console = {
      log: function () { push("", arguments); },
      info: function () { push("", arguments); },
      warn: function () { push("[warn] ", arguments); },
      error: function () { push("[error] ", arguments); },
    };
    // ตัด WebAssembly ออกให้หมด (codeGeneration.wasm=false ก็บล็อกการ compile
    // อยู่แล้ว แต่ตัดทิ้งเลยจะไม่มีทางหลุดแบบ async)
    try { delete globalThis.WebAssembly; } catch (e) {}
  })();`,
  sandbox
);

// โค้ดผู้ใช้อาจ throw แบบ async (Promise.reject) → ต้องกันไม่ให้ process ตาย
const asyncErrors = [];
process.on("unhandledRejection", (e) => {
  asyncErrors.push("Error: unhandled rejection: " + (e && e.message ? e.message : String(e)));
});

let errText = null;
try {
  vm.runInContext(code, sandbox, { timeout: 4000, displayErrors: true });
} catch (e) {
  errText = "Error: " + (e && e.message ? e.message : String(e));
}

(async () => {
  // รอให้ promise ที่ค้างในโค้ดผู้ใช้ settle ก่อนเก็บผลลัพธ์
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  let out = [];
  try {
    out = Array.from(sandbox.__logs || []);
  } catch {
    out = [];
  }
  if (errText) out.push(errText);
  out.push(...asyncErrors);
  process.stdout.write(out.join("\n"));
})();
