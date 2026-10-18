// P2.7.1 STEP 4 — symlink / junction guard test (zero cost, NO provider call).
//
// The lexical allow-list (`resolveStaticPath`) approves a path by TEXT, so a
// link planted INSIDE an allowed directory (e.g. `public/leak` -> outside the
// project) would pass it. The real-path gate (`resolveRealStaticPath`) resolves
// the link and refuses anything whose REAL location escapes the allow-list.
//
// This test builds a throwaway root OUTSIDE the repo, plants a directory link
// that escapes and another that stays inside, and proves the guard both refuses
// the escaping link AND still serves the honest one — first as a unit check, then
// through the live HTTP server.
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // the project (for the guard import)

const { resolveStaticPath, resolveRealStaticPath } = await import(
  new URL("../server/security/staticPathGuard.mjs", import.meta.url).href
);

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${label}`);
  } else {
    fail++;
    failures.push(`${label}${detail ? " \u00b7 " + detail : ""}`);
    console.log(`  \u2717 ${label}${detail ? " \u00b7 " + detail : ""}`);
  }
};

// ---- throwaway fixture -----------------------------------------------------
const base = await fsp.mkdtemp(path.join(os.tmpdir(), "va-r46-symlink-"));
const serveRoot = path.join(base, "root");
const outside = path.join(base, "outside");
const sub = path.join(serveRoot, "public", "sub");
const linkEscape = path.join(serveRoot, "public", "leak");
const linkInside = path.join(serveRoot, "public", "alias");
const SECRET = "TOP-SECRET-VA-R46-42";

await fsp.mkdir(path.join(serveRoot, "public"), { recursive: true });
await fsp.mkdir(sub, { recursive: true });
await fsp.mkdir(outside, { recursive: true });
await fsp.writeFile(path.join(serveRoot, "index.html"), "<!doctype html><title>VA R46 probe</title>");
await fsp.writeFile(path.join(serveRoot, "public", "ok.txt"), "INSIDE-OK");
await fsp.writeFile(path.join(sub, "in.txt"), "INSIDE-SUB");
await fsp.writeFile(path.join(outside, "escaped.txt"), SECRET);

const made = [];
// Directory link escaping the serve root (a junction needs no admin on Windows).
try {
  fs.symlinkSync(outside, linkEscape, "junction");
  made.push(linkEscape);
} catch {
  fs.symlinkSync(outside, linkEscape, "dir");
  made.push(linkEscape);
}
try {
  fs.symlinkSync(sub, linkInside, "junction");
  made.push(linkInside);
} catch {
  fs.symlinkSync(sub, linkInside, "dir");
  made.push(linkInside);
}

async function cleanup() {
  for (const link of made) {
    try { fs.rmdirSync(link); } catch {}
  }
  await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
}

try {
  // ---- 1: unit — the escaping link is approved lexically, refused by realpath
  console.log("1 \u2014 real-path gate (unit)");
  {
    const d = resolveStaticPath("/public/leak/escaped.txt", serveRoot);
    check("lexical guard approves the link path (positive control)", d.ok === true, d.ok ? "" : d.reason);
    const real = await resolveRealStaticPath(d.path, serveRoot);
    check("real-path gate refuses the escaping link", real === null, String(real));

    const okD = resolveStaticPath("/public/alias/in.txt", serveRoot);
    check("lexical guard approves the inside link", okD.ok === true, okD.ok ? "" : okD.reason);
    const realOk = await resolveRealStaticPath(okD.path, serveRoot);
    check("real-path gate allows the inside link", typeof realOk === "string" && realOk.endsWith("in.txt"), String(realOk));

    const plain = resolveStaticPath("/public/ok.txt", serveRoot);
    const realPlain = await resolveRealStaticPath(plain.path, serveRoot);
    check("real-path gate allows a plain file", typeof realPlain === "string" && realPlain.endsWith("ok.txt"), String(realPlain));
  }

  // ---- 2: live server — the escape is a 404, the honest asset is a 200 ------
  console.log("2 \u2014 live static server");
  const port = await freePort();
  const env = { ...process.env };
  for (const k of ["VISION_API_BASE", "VISION_API_KEY", "VISION_MODEL", "VISION_ACCESS_CODE", "VISION_ACCESS_SECRET"]) delete env[k];
  env.HOST = "127.0.0.1";
  env.VISION_BUDGET_FILE = path.join(base, "ledger.ndjson");

  const child = spawn(process.execPath, ["scripts/server.mjs", serveRoot, String(port)], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { ready = (await fetch(baseUrl + "/healthz")).ok; } catch {}
  }
  check("server is up", ready, log.slice(-200));

  async function probe(p) {
    const res = await fetch(baseUrl + p, { redirect: "manual" });
    const text = await res.text().catch(() => "");
    return { status: res.status, body: text };
  }

  const esc = await probe("/public/leak/escaped.txt");
  check("escaping symlink is refused (404)", esc.status === 404, `status=${esc.status}`);
  check("escaping symlink leaks no secret bytes", !esc.body.includes(SECRET));

  const inside = await probe("/public/alias/in.txt");
  check("inside link still serves (200)", inside.status === 200 && inside.body.includes("INSIDE-SUB"), `status=${inside.status}`);

  const plainAsset = await probe("/public/ok.txt");
  check("plain allowed asset still serves (200)", plainAsset.status === 200 && plainAsset.body.includes("INSIDE-OK"), `status=${plainAsset.status}`);

  try { child.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 300));
} finally {
  await cleanup();
}

console.log(`\nsymlink guard: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("--- failures ---");
  for (const f of failures) console.log("  " + f);
}
process.exit(fail === 0 ? 0 : 1);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
