// embed-discovered.mjs — STEP 3：给自动发现的图片算 MobileCLIP 向量，再做一次真实近邻检索
//
// 约束：
//   · 不调用任何付费模型；只跑本地 ONNX（scripts/p414/embed.py）
//   · 向量写进独立实验缓存 .rc1-audit/poc/embeddings.json，不动 src/data/visual-embeddings.json
//   · 按图片内容哈希去重：同一张图不会算两次
//   · 候选必须来自 discovery（用 artworks.js 反查，证明不是本地固定名单）

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const POC = path.join(ROOT, ".rc1-audit/poc");
const imp = (r) => import(pathToFileURL(path.join(ROOT, r)).href);

const decoded = JSON.parse(fs.readFileSync(path.join(POC, "decoded.json"), "utf8"));
const candDoc = JSON.parse(fs.readFileSync(path.join(POC, "candidates.json"), "utf8"));
const byKey = new Map(candDoc.items.map((w) => [w.dedupeKey, w]));

// 只对解码成功的图做向量；按内容哈希去重
const usable = [];
const seenHash = new Map();
for (const [key, rec] of Object.entries(decoded.items)) {
  if (!rec.ok || !rec.path) continue;
  const abs = path.join(ROOT, rec.path);
  if (!fs.existsSync(abs)) continue;
  const hash = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  if (seenHash.has(hash)) continue;
  seenHash.set(hash, key);
  usable.push({ key, hash, path: abs, work: byKey.get(key) });
}

const CACHE = path.join(POC, "embeddings.json");
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : { model: "mobileclip_s0_vision_int8", dim: 512, byHash: {}, meta: {} };

const todo = usable.filter((u) => !cache.byHash[u.hash]);
console.log(`  解码成功 ${usable.length} 张（内容去重后）| 已有向量 ${usable.length - todo.length} | 待算 ${todo.length}`);

if (todo.length) {
  const manifest = todo.map((u) => ({ id: u.hash, path: path.relative(ROOT, u.path).replace(/\\/g, "/") }));
  const mf = path.join(POC, "embed-manifest.json");
  const out = path.join(POC, "embed-batch.json");
  fs.writeFileSync(mf, JSON.stringify(manifest), "utf8");
  const started = Date.now();
  execFileSync("python", ["scripts/p414/embed.py", "--manifest", mf, "--out", out], { cwd: ROOT, stdio: "inherit" });
  const doc = JSON.parse(fs.readFileSync(out, "utf8"));
  for (const [hash, vec] of Object.entries(doc.vectors || {})) cache.byHash[hash] = vec;
  console.log(`  新算 ${Object.keys(doc.vectors || {}).length} 条向量，用时 ${Date.now() - started}ms`);
}
cache.model = "mobileclip_s0_vision_int8";
cache.dim = 512;
cache.updatedAt = new Date().toISOString();
fs.writeFileSync(CACHE, JSON.stringify(cache), "utf8");

/* ---------------- 查询图 ---------------- */
const QUERY = "paris-rainy-day";
const queryPath = path.join(ROOT, "public/assets/artworks", QUERY, "preview.webp");
const qOut = path.join(POC, "embed-query.json");
execFileSync("python", ["scripts/p414/embed.py", "--image", path.relative(ROOT, queryPath).replace(/\\/g, "/"), "--out", qOut], { cwd: ROOT, stdio: "ignore" });
const qDoc = JSON.parse(fs.readFileSync(qOut, "utf8"));
const qVec = Object.values(qDoc.vectors || {})[0];

/* ---------------- 近邻 ---------------- */
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]; return s; };
const ranked = usable
  .map((u) => ({ ...u, cos: dot(qVec, cache.byHash[u.hash] || []) }))
  .filter((x) => Number.isFinite(x.cos))
  .sort((a, b) => b.cos - a.cos);

const localIds = new Set((await imp("src/data/artworks.js")).artworks.map((a) => a.id));
const top = ranked.slice(0, 16).map((r, i) => ({
  rank: i + 1,
  cos: Number(r.cos.toFixed(4)),
  source: r.work.source,
  title: r.work.title,
  artist: r.work.artist,
  year: r.work.year,
  rights: r.work.rights,
  image: r.work.image.tiers?.thumb || r.work.image.url,
  sourceUrl: r.work.sourceUrl,
  fromKeyword: r.work.foundBy?.[0] || null,
  inLocalCatalog: localIds.has(r.work.sourceId) || localIds.has(r.work.dedupeKey),
}));

fs.writeFileSync(path.join(POC, "nn-result.json"), JSON.stringify({
  at: new Date().toISOString(),
  query: { id: QUERY, image: "public/assets/artworks/paris-rainy-day/preview.webp", model: cache.model },
  corpus: { decoded: usable.length, embedded: Object.keys(cache.byHash).length },
  top,
}, null, 2), "utf8");

console.log(`\n  查询：${QUERY}（雨天的巴黎街道）| 语料 ${usable.length} 张自动发现图`);
console.log("  前 12 名：");
for (const r of top.slice(0, 12)) {
  console.log(`   #${String(r.rank).padStart(2)} ${r.cos.toFixed(3)} ${String(r.source).padEnd(10)} ${String(r.title).slice(0, 34).padEnd(34)} ${r.inLocalCatalog ? "(本地也有)" : ""}`);
}
