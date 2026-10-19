// build-p411-sample.mjs — P4.11 生成冻结样本清单
//
// 只读仓库素材，产出一份 JSON：8 张候选的真实身份、sha256、许可证据、
// 系统排名，以及 A–H 的盲评字母分配（固定种子随机，可复现）。
//
// 这个脚本本身不写任何产品代码，也不改评分逻辑。它存在的意义是让抽样
// 过程可被别人重跑验证：同样的提交 + 同样的种子 = 同样的 8 张与同样的顺序。

import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
// 输出到 qa/p411（git 跟踪），而不是 .rc1-audit（被 .gitignore 忽略）。
// 理由：盲评页是本轮的核心交付物，换机器必须还在；其余文件也都能由此脚本重建。
const OUT_DIR = path.join(ROOT, "qa", "p411");
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- 固定常量（改动即破坏可复现性，必须同步改 ruleVersion） ----
const RULE_VERSION = "p411-rule-v1";
const ORDER_SEED = 20261019;
const BASE_COMMIT = "8eafcecead445a3f49bf58084d4178677e2105f7";
const QUERY_ID = "american-gothic";

// 技术性排除（在看图之前就由数据确定，理由见 P4.11-SAMPLING-RULE.md）
const META_EXCLUDE = ["wang-ximeng-thousand-li", "xia-gui-streams", "huizong-cranes"];

const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  location: { origin: "http://127.0.0.1", hash: "" },
};
globalThis.localStorage = globalThis.window.localStorage;

// Windows 下 import() 绝对路径必须是 file:// URL，直接用 "c:\\..." 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
const svc = await import(pathToFileURL(path.join(ROOT, "src/services/retrieval/retrievalService.js")).href);
const artData = await import(pathToFileURL(path.join(ROOT, "src/data/artworks.js")).href);
const artworks = artData.artworks || artData.default || [];
const query = artworks.find((a) => String(a.key).includes(QUERY_ID));

if (!query) throw new Error(`query artwork not found: ${QUERY_ID}`);

// ---- 取两个池的真实排序 ----
const artRows = svc
  .retrieveByArtwork(query, { limit: 46, media: "artwork" })
  .filter((r) => !String(r.artwork.key).includes(QUERY_ID))
  .filter((r) => !META_EXCLUDE.includes(r.artwork.id));

const filmRows = svc.retrieveByArtwork(query, { limit: 20, media: "film" });

// ---- 按冻结规则机械取位（互斥分层） ----
const picked = [];
const used = new Set();
function add(layer, row, media) {
  if (!row || used.has(row.artwork.id)) return false;
  used.add(row.artwork.id);
  picked.push({
    layer,
    media,
    artwork: row.artwork,
    systemScore: row.retrievalScore ?? null,
    systemRank: media === "film" ? filmRows.indexOf(row) + 1 : artRows.indexOf(row) + 1,
  });
  return true;
}

add("L1", artRows[0], "artwork");
add("L1", filmRows[0], "film");
add("L2", artRows[1], "artwork");
add("L2", filmRows[1], "film");

const personPool = artRows.filter(
  (r) => r.artwork.shootTranslation?.subjectType === "PERSON" && !used.has(r.artwork.id)
);
const placePool = artRows.filter(
  (r) => r.artwork.shootTranslation?.subjectType === "PLACE" && !used.has(r.artwork.id)
);
add("L3", personPool[0], "artwork");
add("L3", personPool[personPool.length - 1], "artwork");
add("L4", placePool[0], "artwork");
add("L4", placePool[placePool.length - 1], "artwork");

if (picked.length !== 8) {
  throw new Error(`expected 8 candidates, got ${picked.length} — rule changed, stop`);
}

// ---- 固定种子随机顺序（mulberry32，确定性） ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(ORDER_SEED);
const order = picked.map((_, i) => i);
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

