// harvest.mjs — 自动采集的唯一入口。
//
//   node scripts/discovery/harvest.mjs discover --query "rainy city street" --limit 30
//   node scripts/discovery/harvest.mjs index
//   node scripts/discovery/harvest.mjs verify
//   node scripts/discovery/harvest.mjs status
//
// 职责分工：
//   discover  调用各 provider → 统一记录 → 校验图片 → 去重 → 落库（works.ndjson）
//   index     对已落库但未索引的图片算向量与像素特征（调用 python）
//   verify    检查缓存/索引/图片三者一致
//   status    输出各来源数量、失败与磁盘占用
//
// 任何单个 provider 失败都不会中断整轮——失败写进 runs.ndjson。

import fs from "node:fs";
import path from "node:path";
import { mapLimit, LIMITS } from "./http.mjs";
import { validateImage } from "./validate-image.mjs";
import { isPublishable } from "./normalize.mjs";
import { readWorks, appendWorks, appendRun, readIndex, writeIndex, saveImage, stats, DATA_DIR } from "./store.mjs";
import { museumsProvider } from "./providers/museums.mjs";
import { openverseProvider } from "./providers/openverse.mjs";
import { commonsProvider } from "./providers/commons.mjs";
import { tmdbProvider, tmdbStatus } from "./providers/tmdb.mjs";
import { anilistProvider } from "./providers/anilist.mjs";

const PROVIDERS = {
  museums: museumsProvider,
  openverse: openverseProvider,
  commons: commonsProvider,
  tmdb: tmdbProvider,
  anilist: anilistProvider,
};

const args = process.argv.slice(2);
const mode = args[0] || "status";
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const ROOT = process.cwd();

function normTitle(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ").trim();
}

function workKey(rec) {
  return [normTitle(rec.title), normTitle(rec.creator), normTitle(rec.year)].join("|");
}

/** 三道去重：provider:id、内容哈希、规范化作品身份。 */
function dedupe(records, existing) {
  const byId = new Map(existing.map((w) => [w.id, w]));
  const byHash = new Map(existing.filter((w) => w.imageHash).map((w) => [w.imageHash, w]));
  const byWork = new Map(existing.map((w) => [workKey(w), w]));
  const fresh = [];
  let dupId = 0, dupHash = 0, dupWork = 0;
  for (const rec of records) {
    const wk = workKey(rec);
    if (byId.has(rec.id)) { dupId++; continue; }
    if (rec.imageHash && byHash.has(rec.imageHash)) { dupHash++; continue; }
    if (wk.replace(/\|/g, "") && byWork.has(wk)) { dupWork++; continue; }
    byId.set(rec.id, rec);
    if (rec.imageHash) byHash.set(rec.imageHash, rec);
    if (wk.replace(/\|/g, "")) byWork.set(wk, rec);
    fresh.push(rec);
  }
  return { fresh, dupId, dupHash, dupWork };
}

async function discover() {
  const query = flag("query");
  const limit = Number(flag("limit", "30"));
  const only = (flag("providers", "") || "").split(",").filter(Boolean);
  if (!query) {
    console.error("  需要 --query");
    process.exit(2);
  }
  const selected = only.length ? only.map((p) => PROVIDERS[p]).filter(Boolean) : Object.values(PROVIDERS);
  console.log(`  发现「${query}」，来源 ${selected.map((p) => p.id).join(" / ")}，每源上限 ${limit}`);

  const allRuns = [];
  let all = [];
  for (const provider of selected) {
    const runs = await provider.search(query, { limit });
    for (const run of runs) {
      allRuns.push({ at: new Date().toISOString(), mode: "discover", query, ...run, records: undefined });
      console.log(`   ${run.provider.padEnd(10)} ${String(run.status).padStart(3)} 返回 ${String(run.returned).padStart(3)} ${run.latencyMs}ms${run.error ? " | " + run.error : ""}`);
      all.push(...(run.records || []));
    }
  }

  // 只保留可发布记录（有图 + 尺寸 + 来源 + 权利），再校验图片
  const candidate = all.filter(isPublishable);
  const rejected = all.filter((r) => !isPublishable(r));
  console.log(`  可发布候选 ${candidate.length}，字段不全被拒 ${rejected.length}`);

  const knownIds = new Set(readWorks().map((w) => w.id));
  const toFetch = candidate.filter((r) => !knownIds.has(r.id));
  console.log(`  已入库跳过 ${candidate.length - toFetch.length} 条（不重复下载）`);
  const validated = await mapLimit(toFetch, LIMITS.concurrency, async (rec) => {
    const v = await validateImage(rec.thumbnailUrl || rec.imageUrl);
    if (!v.ok) return { rec, ok: false, error: v.error };
    const stored = saveImage(v.bytes, v.contentType);
    return {
      rec: { ...rec, imageHash: stored.hash, storedImage: stored.rel, width: v.width, height: v.height, validatedAt: new Date().toISOString() },
      ok: true,
    };
  });

  const good = validated.filter((v) => v.ok).map((v) => v.rec);
  const bad = validated.filter((v) => !v.ok);
  console.log(`  图片校验：通过 ${good.length}，失败 ${bad.length}${bad.length ? "（" + bad.slice(0, 2).map((b) => b.error).join("；") + "）" : ""}`);

  const existing = readWorks();
  const { fresh, dupId, dupHash, dupWork } = dedupe(good, existing);
  appendWorks(fresh);
  appendRun({
    at: new Date().toISOString(), mode: "discover", query,
    totals: { raw: all.length, publishable: candidate.length, validated: good.length, rejected: rejected.length, invalid: bad.length, fresh: fresh.length, dupId, dupHash, dupWork },
    sources: allRuns.map((r) => ({ provider: r.provider, status: r.status, returned: r.returned, latencyMs: r.latencyMs, error: r.error || null })),
  });

  console.log(`  去重：新增 ${fresh.length}（重复 id ${dupId} / 同图 ${dupHash} / 同作品 ${dupWork}）`);
  console.log(`  库内合计 ${existing.length + fresh.length} 件`);
}

