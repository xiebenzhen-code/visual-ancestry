// P5.3.2 STEP 2 — upload reliability stress (real provider, isolated store).
// Focus is NOT the success rate but the FAILURE CLOSURE:
//   failed → persisted → user sees reason → retry → success
// Every upload is a real POST /api/vision. One manual retry per failed card
// (P5.1.8 product semantics). `expectedVisualLanguage` NEVER leaves the
// manifest — only the image file is uploaded.
// Honest scale: 70 images (A30 + B40); category C unavailable (see manifest).
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const STRESS = path.join(ROOT, "work", "p5.3.2-stress");
const STORE_DIR = path.join(STRESS, "store");
const OUT = path.join(STRESS, "upload-results.json");
const BASE = "http://127.0.0.1:4175";
process.env.MEMORY_STORE_DIR = STORE_DIR;

const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(STRESS, "manifest.json"), "utf8"));
const { uploadFromImage } = await import(
  pathToFileURL(path.join(ROOT, "src", "services", "memory", "uploadService.js")).href
);
const { listMemories } = await import(
  pathToFileURL(path.join(ROOT, "src", "services", "memory", "memoryRepository.js")).href
);

// resolve the real file path for each manifest item
function resolveFile(item) {
  const rel = item.source;
  if (rel.startsWith("reuse:P5.2.4")) return path.join(ROOT, "work", "p5.2.4-usage-validation", "materials", "film", path.basename(rel));
  if (rel.startsWith("reuse:P5.1.7")) return path.join(ROOT, "work", "p5.1.7-materials", "C-art", path.basename(rel));
  return path.join(STRESS, rel);
}

const items = manifest.items;
console.log(`stress upload: ${items.length} images · serial · isolated store=${path.relative(ROOT, STORE_DIR)}`);

const results = [];
let ok1 = 0;
for (const item of items) {
  const file = resolveFile(item);
  let r;
  const t0 = Date.now();
  try {
    r = await uploadFromImage(file, {
      base: BASE,
      id: item.id,
      title: item.title,
      origin: item.category === "A-film" ? "film-still" : "artwork-reference",
      note: "P5.3.2 stress",
    });
  } catch (err) {
    r = { ok: false, error: { code: "exception", message: String(err && err.message || err) } };
  }
  const seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
  const ok = !!(r.ok && r.memory && r.memory.status === "success");
  if (ok) ok1++;
  results.push({
    id: item.id, category: item.category, attempt: 1, ok, seconds,
    error: !ok && r.error ? { code: r.error.code, message: r.error.message } : null,
  });
  console.log(`[pass1] ${item.id} ${ok ? "OK" : "FAIL"} ${seconds}s${ok ? "" : " · " + (r.error ? r.error.code : "?")}`);
}

// one manual retry per failed card (product semantics)
const retryResults = [];
for (const rec of results.filter((x) => !x.ok)) {
  const item = items.find((i) => i.id === rec.id);
  const file = resolveFile(item);
  let r;
  const t0 = Date.now();
  try {
    r = await uploadFromImage(file, {
      base: BASE, id: item.id, title: item.title,
      origin: item.category === "A-film" ? "film-still" : "artwork-reference",
      note: "P5.3.2 stress retry",
    });
  } catch (err) {
    r = { ok: false, error: { code: "exception", message: String(err && err.message || err) } };
  }
  const seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
  const ok = !!(r.ok && r.memory && r.memory.status === "success");
  rec.retry = 1;
  rec.ok = ok;
  rec.seconds = seconds;
  rec.error = !ok && r.error ? { code: r.error.code, message: r.error.message } : null;
  retryResults.push({ id: rec.id, attempt: 2, ok, seconds, error: !ok && r.error ? r.error.code : null });
  console.log(`[retry] ${rec.id} ${ok ? "RECOVERED" : "STILL-FAILED"} ${seconds}s`);
}

// final store state + failure closure accounting
const all = await listMemories();
const ourIds = new Set(items.map((i) => i.id));
const ours = all.filter((m) => ourIds.has(m.id));
const finalSuccess = ours.filter((m) => m.status === "success").length;
const finalFailed = ours.filter((m) => m.status === "failed").length;

const failedFirst = results.filter((x) => !x.ok).length;
const recovered = retryResults.filter((x) => x.ok).length;
const allErrors = results.flatMap((x) => (x.error ? [x.error.code] : [])).concat(retryResults.flatMap((x) => (x.error ? [x.error] : [])));
const errorCodeTally = allErrors.reduce((m, c) => { m[c] = (m[c] || 0) + 1; return m; }, {});
const latencies = results.map((x) => x.seconds);

const summary = {
  note: "P5.3.2 STEP 2 upload reliability stress — real provider, serial, isolated store",
  scale: { requested: 100, actual: items.length, reason: "C 类不可得 → 70 张诚实降级" },
  total: items.length,
  success: ok1,
  failed: failedFirst,
  retryRecovered: recovered,
  firstPassRate: Number((ok1 / items.length).toFixed(3)),
  finalSuccess,
  finalFailed,
  finalSuccessRate: Number((finalSuccess / items.length).toFixed(3)),
  avgLatency: Number((latencies.reduce((s, x) => s + x, 0) / items.length).toFixed(1)),
  totalLatencySeconds: Number(latencies.reduce((s, x) => s + x, 0).toFixed(1)),
  failureClosure: {
    definition: "failed → 保存记录 → 用户看到原因 → retry → success",
    failedPersisted: finalSuccess + finalFailed === items.length ? "全部失败项均持久化（failed 也占位可重试）" : "⚠️ 有失败项未持久化",
    errorCodesVisible: errorCodeTally,
    retried: retryResults.length,
    recovered,
    closureRate: retryResults.length ? Number((recovered / retryResults.length).toFixed(3)) : null,
    stillFailedIds: results.filter((x) => !x.ok).map((x) => `${x.id}:${x.error ? x.error.code : "?"}`),
  },
  results,
  retryResults,
};
await writeFile(OUT, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(`\n==== 首传 ${ok1}/${items.length} (${summary.firstPassRate}) · retry 恢复 ${recovered}/${retryResults.length} · 终态 ${finalSuccess}/${items.length} (${summary.finalSuccessRate}) ====`);
console.log(`avg ${summary.avgLatency}s · error codes: ${JSON.stringify(errorCodeTally)}`);
console.log(`→ ${OUT}`);
