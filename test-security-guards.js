const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isPublicAddress, assertPublicHttpUrl, fetchWithPublicRedirects, safePathInRoot } = require("./security-guards.js");
const { getTools } = require("./research-agent.js");

async function main() {
  for (const ip of ["127.0.0.1", "10.2.3.4", "172.20.0.5", "192.168.1.8", "169.254.1.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b:1::1"])
    assert.equal(isPublicAddress(ip), false, `${ip} must be private`);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
    assert.equal(isPublicAddress(ip), true, `${ip} must be public`);
  const memberTools = getTools("code", { trusted: false }).map((t) => t.function.name);
  const adminTools = getTools("code", { trusted: true }).map((t) => t.function.name);
  assert.equal(memberTools.includes("run_command") || memberTools.includes("tool_create"), false);
  assert.equal(adminTools.includes("run_command") && adminTools.includes("tool_create"), true);

  await assert.rejects(assertPublicHttpUrl("file:///etc/passwd"), /Only http/);
  await assert.rejects(assertPublicHttpUrl("http://127.0.0.1/"), /private or reserved/i);
  await assert.rejects(assertPublicHttpUrl("http://secret.example/", async () => [{ address: "10.0.0.8", family: 4 }]), /private or reserved/i);
  assert.equal((await assertPublicHttpUrl("https://example.com/", async () => [{ address: "93.184.216.34", family: 4 }])).hostname, "example.com");

  let called = 0;
  await assert.rejects(fetchWithPublicRedirects("https://public.example/", {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestImpl: async (target) => {
      called++;
      assert.equal(target.address.address, "93.184.216.34", "connection must use the checked DNS address");
      return { status: 302, headers: { get: () => "http://127.0.0.1/admin" } };
    },
  }), /private or reserved/i);
  assert.equal(called, 1, "must reject before fetching redirected internal URL");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-path-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "safe-path-out-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    assert.equal(safePathInRoot(root, "new.txt"), path.join(root, "new.txt"));
    assert.throws(() => safePathInRoot(root, path.join("..", path.basename(outside))), /escapes/);
    try {
      fs.symlinkSync(outside, path.join(root, "linked"), "junction");
      assert.throws(() => safePathInRoot(root, "linked/secret.txt"), /link/);
      fs.symlinkSync(path.join(outside, "not-created.txt"), path.join(root, "dangling.txt"), "file");
      assert.throws(() => safePathInRoot(root, "dangling.txt"), /symbolic link/i);
    } catch (e) {
      if (e.code !== "EPERM" && e.code !== "EACCES") throw e;
      console.log("NOTE symlink check skipped: junction creation is unavailable");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
  console.log("Security guard tests passed.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