// ---- 许可证据：从 LICENSE-ASSETS.md 逐条取 ----
const licenseText = fs.readFileSync(path.join(ROOT, "LICENSE-ASSETS.md"), "utf8");
function licenseFor(id) {
  for (const line of licenseText.split(/\r?\n/)) {
    const cells = line.split("|").map((s) => s.trim());
    if (cells.length > 3 && cells[1] === id) {
      return { license: cells[2], evidenceUrl: cells[3] || null, rawLine: line.trim() };
    }
  }
  return null;
}

// ---- 逐张算 sha256 与尺寸 ----
async function describe(a, media, blindId, layer, systemRank, systemScore) {
  const dir = media === "film" ? "film" : "artworks";
  const base = path.join(ROOT, "public/assets", dir, a.id);
  const tiers = {};
  for (const t of ["thumb", "preview", "detail"]) {
    const p = path.join(base, `${t}.webp`);
    if (!fs.existsSync(p)) continue;
    const meta = await sharp(p).metadata();
    tiers[t] = {
      path: `public/assets/${dir}/${a.id}/${t}.webp`,
      w: meta.width,
      h: meta.height,
      bytes: fs.statSync(p).size,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").toUpperCase(),
    };
  }
  return {
    blindId,
    layer,
    media,
    candidateId: a.id,
    title: a.title,
    titleZh: a.titleZh || null,
    artist: a.artist || null,
    year: a.year || null,
    subjectType: a.shootTranslation?.subjectType || null,
    orientation: a.orientation || null,
    systemRank,
    systemScore,
    // 电影条目的许可在 LICENSE-ASSETS.md §2，字段位置不同，单独标注
    license: licenseFor(a.id) || { license: "见 LICENSE-ASSETS.md §2（电影影像表）", evidenceUrl: null },
    sourceUrl: a.source?.url || a.imageSource?.url || null,
    tiers,
  };
}

const candidates = [];
for (let i = 0; i < 8; i++) {
  const p = picked[order[i]];
  candidates.push(
    await describe(p.artwork, p.media, LETTERS[i], p.layer, p.systemRank, p.systemScore)
  );
}

// 查询图自身
const queryTiers = {};
for (const t of ["thumb", "preview", "detail"]) {
  const p = path.join(ROOT, "public/assets/artworks", QUERY_ID, `${t}.webp`);
  const meta = await sharp(p).metadata();
  queryTiers[t] = {
    path: `public/assets/artworks/${QUERY_ID}/${t}.webp`,
    w: meta.width,
    h: meta.height,
    bytes: fs.statSync(p).size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").toUpperCase(),
  };
}

const sample = {
  sampleId: "p411-american-gothic-v1",
  frozenAt: new Date().toISOString(),
  ruleVersion: RULE_VERSION,
  baseCommit: BASE_COMMIT,
  branch: "exp/p411-visual-relevance-blind",
  orderSeed: ORDER_SEED,
  queryArtwork: {
    candidateId: QUERY_ID,
    title: query.title,
    titleZh: query.titleZh,
    artist: query.artist,
    year: query.year,
    tiers: queryTiers,
    license: licenseFor(QUERY_ID),
  },
  candidates,
  exclusion: META_EXCLUDE.map((id) => ({ candidateId: id, reason: "极端长卷或预览图过小，评分会退化为看不清而非不相似" })),
  note: "A–H 顺序由 orderSeed 固定种子随机生成，与系统排名无关。评分前不得揭示 candidateId。",
};

fs.writeFileSync(path.join(OUT_DIR, "p411-sample.json"), JSON.stringify(sample, null, 2), "utf8");

// ---- 答案表（揭示用，单独存放） ----
const answers = {
  sampleId: sample.sampleId,
  ruleVersion: RULE_VERSION,
  baseCommit: BASE_COMMIT,
  generatedAt: sample.frozenAt,
  map: candidates.map((c) => ({
    blindId: c.blindId,
    candidateId: c.candidateId,
    title: c.title,
    artist: c.artist,
    year: c.year,
    media: c.media,
    layer: c.layer,
    systemRank: c.systemRank,
    systemScore: c.systemScore,
  })),
};
fs.writeFileSync(path.join(OUT_DIR, "p411-answers.json"), JSON.stringify(answers, null, 2), "utf8");

