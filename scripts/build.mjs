import { cp, mkdir, writeFile, readFile, readdir, unlink, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

// ---------------------------------------------------------------------------
// Security posture (locked by V5.1 P2):
//   - REAL KEYS MUST NEVER enter the browser bundle — no env file, no VITE_*,
//     no public/, no dist/, no localStorage. The browser's only outbound
//     vision call is same-origin POST /api/vision; a server-side adapter
//     (server/vision/openaiProvider.mjs — NOT shipped here) owns the real
//     provider and its server-held secrets (VISION_API_BASE / VISION_API_KEY /
//     VISION_MODEL are server env slots, absent from this build output).
//   - This build therefore NEVER emits any runtime config file with a secret.
//   - QA seam (window.__FA_TEST_VISION) exists ONLY in --qa builds. The
//     production build strips it and fails the build on any forbidden token.
// ---------------------------------------------------------------------------

// --qa keeps the QA test seam for acceptance runs.
const qaMode = process.argv.includes("--qa");

// Lifecycle tokens: must NEVER appear in a production bundle in any form
// (seam, mock fixtures, QA payloads, secret slot names). Declared at module
// top so the guards below can use them (TDZ-safe).
const SEAM_RE = /\/\*__QA_SEAM_START__\*\/[\s\S]*?\/\*__QA_SEAM_END__\*\//g;
const FORBIDDEN_HARD = [
  "__FA_TEST_VISION",
  "__FA_TEST",
  "MOCK_A",
  "MOCK_B",
  "mockVisualIntent",
  "iVBORw0KGgo", // base64 1x1 test-image payload used by P1/P2 QA scripts
  "qa/fixtures",
  "VISION_API_KEY", // secret slot name must not surface in dist
];
// Legal contract tokens — presence is expected in the OpenAI-compatible
// adapter (HTTP header construction). Checked for context, not fatal.
const FORBIDDEN_CONTEXT = ["Authorization", "Bearer", "apiKey", "VA_VISION_", "MOCK", "mock"];

if (!dist.startsWith(root)) {
  throw new Error("Refusing to build outside project root.");
}

await cleanDist(dist);
await mkdir(dist, { recursive: true });
await cp(path.join(root, "index.html"), path.join(dist, "index.html"));
await cp(path.join(root, "src"), path.join(dist, "src"), { recursive: true });
await cp(path.join(root, "public"), path.join(dist, "public"), { recursive: true });
await writeFile(path.join(dist, ".nojekyll"), "");

if (!qaMode) {
  await stripQaSeams(dist);
  await scanForLeaks(dist);
}

console.log(
  qaMode
    ? "Built visual-ancestry/dist (QA mode — test seam kept)"
    : "Built visual-ancestry/dist (production — test seam stripped, no env.js emitted)"
);

// ---------------------------------------------------------------------------

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, out);
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".html")) out.push(p);
  }
  return out;
}

// Gentle, item-by-item removal of the build output directory. Never touches
// personal directories (guarded by the root prefix check), and avoids single
// recursive bulk deletes so the command works identically in every runtime.
async function cleanDist(target) {
  if (!(await stat(target).catch(() => null))) return;
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(target, entry.name);
    if (!p.startsWith(target)) throw new Error("unsafe path");
    if (entry.isDirectory()) await cleanDist(p);
    else await unlink(p);
  }
  await rmdir(target);
}

async function stripQaSeams(distRoot) {
  const files = await walk(distRoot);
  let stripped = 0;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const next = text.replace(SEAM_RE, "");
    if (next !== text) {
      await writeFile(file, next);
      stripped += 1;
    }
  }
  console.log(`Seam strip: ${stripped} file(s) cleaned.`);
}

async function scanForLeaks(distRoot) {
  const files = await walk(distRoot);
  const hard = [];
  const context = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const token of FORBIDDEN_HARD) {
      if (text.includes(token)) hard.push(`${path.relative(root, file)} -> ${token}`);
    }
    for (const token of FORBIDDEN_CONTEXT) {
      if (text.includes(token)) context.push(`${path.relative(root, file)} -> ${token}`);
    }
  }
  if (hard.length) {
    console.error("PRODUCTION LEAK SCAN FAILED:");
    for (const hit of hard) console.error("  " + hit);
    process.exit(1);
  }

  // P4.12 — 产品规则检查：黑白电影影像必须被硬性排除。
  // 为什么放在构建里：dist 是构建产物、不进版本库。源码改对但忘记重建，
  // 用户拿到的仍是旧产物，规则一条都不生效，而仓库看起来完全正确。
  // 这里断言两件事：
  //   1) 产物里不得把原始候选直接赋给 FILM_POOL；
  //   2) 产物里必须存在过滤函数名，说明过滤真的被编译进去了。
  const rawPoolAssign = "const FILM_POOL = filmStillCandidates();";
  const filterMarker = "filterFilmCandidates";
  const policyProblems = [];
  for (const file of files) {
    if (!file.endsWith("retrievalService.js")) continue;
    const text = await readFile(file, "utf8");
    const rel = path.relative(root, file);
    if (text.includes(rawPoolAssign)) policyProblems.push(`${rel} -> 未过滤的 FILM_POOL 赋值`);
    if (!text.includes(filterMarker)) policyProblems.push(`${rel} -> 缺少黑白过滤（filterFilmCandidates）`);
  }
  if (policyProblems.length) {
    console.error("PRODUCT POLICY CHECK FAILED（黑白电影影像硬性排除）:");
    for (const hit of policyProblems) console.error("  " + hit);
    console.error("  修复：确认源码已接入 monochromePolicy，然后重新 `npm run build`。");
    process.exit(1);
  }
  const ctxSummary = context.length
    ? ` (context tokens to review: ${[...new Set(context.map((c) => c.split(" -> ")[1]))].join(", ")})`
    : "";
  console.log(`Leak scan clean: ${files.length} file(s), 0 forbidden tokens${ctxSummary}.`);
}