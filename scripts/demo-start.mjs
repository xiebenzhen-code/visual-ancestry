// demo-start.mjs — one-command local demo launcher + self-check.
// Usage: node scripts/demo-start.mjs
//   · serves dist/ at http://127.0.0.1:4173 (fails fast if port taken — no auto +1)
//   · prints acceptance steps + links
//   · EXIT 0 only after a self-check GET / returns 200 and body is index.html
//
// This is a NEW launcher script; it does NOT modify server.mjs (frozen baseline).
// It reuses the frozen server.mjs via the same injection trick as preview-server.mjs
// (process.argv[2] = "dist"), but adds a pre-listen port check so that an occupied
// 4173 fails loudly instead of silently serving on 4174.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;

// --- pre-flight: port must be free (fail fast, no auto +1) ---
function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

const distOk = existsSync(join(ROOT, "dist", "index.html"));
if (!distOk) { console.error("[demo-start] dist/index.html missing — run npm run build first."); process.exit(1); }

if (!(await portFree(PORT))) {
  console.error(`[demo-start] 127.0.0.1:${PORT} already in use. Refusing to auto-increment.`);
  console.error("           Stop the occupying process or choose a different port explicitly.");
  process.exit(2);
}

// --- launch frozen server.mjs with root=dist ---
const child = spawn(process.execPath, [join(ROOT, "scripts", "server.mjs"), "dist", String(PORT)], {
  cwd: ROOT, stdio: "inherit",
});

const stop = () => { try { child.kill(); } catch {} };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// --- self-check ---
let ok = false;
for (let i = 0; i < 30 && !ok; i++) {
  try {
    const res = await fetch(BASE + "/");
    const body = await res.text();
    ok = res.status === 200 && body.includes("Visual Ancestry");
  } catch {}
  if (!ok) await sleep(500);
}

if (ok) {
  console.log("\n==============================================");
  console.log("  Visual Archive — LOCAL DEMO READY");
  console.log(`  URL      ${BASE}`);
  console.log("  Boundary 127.0.0.1 only (loopback)");
  console.log("  Try:     #find  (text search · intent panel)");
  console.log("           ⌕      (global search layer)");
  console.log("           #memory (personal visual memory, localStorage)");
  console.log("           #artwork/local:starry (detail + relations)");
  console.log("==============================================\n");
} else {
  console.error("[demo-start] server did not become ready within 15s.");
  process.exit(3);
}

// Keep alive. Exit code is meaningful only on SIGINT; when run interactively the
// user stops it with Ctrl+C. For scripted runs, wrap with timeout(1).
