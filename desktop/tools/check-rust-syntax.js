/**
 * ตัวตรวจ syntax แบบ static สำหรับโค้ด Rust (ไม่ต้องมี cargo)
 * เช็ค: bracket balance หลังตัด comment / string / char literal / raw string
 *
 * ใช้: node desktop/tools/check-rust-syntax.js
 */
const fs = require("fs");
const path = require("path");

function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith(".rs")) out.push(p);
  }
  return out;
}

function strip(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    // line comment
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // block comment
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // raw string: r"..." / r#"..."#
    if (c === "r" && (d === "#" || d === '"')) {
      let j = i + 1;
      let hashes = 0;
      while (src[j] === "#") {
        hashes++;
        j++;
      }
      if (src[j] === '"') {
        j++;
        const term = '"' + "#".repeat(hashes);
        const end = src.indexOf(term, j);
        if (end < 0) {
          out += src.slice(i);
          i = n;
          break;
        }
        out += " ".repeat(end + term.length - i);
        i = end + term.length;
        continue;
      }
    }
    // normal string
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    // char literal (vs lifetime 'a)
    if (c === "'") {
      let j = i + 1;
      if (src[j] === "\\") j += 2;
      else j++;
      if (src[j] === "'") {
        j++;
        out += " ".repeat(j - i);
        i = j;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function checkFile(f) {
  const src = fs.readFileSync(f, "utf8");
  const s = strip(src);
  const stack = [];
  const pairs = { ")": "(", "]": "[", "}": "{" };
  let line = 1;
  for (const ch of s) {
    if (ch === "\n") line++;
    if (ch === "(" || ch === "[" || ch === "{") {
      stack.push([ch, line]);
    } else if (ch === ")" || ch === "]" || ch === "}") {
      const top = stack.pop();
      if (!top) {
        return `extra '${ch}' at line ${line}`;
      }
      if (top[0] !== pairs[ch]) {
        return `mismatch '${top[0]}' (opened line ${top[1]}) vs '${ch}' (line ${line})`;
      }
    }
  }
  if (stack.length) {
    const t = stack[stack.length - 1];
    return `unclosed '${t[0]}' opened at line ${t[1]} (depth ${stack.length})`;
  }
  return null;
}

const root = path.resolve(__dirname, "..", "src-tauri", "src");
const files = walk(root);
let bad = 0;
for (const f of files) {
  const issue = checkFile(f);
  const rel = path.relative(path.resolve(__dirname, "..", ".."), f);
  if (issue) {
    console.log(`✗ ${rel}: ${issue}`);
    bad++;
  } else {
    console.log(`✓ ${rel}`);
  }
}
console.log(
  bad
    ? `\n${bad}/${files.length} ไฟล์มีปัญหา`
    : `\nผ่านทั้งหมด ${files.length} ไฟล์ — bracket balance ปกติ`
);
process.exit(bad ? 1 : 0);
