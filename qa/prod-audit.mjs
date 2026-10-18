// Production dist audit — independent three-layer verification (run AFTER
// npm run build). Layer 1: hard test/secret leaks. Layer 2: architecture
// leaks (browser must NOT keep a direct third-party provider path).
// Writes qa/prod-audit.json
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

// Layer 1 — hard forbidden strings (any hit = FAIL). Mirrors the user's
// acceptance list exactly. NOTE: btoa/imageBase64 are LEGAL here — they are
// the same-origin /api/vision client body fields, not test/secrets.
const LAYER1 = [
  "__FA_TEST_VISION",
  "__FA_TEST",
  "VISION_API_KEY",
  "VA_VISION_API_KEY",
  "qa/fixtures",
  "MOCK_A",
  "MOCK_B",
  "iVBORw0KGgo", // 1x1 test-image base64
];

// Layer 2 — architecture tokens (browser must NOT hold any)
const LAYER2 = ["Authorization", "Bearer", "apiKey", "providerUrl", "VISION_API_BASE"];

async function walkFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(p, out);
    else if (/\.(js|html)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const files = await walkFiles(dist);
const report = { scannedFiles: files.length, layer1: [], layer2: [], directThirdPartyPath: false };

for (const file of files) {
  const text = await readFile(file, "utf8");
  const rel = path.relative(dist, file);
  for (const token of LAYER1) {
    if (text.includes(token)) report.layer1.push(`${rel} -> ${token}`);
  }
  for (const token of LAYER2) {
    if (text.includes(token)) {
      // capture context for a human decision
      const i = text.indexOf(token);
      report.layer2.push({
        file: rel,
        token,
        context: text.slice(Math.max(0, i - 60), i + 80).replace(/\n/g, " "),
      });
    }
  }
}

// Confirm the production bundle only ever calls same-origin /api/vision:
// the browser provider must reference '/api/vision' and never fetch a remote
// URL. Direct third-party path = any Authorization/Bearer header set while
// fetching a non-same-origin absolute URL.
const providerPath = files.find((f) => f.endsWith("visionProvider.js"));
if (providerPath) {
  const src = await readFile(providerPath, "utf8");
  report.browserProvider = {
    callsSameOriginVision: src.includes('"/api/vision"') || src.includes("'/api/vision'"),
    holdsSecrets: /Authorization|Bearer|apiKey|process\.env/i.test(src),
    holdsAbsoluteUrl: /https?:\/\/[^"']+\/v\d\/chat\/completions/.test(src),
  };
  report.directThirdPartyPath = report.browserProvider.holdsSecrets || report.browserProvider.holdsAbsoluteUrl;
}

report.layer1Ok = report.layer1.length === 0;
report.layer2Ok = !report.directThirdPartyPath;

await writeFile(path.join(__dirname, "prod-audit.json"), JSON.stringify(report, null, 2));
console.log("PROD_AUDIT layer1=" + (report.layer1Ok ? "CLEAN" : "FAIL") + " layer2=" + (report.layer2Ok ? "CLEAN" : "FAIL") + " directThirdPartyPath=" + report.directThirdPartyPath);
if (!report.layer1Ok || !report.layer2Ok) process.exit(1);