// P5.1.8 STEP 6 — real-use backtest: re-run the SAME 20 materials from P5.1.7
// through the P5.1.8 upload service (real bridge, isolated store), then retry
// every failed item ONCE (product semantics: one manual retry per failed card)
// and measure success rate / failure recovery rate / user operation cost.
//
// Deliberately NOT mocked: each upload is a real POST /api/vision call.
// Uses MEMORY_STORE_DIR=work/p5.1.8-store — never touches P5.1.5/P5.1.7 data.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const MATERIALS_DIR = path.join(ROOT, "work", "p5.1.7-materials");
const STORE_DIR = path.join(ROOT, "work", "p5.1.8-store");
process.env.MEMORY_STORE_DIR = STORE_DIR;

// id → relative material file (same mapping as P5.1.7)
const MATERIALS = [
  ["ruv-a01", "A-film/ruv-a01-metropolis-helm.png"],
  ["ruv-a02", "A-film/ruv-a02-metropolis-set.png"],
  ["ruv-a03", "A-film/ruv-a03-crowd-fairground.jpg"],
  ["ruv-a04", "A-film/ruv-a04-crowd-still.jpg"],
  ["ruv-c01", "C-art/ruv-c-american-gothic.webp"],
  ["ruv-c02", "C-art/ruv-c-birth-of-venus.webp"],
  ["ruv-c03", "C-art/ruv-c-fan-kuan-travelers.webp"],
  ["ruv-c04", "C-art/ruv-c-hasui-zojoji-snow.webp"],
  ["ruv-c05", "C-art/ruv-c-hiroshige-shower.webp"],
  ["ruv-c06", "C-art/ruv-c-impression-sunrise.webp"],
  ["ruv-c07", "C-art/ruv-c-ma-yuan-angler.webp"],
  ["ruv-c08", "C-art/ruv-c-milkmaid.webp"],
  ["ruv-c09", "C-art/ruv-c-nighthawks.webp"],
  ["ruv-c10", "C-art/ruv-c-paris-rainy-day.webp"],
  ["ruv-c11", "C-art/ruv-c-scream.webp"],
  ["ruv-c12", "C-art/ruv-c-starry.webp"],
  ["ruv-c13", "C-art/ruv-c-wanderer.webp"],
  ["ruv-c14", "C-art/ruv-c-wang-ximeng-thousand-li.webp"],
  ["ruv-c15", "C-art/ruv-c-wave.webp"],
  ["ruv-c16", "C-art/ruv-c-xia-gui-streams.webp"],
];

const TITLES = {
  "ruv-a01": "大都会·头盔", "ruv-a02": "大都会·布景", "ruv-a03": "人群·游乐场", "ruv-a04": "人群·静止",
  "ruv-c01": "美国哥特式", "ruv-c02": "维纳斯的诞生", "ruv-c03": "旅行中的范宽", "ruv-c04": "洗井·增上寺雪景",
  "ruv-c05": "广重·骤雨", "ruv-c06": "印象·日出", "ruv-c07": "马远·独钓", "ruv-c08": "倒牛奶的女仆",
  "ruv-c09": "夜莺", "ruv-c10": "巴黎·雨天", "ruv-c11": "呐喊", "ruv-c12": "星月夜",
  "ruv-c13": "雾海上的漫游者", "ruv-c14": "千里江山", "ruv-c15": "神奈川冲浪里", "ruv-c16": "夏圭·溪山清远",
};

async function run() {
  await mkdir(STORE_DIR, { recursive: true });
  const { uploadFromImage } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "uploadService.js")).href
  );
  const { listMemories } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "memoryRepository.js")).href
  );

  const results = [];
  for (const [id, rel] of MATERIALS) {
    const file = path.join(MATERIALS_DIR, rel);
    const t0 = Date.now();
    const r = await uploadFromImage(file, {
      id,
      title: TITLES[id] || id,
      origin: id.startsWith("ruv-a") ? "film-still" : "artwork-reference",
      note: "P5.1.8 STEP6 backtest",
    });
    const latencyMs = Date.now() - t0;
    results.push({
      id,
      attempt: 1,
      ok: r.ok,
      status: r.memory ? r.memory.status : (r.error ? "failed" : "unknown"),
      error: r.error ? { code: r.error.code, message: r.error.message } : null,
      latencyMs,
    });
    console.log(`[attempt1] ${id} ${r.ok ? "OK" : "FAIL"} (${latencyMs}ms)${r.error ? " · " + r.error.code : ""}`);
  }

  // one manual retry per failed item (P5.1.8 STEP 2 product rule)
  const failed = results.filter((x) => !x.ok);
  const retried = [];
  for (const item of failed) {
    const [id] = [item.id];
    const rel = MATERIALS.find(([i]) => i === id)[1];
    const file = path.join(MATERIALS_DIR, rel);
    const t0 = Date.now();
    const r = await uploadFromImage(file, {
      id,
      title: TITLES[id] || id,
      origin: id.startsWith("ruv-a") ? "film-still" : "artwork-reference",
      note: "P5.1.8 STEP6 backtest · retry",
    });
    const latencyMs = Date.now() - t0;
    retried.push({ id, attempt: 2, ok: r.ok, status: r.memory ? r.memory.status : "failed", error: r.error ? { code: r.error.code, message: r.error.message } : null, latencyMs });
    console.log(`[retry]   ${id} ${r.ok ? "RECOVERED" : "STILL-FAILED"} (${latencyMs}ms)${r.error ? " · " + r.error.code : ""}`);
  }

  // final store state
  const all = await listMemories();
  const finalOk = all.filter((m) => m.status === "success").length;
  const finalFailed = all.filter((m) => m.status === "failed").length;

  const ok1 = results.filter((x) => x.ok).length;
  const recovered = retried.filter((x) => x.ok).length;
  const totalOkFinal = all.filter((m) => m.status === "success").length;

  const summary = {
    total: MATERIALS.length,
    firstPassSuccess: ok1,
    firstPassFailed: MATERIALS.length - ok1,
    firstPassRate: Number((ok1 / MATERIALS.length).toFixed(3)),
    retried: retried.length,
    recoveredByRetry: recovered,
    recoveryRate: retried.length ? Number((recovered / retried.length).toFixed(3)) : null,
    finalSuccess: totalOkFinal,
    finalFailed,
    finalSuccessRate: Number((totalOkFinal / MATERIALS.length).toFixed(3)),
    totalLatencyMsAttempt1: results.reduce((s, x) => s + x.latencyMs, 0),
    results,
    retried,
  };

  await writeFile(path.join(ROOT, "work", "p5.1.8-upload-results.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log("\n================================");
  console.log(`P5.1.8 STEP6 backtest: 首传 ${ok1}/${MATERIALS.length} (${summary.firstPassRate}) → retry 恢复 ${recovered}/${retried.length} → 终态成功 ${totalOkFinal}/${MATERIALS.length} (${summary.finalSuccessRate})`);
  console.log(`结果已写入 work/p5.1.8-upload-results.json`);
}

run().catch((e) => { console.error(e); process.exit(1); });