async function index() {
  const works = readWorks();
  const doc = readIndex();
  doc.byHash = doc.byHash || {};
  const pending = works.filter((w) => w.storedImage && !doc.byHash[w.imageHash]);
  console.log(`  待索引 ${pending.length} / 共 ${works.length}`);
  if (!pending.length) { console.log("  无需索引"); return; }

  const manifest = path.join(DATA_DIR, "index-manifest.json");
  fs.writeFileSync(manifest, JSON.stringify(pending.map((w) => ({ id: w.imageHash, path: w.storedImage })), null, 1), "utf8");

  const embedOut = path.join(DATA_DIR, "index-embed.json");
  const metricsOut = path.join(DATA_DIR, "index-metrics.json");
  const { execFileSync } = await import("node:child_process");
  execFileSync("python", ["scripts/p414/embed.py", "--manifest", path.relative(ROOT, manifest), "--out", path.relative(ROOT, embedOut)], { cwd: ROOT, stdio: "inherit" });
  execFileSync("python", ["scripts/discovery/measure.py", "--manifest", path.relative(ROOT, manifest), "--out", path.relative(ROOT, metricsOut)], { cwd: ROOT, stdio: "inherit" });

  const vec = JSON.parse(fs.readFileSync(embedOut, "utf8"));
  const met = JSON.parse(fs.readFileSync(metricsOut, "utf8"));
  for (const [hash, vector] of Object.entries(vec.vectors || {})) {
    doc.byHash[hash] = { vector, metrics: met.metrics?.[hash] || null, at: new Date().toISOString() };
  }
  doc.model = vec.model || "mobileclip_s0_vision_int8";
  doc.preprocess = `fit=${vec.fit || "pad"}`;
  doc.dim = vec.dim || 512;
  doc.updatedAt = new Date().toISOString();
  writeIndex(doc);
  console.log(`  索引完成：新增 ${pending.length}，累计 ${Object.keys(doc.byHash).length}`);
}

function verify() {
  const works = readWorks();
  const doc = readIndex();
  let missingImage = 0, missingVector = 0, badPath = 0;
  for (const w of works) {
    if (!w.storedImage) { missingImage++; continue; }
    if (!fs.existsSync(path.join(ROOT, w.storedImage))) badPath++;
    if (!doc.byHash?.[w.imageHash]) missingVector++;
  }
  console.log(JSON.stringify({ works: works.length, images: works.length - missingImage, missingVector, badPath, indexEntries: Object.keys(doc.byHash || {}).length }, null, 1));
  if (badPath || missingVector) process.exitCode = 1;
}

function status() {
  const s = stats();
  console.log(JSON.stringify({ ...s, tmdb: tmdbStatus(), dataDir: path.relative(ROOT, DATA_DIR) }, null, 1));
}

const modes = { discover, index, verify, status };
if (!modes[mode]) {
  console.error(`  未知模式：${mode}（discover / index / verify / status）`);
  process.exit(2);
}
await modes[mode]();
