// freeze-blind-eval.mjs — P4.14-E STEP 6 冻结一次盲评快照
//
// 冻结的是「同一批候选 + 同一套排序」，不是结论。
// 快照里不写任何评分——评分只能由人填。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const imp = (r) => import(pathToFileURL(path.join(ROOT, r)).href);

const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  location: { origin: "http://127.0.0.1", hash: "" },
};
globalThis.localStorage = globalThis.window.localStorage;

const vs = await imp("src/services/features/visualSearch.js");
const emb = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/visual-embeddings.json"), "utf8"));
const svc = await imp("src/services/retrieval/retrievalService.js");

const OUT_DIR = path.join(ROOT, ".rc1-audit/p414/blind");
fs.mkdirSync(OUT_DIR, { recursive: true });

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const fileHash = (rel) => sha256(fs.readFileSync(path.join(ROOT, rel)));

// —— 个人图库从正在运行的服务取（它才是真实持久化状态）
const personalResp = await fetch("http://127.0.0.1:4600/api/library/personal");
const personalJson = await personalResp.json();
const personalItems = (personalJson.items || []).map((it) => ({
  id: it.id,
  hash: it.hash,
  kind: it.kind,
  personal: true,
  vector: it.vector,
  media: {
    medium: it.media?.medium || "artwork",
    visualForm: it.media?.visualForm || "still-image",
    tradition: it.media?.tradition || null,
    imageKind: it.media?.imageKind || "artwork-reproduction",
  },
  structure: null,
  title: it.title || it.id,
  creator: it.creator || "",
  year: it.year || "",
  record: { id: it.id, source: it.source },
}));

const LIB = vs.library();
const byId = new Map(LIB.map((e) => [e.id, e]));

function personalStructure(item) {
  const a = item.width && item.height ? Math.round((item.width / item.height) * 1000) / 1000 : null;
  const orientation = a == null ? null : a > 1.08 ? "landscape" : a < 0.92 ? "vertical" : "square";
  return {
    id: item.id,
    aspect: { aspect: a, orientation, label: null, source: a == null ? "unavailable" : "measured-pixels" },
    figure: { subject: null, scale: null, relation: null, count: null, source: "unavailable" },
    space: { depth: null, environmentDominance: null, negativeSpace: null, source: "unavailable" },
    tone: { lightness: null, saturation: null, warmth: null, source: "unavailable" },
    unavailable: ["arrangement", "occlusion", "props", "figureCount", "subject", "depth", "tone"],
    sources: {},
  };
}
for (const p of personalItems) {
  const raw = personalJson.items.find((x) => x.id === p.id);
  p.structure = personalStructure(raw);
}

// —— 五张查询图
const baseQueries = ["american-gothic", "starry", "wanderer"];
const personalFilm = personalItems.find((p) => p.media.visualForm === "live-action");
const personalAnim = personalItems.find((p) => p.media.visualForm === "animation");

const QUERIES = [
  ...baseQueries.map((id) => ({ kind: "base", id })),
  personalFilm ? { kind: "personal", id: personalFilm.id, label: "用户导入：彩色电影画面" } : null,
  personalAnim ? { kind: "personal", id: personalAnim.id, label: "用户导入：动画／动漫画面" } : null,
].filter(Boolean);

function columnOf(results) {
  return results.map((r, i) => ({
    rank: i + 1,
    id: r.id,
    title: r.title,
    personal: !!r.personal,
    similarity: r.similarity ?? null,
    structureMatch: r.structureMatch ?? null,
    score: r.score ?? null,
  }));
}

const queries = [];
for (const q of QUERIES) {
  const entry = q.kind === "base" ? byId.get(q.id) : personalItems.find((p) => p.id === q.id);
  if (!entry) continue;

  const excludeId = entry.id;
  const B = vs.searchByEmbedding(entry.vector, { limit: 5, excludeId, extraEntries: personalItems });
  const C = vs.searchCombined(entry.vector, entry.structure, { limit: 5, excludeId, extraEntries: personalItems });

  let A = [];
  let aNote = null;
  if (q.kind === "base") {
    const out = svc.retrieveByArtworkChecked(entry.record, { limit: 5 });
    A = out.results || [];
    if (!out.ok) aNote = output_error_note(out.error);
  } else {
    aNote = "个人导入的图没有 VisualIntent，旧算法无法运行";
  }

  queries.push({
    id: entry.id,
    label: q.label || entry.title,
    source: q.kind,
    imageRef: q.kind === "base"
      ? (entry.kind === "film" ? `public/assets/film/${entry.id}/preview.webp` : `public/assets/artworks/${entry.id}/preview.webp`)
      : `/api/user-media/${entry.id}`,
    imageHash: q.kind === "base" ? (emb.hashes[entry.id] || null) : (entry.hash || null),
    columns: {
      A: A.map((r, i) => ({
        rank: i + 1,
        id: r.artwork?.id || null,
        title: r.artwork?.titleZh || r.artwork?.title || null,
        personal: false,
        similarity: null,
        structureMatch: null,
        score: r.retrievalScore ?? null,
        reasons: r.reasons || [],
      })),
      B: columnOf(B.results),
      C: columnOf(C.results),
    },
    aNote,
  });
}

