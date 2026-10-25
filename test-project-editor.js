// test-first contract for safe editor reads and writes within a project root
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-files-test-"));
const ROOT = path.join(TMP, "root");
fs.mkdirSync(ROOT);
fs.writeFileSync(path.join(ROOT, "sample.js"), "const value = 1;\n", "utf8");
fs.writeFileSync(path.join(TMP, "outside.txt"), "protected", "utf8");

const { readWorkspaceFile, writeWorkspaceFile } = require("./workspace-files.js");
function check(name, ok) {
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + name);
  if (!ok) throw new Error(name);
}
try {
  check("reads a file within the project", readWorkspaceFile(ROOT, "sample.js").content.includes("value = 1"));
  const saved = writeWorkspaceFile(ROOT, "sample.js", "const value = 2;\n");
  check("saves edited text within the project", saved.bytes > 0 && fs.readFileSync(path.join(ROOT, "sample.js"), "utf8").includes("value = 2"));
  let escaped = false;
  try { writeWorkspaceFile(ROOT, "../outside.txt", "changed"); } catch { escaped = true; }
  check("rejects writes outside the project", escaped && fs.readFileSync(path.join(TMP, "outside.txt"), "utf8") === "protected");
  let oversized = false;
  try { writeWorkspaceFile(ROOT, "sample.js", "x".repeat(40001)); } catch { oversized = true; }
  check("rejects oversized editor content", oversized);
  console.log("Workspace file helper checks passed.");
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
