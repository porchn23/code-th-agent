const dns = require("node:dns").promises;
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

const blockedV4 = new net.BlockList();
for (const [range, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blockedV4.addSubnet(range, prefix, "ipv4");
const blockedV6 = new net.BlockList();
for (const [range, prefix] of [
  ["::", 96], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blockedV6.addSubnet(range, prefix, "ipv6");

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  return !(family === 4 ? blockedV4 : blockedV6).check(address, family === 4 ? "ipv4" : "ipv6");
}

async function resolvePublicHttpUrl(raw, lookup = dns.lookup) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new Error("Invalid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http:// or https:// URLs are allowed");
  if (url.username || url.password) throw new Error("URL credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))
    throw new Error("Private or reserved network destinations are not allowed");
  const directFamily = net.isIP(host);
  let addresses;
  if (directFamily) addresses = [{ address: host, family: directFamily }];
  else {
    try { addresses = await lookup(host, { all: true, verbatim: true }); }
    catch { throw new Error("Could not resolve public host"); }
  }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some((item) => !isPublicAddress(item.address)))
    throw new Error("Private or reserved network destinations are not allowed");
  return { url, address: addresses[0] };
}

async function assertPublicHttpUrl(raw, lookup = dns.lookup) {
  return (await resolvePublicHttpUrl(raw, lookup)).url;
}

function requestPinned({ url, address }, { signal, headers = {}, maxBytes = 2 * 1024 * 1024 } = {}) {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: "GET",
      headers,
      servername: net.isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
      lookup(_hostname, _opts, callback) { callback(null, address.address, address.family || net.isIP(address.address)); },
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { req.destroy(new Error("Response body exceeds 2 MB")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({
        status: res.statusCode || 0,
        ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
        headers: { get: (name) => res.headers[String(name).toLowerCase()] || null },
        text: async () => Buffer.concat(chunks).toString("utf8"),
      }));
      res.on("error", reject);
    });
    const abort = () => req.destroy(signal.reason || new Error("Request aborted"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    req.on("close", () => signal?.removeEventListener("abort", abort));
    req.on("error", reject);
    req.end();
  });
}

async function fetchWithPublicRedirects(raw, { fetchImpl, requestImpl = requestPinned, lookup = dns.lookup, maxRedirects = 5, ...options } = {}) {
  let target = await resolvePublicHttpUrl(raw, lookup);
  for (let redirects = 0; ; redirects++) {
    const response = fetchImpl
      ? await fetchImpl(target.url, { ...options, redirect: "manual" })
      : await requestImpl(target, options);
    const location = response.headers?.get?.("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
    if (redirects >= maxRedirects) throw new Error("Too many redirects");
    target = await resolvePublicHttpUrl(new URL(location, target.url).href, lookup);
  }
}

function safePathInRoot(root, rel) {
  const lexicalRoot = path.resolve(root);
  const abs = path.resolve(lexicalRoot, String(rel || ""));
  const relative = path.relative(lexicalRoot, abs);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error("Path escapes the project directory");
  const realRoot = fs.realpathSync(lexicalRoot);
  let cursor = lexicalRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let linkStat;
    try { linkStat = fs.lstatSync(cursor); } catch { break; }
    if (linkStat.isSymbolicLink()) throw new Error("Symbolic links are not allowed in workspace paths");
  }
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) throw new Error("Path has no existing parent");
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  const realRelative = path.relative(realRoot, realProbe);
  if (realRelative === ".." || realRelative.startsWith(".." + path.sep) || path.isAbsolute(realRelative))
    throw new Error("Path escapes the project directory through a link");
  return abs;
}

module.exports = { isPublicAddress, assertPublicHttpUrl, fetchWithPublicRedirects, safePathInRoot };
