const fs = require("node:fs");
const { safePathInRoot } = require("./security-guards.js");

const READ_LIMIT = 120000;
const WRITE_LIMIT = 40000;

function workspaceFilePath(root, rel) {
  const full = safePathInRoot(root, rel);
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error("เลือกได้เฉพาะไฟล์");
  return { full, stat };
}

function readWorkspaceFile(root, rel) {
  const { full, stat } = workspaceFilePath(root, rel);
  if (stat.size > READ_LIMIT) throw new Error("ไฟล์ใหญ่เกิน (สูงสุด 120 KB)");
  return { content: fs.readFileSync(full, "utf8"), bytes: stat.size };
}

function writeWorkspaceFile(root, rel, content) {
  if (typeof content !== "string") throw new Error("เนื้อหาไฟล์ต้องเป็นข้อความ");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > WRITE_LIMIT) throw new Error("เนื้อหาใหญ่เกิน (สูงสุด 40 KB)");
  const { full } = workspaceFilePath(root, rel);
  fs.writeFileSync(full, content, "utf8");
  return { bytes };
}

module.exports = { readWorkspaceFile, writeWorkspaceFile, READ_LIMIT, WRITE_LIMIT };
