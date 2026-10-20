// build-embeddings.mjs — P4.14-D 为参考图库预计算视觉向量
//
// 只做三件事：收集真实存在的图片 → 调 Python 嵌入器 → 写一份带内容哈希的 JSON。
// 不联网（模型已缓存），不改动任何既有素材。

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const imp = (r) => import(pathToFileURL(path.join(ROOT, r)).href);

const FIT = process.argv[2] || "pad";
const OUT = path.join(ROOT, "src/data/visual-embeddings.json");
const MANIFEST = path.join(ROOT, ".rc1-audit/p414/embed-manifest.json");

const artworksData = await imp("src/data/artworks.js");
const filmData = await imp("src/data/filmStills.js");
const svc = await imp("src/services/retrieval/retrievalService.js");

const ARTWORKS = (artworksData.artworks || artworksData.default || [])
  .filter((a) => a.image && !a.imageUnavailable);
const FILM_POOL = svc.filmStillPool();

const items = [];
const missing = [];

function pushIfExists(id, relPath, kind) {
  const abs = path.join(ROOT, relPath);
  if (fs.existsSync(abs)) items.push({ id, path: abs, kind });
  else missing.push({ id, relPath, kind });
}

for (const a of ARTWORKS) {
  pushIfExists(a.id, `public/assets/artworks/${a.id}/detail.webp`, "artwork");
}
for (const f of FILM_POOL) {
  const id = f.id || f.artwork?.id;
  pushIfExists(id, `public/assets/film/${id}/detail.webp`, "film");
}

console.log(`图库：绘画 ${ARTWORKS.length}，彩色电影 ${FILM_POOL.length}；找到图片 ${items.length}，缺图 ${missing.length}`);
if (missing.length) for (const m of missing.slice(0, 8)) console.log(`  缺图 ${m.id} → ${m.relPath}`);

fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
fs.writeFileSync(MANIFEST, JSON.stringify(items.map(({ id, path: p }) => ({ id, path: p })), null, 2), "utf8");

const tmpOut = path.join(ROOT, ".rc1-audit/p414/embed-raw.json");
execFileSync("python", ["scripts/p414/embed.py", "--manifest", MANIFEST, "--fit", FIT, "--out", tmpOut], {
  cwd: ROOT,
  stdio: "inherit",
});

const raw = JSON.parse(fs.readFileSync(tmpOut, "utf8"));

// 把 kind 补回去，并保留内容哈希（换图就该换向量）
const kindOf = new Map(items.map((i) => [i.id, i.kind]));
const payload = {
  model: raw.model,
  license: raw.license,
  fit: raw.fit,
  dim: raw.dim,
  generatedAt: new Date().toISOString(),
  note: "预计算的视觉向量。余弦相似度只表示「看起来像」，不等于艺术参考价值。",
  vectors: raw.vectors,
  hashes: raw.hashes,
  kinds: Object.fromEntries(Object.keys(raw.vectors).map((id) => [id, kindOf.get(id) || "artwork"])),
  errors: raw.errors,
};

fs.writeFileSync(OUT, JSON.stringify(payload), "utf8");
const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`写出 ${Object.keys(payload.vectors).length} 条向量 → src/data/visual-embeddings.json (${kb} KB, dim=${payload.dim}, fit=${payload.fit})`);
