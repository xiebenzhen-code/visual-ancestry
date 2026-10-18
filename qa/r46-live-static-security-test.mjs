// P2.7 STEP 4 — live static-server security + regression test (NO provider call).
//
// Starts the real scripts/server.mjs against the PROJECT ROOT (the worst case:
// the original default), with the provider env deliberately EMPTY so a paid
// call is impossible, and the budget ledger pointed at a throwaway file.
//
// Proves: sensitive files are refused, normal assets still serve, and the
// /api/vision routes are still wired (503 when unconfigured).
//
// The key value is never printed — only a boolean "does the body contain it".

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.argv[2] || 4181);
const LEDGER = path.join(process.env.TEMP || ROOT, "va-r46-static-probe.ndjson");

// Real key, read only to test for its ABSENCE in responses.
let KEY = "";
try {
  KEY = (readFileSync(path.join(ROOT, ".env"), "utf8").match(/^\s*VISION_API_KEY\s*=(.*)$/m) || [])[1]?.trim() || "";
} catch {}

const env = { ...process.env };
for (const k of ["VISION_API_BASE", "VISION_API_KEY", "VISION_MODEL", "VISION_ACCESS_CODE", "VISION_ACCESS_SECRET"]) delete env[k];
env.HOST = "127.0.0.1";
env.VISION_BUDGET_FILE = LEDGER;
env.VISION_BUDGET_DAILY = "0";
env.VISION_BUDGET_TOTAL = "0";

// Serve the PROJECT ROOT on purpose: `node scripts/server.mjs . <port>`.
const child = spawn(process.execPath, ["scripts/server.mjs", ".", String(PORT)], {
  cwd: ROOT,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d.toString()));
child.stderr.on("data", (d) => (log += d.toString()));

const base = `http://127.0.0.1:${PORT}`;
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    ready = (await fetch(base + "/healthz")).ok;
  } catch {}
}
console.log(`server ready: ${ready} | root=PROJECT ROOT (worst case) | provider env stripped | port ${PORT}`);

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

async function probe(urlPath) {
  const res = await fetch(base + urlPath, { redirect: "manual" });
  const text = await res.text().catch(() => "");
  return { status: res.status, type: res.headers.get("content-type") || "", len: text.length, body: text };
}

console.log("\n1 \u2014 sensitive files MUST be refused");
{
  const env1 = await probe("/.env");
  check("GET /.env is not 200", env1.status === 404, `status=${env1.status}`);
  check("GET /.env leaks no key bytes", !(KEY && env1.body.includes(KEY)));
  check("GET /.env returns the not-found error shape", /not-found/.test(env1.body), env1.body.slice(0, 80));

  for (const p of ["/.env.example", "/.gitignore", "/.git/config", "/package.json", "/package-lock.json", "/README.md", "/.nojekyll", "/MIGRATION.md", "/DEV_STATE.md"]) {
    const r = await probe(p);
    check(`GET ${p} refused`, r.status === 404, `status=${r.status}`);
  }

  console.log("  -- traversal / encoding bypasses --");
  for (const p of ["/../.env", "/%2e%2e/.env", "/..%2f.env", "/..%5c.env", "/%252e%252e/.env", "/src/../../.env", "/src/main.js%00.env", "/.env?x=1", "/.env#frag"]) {
    const r = await probe(p);
    check(`GET ${p} refused`, r.status === 404 && !(KEY && r.body.includes(KEY)), `status=${r.status}`);
  }

  console.log("  -- sensitive directories --");
  for (const p of ["/server/vision/openaiProvider.mjs", "/server/security/accessControl.mjs", "/scripts/server.mjs", "/scripts/build.mjs", "/qa/r46-deepseek-probe.mjs", "/docs/CORE_V1_FREEZE.md", "/work/iso-build/package.json", "/node_modules/sharp/package.json"]) {
    const r = await probe(p);
    check(`GET ${p} refused`, r.status === 404, `status=${r.status}`);
  }
}

console.log("\n2 \u2014 normal static assets MUST still serve");
{
  const idx = await probe("/");
  check("GET / serves index.html", idx.status === 200 && /Visual Ancestry/.test(idx.body), `status=${idx.status}`);
  check("index.html sent as text/html", idx.type.includes("text/html"), idx.type);

  const app = await probe("/src/main.js");
  check("GET /src/main.js serves", app.status === 200, `status=${app.status}`);
  check("JS sent as text/javascript", app.type.includes("javascript"), app.type);

  const css = await probe("/src/styles/main.css");
  check("GET /src/styles/main.css serves", css.status === 200 && css.len > 0, `status=${css.status} len=${css.len}`);

  const client = await probe("/src/services/vision/visionProvider.js");
  check("browser vision client serves", client.status === 200, `status=${client.status}`);
  check("browser client carries no credentials", !(KEY && client.body.includes(KEY)));

  const cache = await probe("/src/data/visual-intents/artworks.json");
  check("intent cache serves", cache.status === 200 && cache.len > 100, `status=${cache.status}`);

  const art = await probe("/public/assets/artworks/wanderer/thumb.webp");
  check("artwork webp serves", art.status === 200, `status=${art.status}`);
  check("webp content-type correct", art.type.includes("image/webp"), art.type);

  const film = await probe("/public/assets/film/film-s02-the-kid/thumb.webp");
  check("film still webp serves", film.status === 200, `status=${film.status}`);

  const manifest = await probe("/public/assets/artworks/manifest.json");
  check("asset manifest serves", manifest.status === 200, `status=${manifest.status}`);
}

console.log("\n3 \u2014 vision API routes still wired");
{
  const st = await probe("/api/vision/status");
  const parsed = JSON.parse(st.body);
  check("GET /api/vision/status is 200", st.status === 200, `status=${st.status}`);
  check("status reports not-configured honestly (env stripped)", parsed.provider === "not-configured", JSON.stringify(parsed));

  const sess = await fetch(base + "/api/vision/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const sessBody = await sess.json().catch(() => null);
  check("POST /api/vision/session still answers in local-open mode", sess.status === 200 && sessBody && sessBody.ok === true, `status=${sess.status}`);
  check("session response keeps the documented `token` field name", sessBody && "token" in sessBody, JSON.stringify(sessBody));

  const vis = await fetch(base + "/api/vision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mimeType: "image/jpeg", imageBase64: "AAAA" }) });
  const visBody = await vis.json().catch(() => null);
  check("POST /api/vision answers 503 when unconfigured", vis.status === 503, `status=${vis.status}`);
  check("503 carries provider-not-configured", visBody && visBody.error && visBody.error.code === "provider-not-configured", JSON.stringify(visBody));

  const hz = await probe("/healthz");
  check("GET /healthz still 200", hz.status === 200, `status=${hz.status}`);
}

// Ledger must show zero reservations (no paid attempt reached the provider).
let lines = 0;
try {
  lines = readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).length;
} catch {}
console.log("\n4 \u2014 cost");
check("zero budget reservations recorded", lines === 0, `lines=${lines}`);
check("no provider call reached the adapter", !/\[fa-vision-server\]/.test(log));

try {
  child.kill();
} catch {}
setTimeout(() => {
  console.log(`\nlive static + API: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("--- failures ---");
    for (const f of failures) console.log("  " + f);
  }
  process.exit(fail === 0 ? 0 : 1);
}, 500);
