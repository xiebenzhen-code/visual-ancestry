// P2.7.1 STEP 4 — server defaults + hardening test (zero cost, NO provider call).
//
//  A. DIST_DEFAULT  — with no root argument the server serves the BUILT output
//                     (`dist`), not the project directory.
//  B. PORT_SAFETY   — a busy port is a hard error (exit 98). The old behaviour
//                     silently served on port+1; nothing must answer there.
//  C. XFF_TRUST     — `X-Forwarded-For` is client-controlled and MUST NOT be
//                     trusted unless VISION_TRUST_PROXY=1. Rotating a spoofed
//                     value must not hand the caller a fresh rate-limit bucket.
//
// Provider env is stripped in every spawn, so a paid call is impossible.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

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

const PROVIDER_ENV = ["VISION_API_BASE", "VISION_API_KEY", "VISION_MODEL", "VISION_ACCESS_CODE", "VISION_ACCESS_SECRET", "VISION_BRIDGE_TOKEN"];

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of PROVIDER_ENV) delete env[k];
  env.HOST = "127.0.0.1";
  return Object.assign(env, extra);
}

function startServer(args, env) {
  const child = spawn(process.execPath, ["scripts/server.mjs", ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const state = { child, log: "" };
  child.stdout.on("data", (d) => (state.log += d.toString()));
  child.stderr.on("data", (d) => (state.log += d.toString()));
  return state;
}

async function waitForLog(state, re, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const m = state.log.match(re);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function waitReady(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

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

async function portFree(port) {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

// ---- A. DIST_DEFAULT --------------------------------------------------------
console.log("A \u2014 default static root is dist");
{
  const port = await freePort();
  const s = startServer([], cleanEnv({ PORT: String(port) }));
  const m = await waitForLog(s, /Serving (.+?) at http/);
  check("server logged its static root", !!m, s.log.slice(-200));
  if (m) {
    const served = m[1];
    check("default root ends with \\dist", /[\\/]dist$/.test(served), served);
    check("default root is NOT the project directory", path.resolve(served) !== ROOT, served);

    // When a build output exists, prove the default root actually SERVES it.
    if (fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
      check("default server is reachable", await waitReady(port), s.log.slice(-200));
      const home = await fetch(`http://127.0.0.1:${port}/`).catch(() => ({ status: 0 }));
      check("default root serves dist index.html", home.status === 200, `status=${home.status}`);
      const js = await fetch(`http://127.0.0.1:${port}/src/main.js`).catch(() => ({ status: 0 }));
      check("default root serves dist app module", js.status === 200, `status=${js.status}`);
      const noj = await fetch(`http://127.0.0.1:${port}/.nojekyll`).catch(() => ({ status: 0 }));
      check("dist hidden marker is refused", noj.status === 404, `status=${noj.status}`);
    } else {
      console.log("  (no dist build present; skipped live default-root serving checks)");
    }
  }
  try { s.child.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

// ---- B. PORT_SAFETY ---------------------------------------------------------
console.log("B \u2014 busy port is a hard error (no auto-increment)");
{
  // Find a port P whose neighbour P+1 is also free, so "nothing on P+1" is meaningful.
  let P = 0;
  for (let i = 0; i < 20; i++) {
    const candidate = await freePort();
    if (await portFree(candidate + 1)) { P = candidate; break; }
  }
  check("found a free port pair for the test", P > 0, String(P));

  const blocker = http.createServer((_req, res) => res.end("blocker"));
  await new Promise((r) => blocker.listen(P, "127.0.0.1", r));

  const s = startServer([".", String(P)], cleanEnv());
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => resolve("timeout"), 12000);
    s.child.on("close", (c) => { clearTimeout(t); resolve(c); });
  });
  check("process exits instead of drifting", code !== "timeout", String(code));
  check("exit code is 98 (EX_ADDRINUSE)", code === 98, String(code));
  check("stderr explains the busy port", /already in use/i.test(s.log), s.log.slice(-200));
  check("no second process drifted to port+1", await portFree(P + 1), `port ${P + 1} occupied`);

  await new Promise((r) => blocker.close(r));
}

// ---- C. XFF_TRUST -----------------------------------------------------------
console.log("C \u2014 X-Forwarded-For is not trusted by default");
{
  const port = await freePort();
  const ledger = path.join(process.env.TEMP || ROOT, `va-r46-xff-${Date.now()}.ndjson`);
  const s = startServer([".", String(port)], cleanEnv({
    VISION_RATE_LIMIT: "1",
    VISION_RATE_BURST: "1",
    VISION_BUDGET_FILE: ledger,
    VISION_BUDGET_DAILY: "0",
    VISION_BUDGET_TOTAL: "0",
  }));
  const ready = await waitReady(port);
  check("rate-limit probe server is up", ready, s.log.slice(-200));

  const statuses = [];
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/api/vision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${i + 1}` },
      body: JSON.stringify({ mimeType: "image/jpeg", imageBase64: "AAAA" }),
    }).catch(() => ({ status: 0 }));
    statuses.push(res.status);
    await res.text().catch(() => "");
  }
  check("rotating X-Forwarded-For does NOT bypass the rate limit", statuses.includes(429), `statuses=${statuses.join(",")}`);
  check("no paid provider call was made", !/\[fa-vision-server\]/.test(s.log), s.log.slice(-200));

  try { s.child.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

console.log(`\nserver defaults: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("--- failures ---");
  for (const f of failures) console.log("  " + f);
}
process.exit(fail === 0 ? 0 : 1);