// ---- 复制图片为不透明文件名（src 路径不含作品 id） ----
const IMG_DIR = path.join(OUT_DIR, "img");
fs.mkdirSync(IMG_DIR, { recursive: true });
const imageManifest = { generatedAt: sample.frozenAt, sampleId: sample.sampleId, files: {} };

function copyTier(srcRel, dstName, meta) {
  const src = path.join(ROOT, srcRel);
  const dst = path.join(IMG_DIR, dstName);
  fs.copyFileSync(src, dst);
  imageManifest.files[dstName] = {
    sha256: crypto.createHash("sha256").update(fs.readFileSync(dst)).digest("hex").toUpperCase(),
    bytes: fs.statSync(dst).size,
    ...meta,
  };
}
copyTier(sample.queryArtwork.tiers.preview.path, "query.webp", {
  role: "query", candidateId: sample.queryArtwork.candidateId, sourcePath: sample.queryArtwork.tiers.preview.path,
});
for (const c of candidates) {
  copyTier(c.tiers.preview.path, `cand-${c.blindId}.webp`, {
    role: "candidate", blindId: c.blindId, layer: c.layer,
    candidateId: c.candidateId, sourcePath: c.tiers.preview.path,
  });
}
fs.writeFileSync(path.join(OUT_DIR, "p411-image-manifest.json"), JSON.stringify(imageManifest, null, 2), "utf8");

// ---- 空白评分模板（全 null，绝不预填） ----
const blank = {
  format: "p411-blind-scores", version: 1,
  status: "EMPTY — 等待用户评分",
  sampleId: sample.sampleId, ruleVersion: RULE_VERSION, rubricVersion: "p411-rubric-v1",
  baseCommit: BASE_COMMIT, orderSeed: ORDER_SEED,
  design: { scorers: 1, candidates: 8, sessions: 1, scale: "0-3 + NA" },
  note: "未填写的模板。真实评分由用户在 blind-review.html 完成后导出，文件名形如 p411-scores-*.json。不要把本文件当作已采集数据。",
  scores: Object.fromEntries(candidates.map((c) => [c.blindId, { D1: null, D2: null, D3: null, D4: null }])),
  why: Object.fromEntries(candidates.map((c) => [c.blindId, ""])),
};
fs.writeFileSync(path.join(OUT_DIR, "p411-scores-EMPTY.json"), JSON.stringify(blank, null, 2), "utf8");

// ---- 基线排序（评分后才应查看） ----
const baseline = {
  sampleId: sample.sampleId, baseCommit: BASE_COMMIT,
  note: "评分完成后才查看。只记录两个基线的排列，不含任何人工评分。",
  baselineA: {
    name: "现有系统 VisualIntent 排序（retrieveByArtwork）",
    order: [...answers.map].sort((a, b) => a.systemRank - b.systemRank)
      .map((m) => ({ blindId: m.blindId, systemRank: m.systemRank, systemScore: m.systemScore, media: m.media })),
  },
  baselineB: {
    name: "P4.10 实验性像素距离排序",
    status: "UNAVAILABLE",
    reason: "P4.10 的效度检验证明该描述子无法区分「同图裁切」与「不同画面」（重叠 0.0423），因此不参与排序，样本也未记录 pixelDistance。此项是「无数据」，不是「表现差」。",
  },
};
fs.writeFileSync(path.join(OUT_DIR, "p411-baseline-order.json"), JSON.stringify(baseline, null, 2), "utf8");

console.log("sample written:", path.join(OUT_DIR, "p411-sample.json"));
console.log("images copied:", Object.keys(imageManifest.files).length);
console.log("blank template:", path.join(OUT_DIR, "p411-scores-EMPTY.json"));
console.log("\n=== A–H 分配（盲评顺序） ===");
for (const c of candidates) {
  console.log(
    `  ${c.blindId}  ${c.layer}  ${String(c.media).padEnd(7)}  rank=${String(c.systemRank).padStart(2)} score=${String(c.systemScore).padStart(5)}  [id hidden]`
  );
}
