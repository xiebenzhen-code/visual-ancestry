// P2.7 STEP 4 — static path guard unit test (zero cost, no server needed).
// Verifies the allow-list decision function directly: hidden config, traversal,
// encoding tricks and non-allow-listed directories must all be refused, while
// the real app assets must stay servable.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStaticPath, isInsideAllowedRoot, STATIC_DIRS, STATIC_FILES } from "../server/security/staticPathGuard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let pass = 0;
let fail = 0;
const failures = [];

function expectDeny(urlPath, label) {
  const d = resolveStaticPath(urlPath, ROOT);
  if (d.ok) {
    fail++;
    failures.push(`${label}: EXPECTED deny but ALLOWED -> ${d.path}`);
  } else {
    pass++;
  }
}

function expectAllow(urlPath, label) {
  const d = resolveStaticPath(urlPath, ROOT);
  if (d.ok) pass++;
  else {
    fail++;
    failures.push(`${label}: EXPECTED allow but DENIED (${d.reason})`);
  }
}

// ---- MUST BE REFUSED -------------------------------------------------------
expectDeny("/.env", "root dotenv");
expectDeny("/.env.example", "dotenv template");
expectDeny("/.env?x=1", "dotenv with query");
expectDeny("/.git/config", "git dir");
expectDeny("/.gitignore", "gitignore");
expectDeny("/.nojekyll", "nojekyll marker");
expectDeny("/.wbapp_yX2FTNpKIKuoT5qqOXbaKg.genie", "workspace marker");
expectDeny("/src/.env", "dotenv nested in allowed dir");
expectDeny("/public/.env", "dotenv nested in public");
expectDeny("/../.env", "parent traversal");
expectDeny("/src/../../.env", "nested traversal");
expectDeny("/public/../../.env", "traversal from public");
expectDeny("/%2e%2e/.env", "percent-encoded traversal");
expectDeny("/src/%2e%2e/%2e%2e/.env", "nested percent-encoded traversal");
expectDeny("/..%5c.env", "encoded backslash traversal");
expectDeny("/..%2f.env", "encoded slash traversal");
expectDeny("/%252e%252e/.env", "double-encoded traversal (single decode only)");
expectDeny("/src/main.js%00.env", "null byte suffix");
expectDeny("/server/security/errors.mjs", "server sources");
expectDeny("/server/vision/openaiProvider.mjs", "provider adapter");
expectDeny("/scripts/server.mjs", "server script");
expectDeny("/scripts/build.mjs", "build script");
expectDeny("/qa/r46-deepseek-probe.mjs", "qa harness");
expectDeny("/docs/CORE_V1_FREEZE.md", "project docs");
expectDeny("/work/iso-build/package.json", "work archive");
expectDeny("/node_modules/sharp/package.json", "dependencies");
expectDeny("/package.json", "package manifest");
expectDeny("/package-lock.json", "lockfile");
expectDeny("/src/x.key", "sensitive extension in allowed dir");
expectDeny("/src/server.log", "log file in allowed dir");
expectDeny("/index.html.bak", "backup of index");
expectDeny("/README.md", "readme at root");
expectDeny("/src/../.env", "traversal then dotenv");

// ---- MUST STAY SERVABLE ----------------------------------------------------
expectAllow("/", "site root");
expectAllow("/index.html", "index document");
expectAllow("/src/main.js", "app entry module");
expectAllow("/src/styles/main.css", "stylesheet");
expectAllow("/src/services/vision/visionProvider.js", "browser vision client");
expectAllow("/src/data/visual-intents/artworks.json", "intent cache");
expectAllow("/public/assets/artworks/wanderer/detail.webp", "artwork asset");
expectAllow("/public/assets/film/film-s02-the-kid/thumb.webp", "film still asset");
expectAllow("/public/assets/artworks/manifest.json", "asset manifest");
expectAllow("/src", "allowed dir root");
expectAllow("/public", "allowed dir root");
expectAllow("/src/", "allowed dir with trailing slash");

// ---- containment check (post-symlink re-verification) ----------------------
const insideCases = [
  [path.join(ROOT, "src", "main.js"), true, "src file inside"],
  [path.join(ROOT, "public", "x.webp"), true, "public file inside"],
  [path.join(ROOT, "index.html"), true, "index inside"],
  [path.join(ROOT, ".env"), false, "dotenv outside allow list"],
  [path.join(ROOT, "server", "vision", "openaiProvider.mjs"), false, "server source outside"],
  [path.join(ROOT, "src", "..", "..", ".env"), false, "normalized escape outside"],
  [path.join(ROOT, "scripts", "server.mjs"), false, "script outside"],
];
for (const [p, want, label] of insideCases) {
  const got = isInsideAllowedRoot(p, ROOT);
  if (got === want) pass++;
  else {
    fail++;
    failures.push(`containment ${label}: expected ${want} got ${got}`);
  }
}

console.log(`allow-list roots: ${[...STATIC_FILES].join(", ")} + ${[...STATIC_DIRS].join("/, ")}/`);
console.log(`staticPathGuard unit test: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("--- failures ---");
  for (const f of failures) console.log("  " + f);
}
process.exit(fail === 0 ? 0 : 1);
