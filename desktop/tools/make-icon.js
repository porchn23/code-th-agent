/**
 * สร้างไอคอน PNG (1024x1024) สำหรับ Tauri — ไม่ต้องใช้ dependency ภายนอก
 * ใช้: node tools/make-icon.js <output.png>
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIZE = 1024;

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// ---------- canvas ----------
const px = Buffer.alloc(SIZE * SIZE * 4);

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const na = a / 255;
  px[i] = Math.round(px[i] * (1 - na) + r * na);
  px[i + 1] = Math.round(px[i + 1] * (1 - na) + g * na);
  px[i + 2] = Math.round(px[i + 2] * (1 - na) + b * na);
  px[i + 3] = Math.max(px[i + 3], a);
}

function hex(h) {
  return [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
}

function fillBackground() {
  const top = hex("#1b2b40");
  const bottom = hex("#0b0f16");
  for (let y = 0; y < SIZE; y++) {
    const t = y / (SIZE - 1);
    const r = Math.round(top[0] + (bottom[0] - top[0]) * t);
    const g = Math.round(top[1] + (bottom[1] - top[1]) * t);
    const b = Math.round(top[2] + (bottom[2] - top[2]) * t);
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
}

function circle(cx, cy, rad, color, alpha = 255) {
  const [r, g, b] = color;
  for (let y = Math.floor(cy - rad) - 1; y <= cy + rad + 1; y++) {
    for (let x = Math.floor(cx - rad) - 1; x <= cx + rad + 1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= rad) {
        const edge = Math.min(1, rad - d);
        set(x, y, r, g, b, Math.round(255 * Math.max(0, edge)) * (alpha / 255));
      }
    }
  }
}

function roundRect(x0, y0, w, h, radius, color, alpha = 255) {
  const [r, g, b] = color;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const dx = Math.max(x0 + radius - x, x - (x0 + w - 1 - radius), 0);
      const dy = Math.max(y0 + radius - y, y - (y0 + h - 1 - radius), 0);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= radius) {
        const edge = Math.min(1, radius - d);
        set(x, y, r, g, b, Math.round(255 * Math.max(0, edge)) * (alpha / 255));
      }
    }
  }
}

function rect(x0, y0, w, h, color, alpha = 255) {
  const [r, g, b] = color;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      set(x, y, r, g, b, alpha);
    }
  }
}

// ---------- วาด ----------
const CYAN = hex("#4a9eff");
const WHITE = hex("#eaf2ff");
const DARK = hex("#0d1117");

fillBackground();
rect(0, 0, SIZE, 12, CYAN, 210);

// เสาอากาศ + หัวไฟ
rect(SIZE / 2 - 10, 150, 20, 90, CYAN);
circle(SIZE / 2, 150, 34, CYAN);
circle(SIZE / 2, 150, 16, WHITE);

// หัวหุ่นยนต์
roundRect(220, 250, 584, 430, 96, CYAN);
roundRect(268, 306, 488, 318, 56, DARK);
circle(392, 420, 52, WHITE);
circle(632, 420, 52, WHITE);
circle(392, 420, 22, CYAN);
circle(632, 420, 22, CYAN);
roundRect(430, 556, 164, 26, 13, WHITE, 170);

// แถบคีย์บอร์ด
roundRect(180, 720, 664, 120, 44, CYAN, 205);
for (let i = 0; i < 5; i++) {
  rect(226 + i * 120, 756, 78, 48, DARK, 220);
}

// ---------- เขียน PNG ----------
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = process.argv[2] || path.join(__dirname, "..", "app-icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`เขียน ${out} (${png.length} bytes, ${SIZE}x${SIZE})`);