function output_error_note(e) { return `该作品不能作为检索起点（${e}）`; }

const snapshot = {
  format: "p414e-blind-eval",
  version: 1,
  frozenAt: new Date().toISOString(),
  model: {
    name: emb.model, license: emb.license, fit: emb.fit, dim: emb.dim,
  },
  codeHashes: {
    "src/services/features/visualSearch.js": fileHash("src/services/features/visualSearch.js"),
    "src/services/features/structureFeatures.js": fileHash("src/services/features/structureFeatures.js"),
    "src/services/source/mediaTaxonomy.js": fileHash("src/services/source/mediaTaxonomy.js"),
    "experiment/p414/index.html": fileHash("experiment/p414/index.html"),
    "experiment/p414/server.mjs": fileHash("experiment/p414/server.mjs"),
  },
  pool: {
    baseCount: LIB.length,
    personalCount: personalItems.length,
    baseGeneratedAt: emb.generatedAt,
    itemIds: [...LIB.map((e) => e.id), ...personalItems.map((p) => p.id)],
  },
  queries,
  // 评分留空，等用户填。这里不预填任何数字。
  scores: {},
  blindUrl: "http://127.0.0.1:4600/?blind=1",
  note: "本快照只冻结候选与排序。A/B/C 对应哪种算法不在此文件内公开，避免评价时被引导。",
};

fs.writeFileSync(path.join(OUT_DIR, "p414e-blind-snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8");

// 同时输出一份人可读的对照
const md = [];
md.push("# P4.14-E 盲评快照（待评价）");
md.push("");
md.push(`冻结时间：${snapshot.frozenAt}`);
md.push(`候选池：基础 ${snapshot.pool.baseCount} + 个人 ${snapshot.pool.personalCount} = ${snapshot.pool.baseCount + snapshot.pool.personalCount}`);
md.push(`模型：${emb.model} · ${emb.fit} · ${emb.dim} 维 · ${emb.license}`);
md.push("");
md.push("> 评分栏**故意留空**。请只按图片判断「这张作为创作参考值不值得」。");
md.push("");
for (const q of queries) {
  md.push(`## ${q.label}`);
  md.push("");
  md.push(`查询图：\`${q.imageRef}\``);
  md.push("");
  md.push("| 列 | 1 | 2 | 3 | 4 | 5 |");
  md.push("|---|---|---|---|---|---|");
  for (const col of ["A", "B", "C"]) {
    const cells = q.columns[col].map((r) => r.title || r.id || "—");
    md.push(`| ${col} | ${[0,1,2,3,4].map(i => cells[i] || "—").join(" | ")} |`);
  }
  if (q.aNote) md.push(`\n> A 列：${q.aNote}`);
  md.push("");
}
md.push("---");
md.push("");
md.push("## 评价入口");
md.push("");
md.push(`打开 ${snapshot.blindUrl} ，逐张切换查询图，只看图片作答。`);
md.push("评价完成后把结果写回 `p414e-blind-snapshot.json` 的 `scores` 字段（相关 / 部分相关 / 无关 + 备注）。");

fs.writeFileSync(path.join(OUT_DIR, "p414e-blind-summary.md"), md.join("\n") + "\n", "utf8");

console.log(`快照：${queries.length} 张查询图`);
for (const q of queries) {
  console.log(`  ${q.label.slice(0, 22).padEnd(24)} A=${q.columns.A.length} B=${q.columns.B.length} C=${q.columns.C.length}`);
}
console.log("写出 .rc1-audit/p414/blind/p414e-blind-snapshot.json");
console.log("写出 .rc1-audit/p414/blind/p414e-blind-summary.md");
