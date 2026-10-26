// v0.4 视觉质量实验 · 池快照构建
//
// 把三处数据接成一份可离线复算的池：
//   .rc1-audit/discovery/index.json     → 512 维向量 + 图像度量（553 条）
//   .rc1-audit/discovery/works.ndjson   → 供应商/许可/来源 URL/本地路径（558 条）
//   src/data/visual-embeddings.json     → 本地 47 件作品的向量
//
// 分桶口径（刻意透明，不隐藏与运行时 taxonomy 的差异）：
//   painting   = imageKind artwork（绘画/版画/摄影作品等）
//   film       = imageKind film-still
//   animation  = imageKind animation-frame
//   anime      = imageKind anime-cover（目录封面，非画面）
//   photo      = imageKind photograph
// 注意：运行时 pickMedium() 把「无 medium 的条目」默认当 artwork，因此产品把
// 194 张 photograph 也算进绘画桶；本实验把它们单列 photo，以便区分
// 「候选库里根本没有对应媒介的素材」与「排序把对的压下去了」。
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(process.argv[2] || ".");
const AUDIT = path.join(REPO, ".rc1-audit", "discovery");
const OUT = path.join(REPO, ".rc1-audit", "p416");
fs.mkdirSync(OUT, { recursive: true });

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const readNdjson = (p) =>
  fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const index = readJson(path.join(AUDIT, "index.json"));
const works = readNdjson(path.join(AUDIT, "works.ndjson"));
const localEmbed = readJson(path.join(REPO, "src", "data", "visual-embeddings.json"));

const bucketOf = (w) => {
  switch (w.imageKind) {
    case "artwork": return "painting";
    case "film-still": return "film";
    case "animation-frame": return "animation";
    case "anime-cover": return "anime";
    case "photograph": return "photo";
    default: return "other";
  }
};

// 供应商 → 媒介的可信度：只有 museum/commons/blender/anilist 的一手来源才算
// 「按媒介采集」，openverse 是聚合搜索，条目媒介由关键词决定，噪声更高。
const bucketCounts = {};
const entries = [];

for (const w of works) {
  const hash = w.imageHash;
  const vec = index.byHash?.[hash]?.vector || null;
  const metrics = index.byHash?.[hash]?.metrics || null;
  const bucket = bucketOf(w);
  bucketCounts[bucket] = (bucketCounts[bucket] || 0) + 1;
  entries.push({
    id: w.id,
    hash,
    bucket,
    provider: w.provider,
    imageKind: w.imageKind,
    title: w.title || "",
    creator: w.creator || "",
    year: w.year ?? null,
    medium: w.medium ?? null,
    licence: w.license || "",
    rightsStatus: w.rightsStatus || "",
    sourceUrl: w.sourceUrl || "",
    imageUrl: w.imageUrl || "",
    storedImage: w.storedImage || "",
    hasVector: Boolean(vec),
    dim: vec ? vec.length : 0,
    metrics,
  });
}

// 本地 47 件（本地档案里的绘画 + 影片画面），向量来自入库的 visual-embeddings
for (const [id, vec] of Object.entries(localEmbed.vectors || {})) {
  const kind = localEmbed.kinds?.[id] || "artwork";
  entries.push({
    id,
    hash: localEmbed.hashes?.[id] || null,
    bucket: kind === "film" ? "film" : "painting",
    provider: "local",
    imageKind: kind,
    title: "",
    creator: "",
    year: null,
    medium: null,
    licence: "local-archive",
    rightsStatus: "",
    sourceUrl: "",
    imageUrl: "",
    storedImage: "",
    hasVector: true,
    dim: vec.length,
    metrics: null,
    local: true,
  });
}

const withVec = entries.filter((e) => e.hasVector);
const byBucket = {};
for (const e of withVec) byBucket[e.bucket] = (byBucket[e.bucket] || 0) + 1;

const out = {
  at: new Date().toISOString(),
  note: "v0.4 离线实验池快照。向量来源见各条目的 provider/hasVector；本地 47 件为 mobileclip_s0_vision_int8。",
  indexModel: index.model,
  indexDim: index.dim,
  counts: {
    totalWorks: works.length,
    totalEntries: entries.length,
    withVector: withVec.length,
    byBucketAll: bucketCounts,
    byBucketWithVector: byBucket,
  },
  entries,
};
fs.writeFileSync(path.join(OUT, "pool.json"), JSON.stringify(out));
console.log("pool.json written:", entries.length, "entries;", withVec.length, "with vectors");
console.log("buckets (all):", JSON.stringify(bucketCounts));
console.log("buckets (vector):", JSON.stringify(byBucket));
console.log("index model:", index.model, "dim:", index.dim);
