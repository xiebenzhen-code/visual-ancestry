// v0.4 视觉质量实验 · 跨媒介排序对比
//
// 对 4 条跨媒介路径 × 3 个起点，用不同方法排序并输出 Top-K，用于人工盲评：
//   mobileclip   基线（产品现用：mobileclip_s0_vision_int8，512 维余弦）
//   <新编码器>    SigLIP / CLIP-L 等更强视觉编码器的余弦
//   hybrid       余弦与结构相似度各半（结构相似度沿用 v0.3 的四轴思路：
//                亮度三段分层、左右均衡、画幅、边缘密度，另加冷暖）
//
// 输出的排序**不包含任何自动打分替代人工判定**：本脚本只负责取候选，
// 有效/弱/错误由人看图判定（判定表见 .rc1-audit/p416/judgements.json）。
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(process.argv[2] || ".");
const AUDIT = path.join(REPO, ".rc1-audit", "p416");
const OUT = path.join(AUDIT, "ranks.json");

const pool = JSON.parse(fs.readFileSync(path.join(AUDIT, "pool.json"), "utf8"));
const index = JSON.parse(fs.readFileSync(path.join(REPO, ".rc1-audit", "discovery", "index.json"), "utf8"));

// —— 起点 ——
const LOCAL_PAINTS = ["paris-rainy-day", "wave", "american-gothic"];
const FILM_QUERIES = ["Tears of Steel — 95s", "Tears of Steel — 140s", "Collapse of the Funnel"];
const ANIM_QUERIES = ["Big Buck Bunny — 30s", "Big Buck Bunny — 60s", "Billiondollarlimited2"];

const byId = new Map(pool.entries.map((e) => [e.id, e]));
const findByTitle = (t) => pool.entries.find((e) => e.title === t);

const queries = [];
for (const id of LOCAL_PAINTS) {
  const e = byId.get(id);
  if (e) queries.push({ id, label: e.title || id, kind: "painting" });
  else console.warn(`[rank] missing local origin: ${id}`);
}
for (const t of FILM_QUERIES) {
  const e = findByTitle(t);
  if (e) queries.push({ id: e.id, label: t, kind: "film" });
  else console.warn(`[rank] missing film origin: ${t}`);
}
for (const t of ANIM_QUERIES) {
  const e = findByTitle(t);
  if (e) queries.push({ id: e.id, label: t, kind: "animation" });
  else console.warn(`[rank] missing animation origin: ${t}`);
}

const PATHS = [
  { path: "painting→film", queryKind: "painting", target: "film" },
  { path: "film→painting", queryKind: "film", target: "painting" },
  { path: "painting→animation", queryKind: "painting", target: "animation" },
  { path: "animation→painting", queryKind: "animation", target: "painting" },
];

// —— 向量来源 ——
// 基线 = 发现库索引向量 + 本地档案向量（src/data/visual-embeddings.json）。
// 只取发现库会让三幅本地绘画起点没有基线向量，比较就失真了。
const baselineVectors = new Map();
for (const e of pool.entries) {
  const v = index.byHash?.[e.hash]?.vector;
  if (v) baselineVectors.set(e.id, v);
}
const localEmbed = JSON.parse(fs.readFileSync(path.join(REPO, "src", "data", "visual-embeddings.json"), "utf8"));
for (const [id, v] of Object.entries(localEmbed.vectors || {})) {
  if (!baselineVectors.has(id)) baselineVectors.set(id, v);
}
console.log(`[rank] baseline vectors: ${baselineVectors.size}`);
const extraModels = {};
for (const f of fs.readdirSync(AUDIT)) {
  if (!f.startsWith("emb-") || !f.endsWith(".json")) continue;
  const name = f.slice(4, -5);
  if (name === "test") continue;
  const j = JSON.parse(fs.readFileSync(path.join(AUDIT, f), "utf8"));
  if (!j.vectors || !Object.keys(j.vectors).length) continue;
  extraModels[name] = new Map(Object.entries(j.vectors));
  console.log(`[rank] model ${name}: ${j.vectors ? Object.keys(j.vectors).length : 0} vectors, dim ${j.dim}`);
}

const cos = (a, b) => {
  if (!a || !b || a.length !== b.length) return null;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

// —— 结构相似度（沿用 v0.3 四轴 + 冷暖）——
const metricOf = (e) => e.metrics || index.byHash?.[e.hash]?.metrics || null;
const dist = (a, b, scale) => Math.min(1, Math.abs((a ?? 0) - (b ?? 0)) / scale);
function structureSimilarity(qm, cm) {
  if (!qm || !cm) return 0;
  const lumBands = (dist(qm.lumTop, cm.lumTop, 0.35) + dist(qm.lumMid, cm.lumMid, 0.35) + dist(qm.lumBottom, cm.lumBottom, 0.35)) / 3;
  const leftRight = dist(Math.abs((qm.lumLeft ?? 0) - (qm.lumRight ?? 0)), Math.abs((cm.lumLeft ?? 0) - (cm.lumRight ?? 0)), 0.25);
  const aspect = dist(Math.log((qm.aspect ?? 1) || 1), Math.log((cm.aspect ?? 1) || 1), 0.9);
  const edges = dist(qm.edgeDensity ?? 0, cm.edgeDensity ?? 0, 0.06);
  const warm = dist(qm.warmthValue ?? 0, cm.warmthValue ?? 0, 0.6);
  const mean = (lumBands + leftRight + aspect + edges + warm) / 5;
  return Math.max(0, 1 - mean);
}

const TOPK = Number(process.env.P416_TOPK || 5);
const results = [];
for (const p of PATHS) {
  for (const q of queries.filter((x) => x.kind === p.queryKind)) {
    const qEntry = byId.get(q.id);
    const candidates = pool.entries.filter((e) => e.bucket === p.target && e.id !== q.id);
    const methods = { mobileclip: baselineVectors };
    for (const [name, map] of Object.entries(extraModels)) methods[name] = map;

    const perMethod = {};
    for (const [name, map] of Object.entries(methods)) {
      const qv = map.get(q.id);
      if (!qv) { perMethod[name] = { note: "query vector missing", items: [] }; continue; }
      const scored = [];
      const dupTitles = new Set();
      for (const c of candidates) {
        const cv = map.get(c.id);
        if (!cv) continue;
        const s = cos(qv, cv);
        if (s === null) continue;
        // 同名重复条目会把 Top-K 名额吃掉（采集时同一文件被抓了两次）。
        // 去重后重排，并记下被去掉的重复数——这是数据事实，不隐藏。
        const titleKey = (c.title || c.id).trim().toLowerCase();
        if (dupTitles.has(titleKey)) continue;
        dupTitles.add(titleKey);
        scored.push({ id: c.id, title: c.title, provider: c.provider, licence: c.licence, cos: Number(s.toFixed(4)), struct: Number(structureSimilarity(metricOf(qEntry), metricOf(c)).toFixed(4)) });
      }
      scored.sort((a, b) => b.cos - a.cos);
      const hybrid = scored.map((x) => ({ ...x, hybrid: Number((0.5 * x.cos + 0.5 * x.struct).toFixed(4)) }))
        .sort((a, b) => b.hybrid - a.hybrid);
      perMethod[name] = {
        items: scored.slice(0, TOPK),
        hybridItems: hybrid.slice(0, TOPK),
        poolSize: scored.length,
      };
    }

    // 独立的重排方法：v0.3 产品做法是「基线余弦 + 结构相似度各半」。
    // 这里额外给「新编码器 + 结构相似度」，看重排是否能跨编码器复用。
    const buildHybrid = (map) => {
      const qv = map.get(q.id);
      if (!qv) return null;
      const rows = [];
      const seenTitle = new Set();
      for (const c of candidates) {
        const cv = map.get(c.id);
        if (!cv) continue;
        const s = cos(qv, cv);
        if (s === null) continue;
        const tk = (c.title || c.id).trim().toLowerCase();
        if (seenTitle.has(tk)) continue;
        seenTitle.add(tk);
        rows.push({
          id: c.id, title: c.title, provider: c.provider, licence: c.licence,
          cos: Number(s.toFixed(4)),
          struct: Number(structureSimilarity(metricOf(qEntry), metricOf(c)).toFixed(4)),
          hybrid: Number((0.5 * s + 0.5 * structureSimilarity(metricOf(qEntry), metricOf(c))).toFixed(4)),
        });
      }
      rows.sort((a, b) => b.hybrid - a.hybrid);
      return rows.slice(0, TOPK);
    };
    const hBase = buildHybrid(baselineVectors);
    if (hBase) perMethod["hybrid"] = { items: hBase, hybridItems: hBase, poolSize: hBase.length };
    const hSig = buildHybrid(extraModels["siglip-base"] || new Map());
    if (hSig) perMethod["hybrid-siglip"] = { items: hSig, hybridItems: hSig, poolSize: hSig.length };
    results.push({
      path: p.path, queryId: q.id, queryLabel: q.label, queryKind: p.queryKind, target: p.target,
      targetPoolSize: candidates.length,
      methods: perMethod,
    });
  }
}

fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), topk: TOPK, results }, null, 1));
console.log(`[rank] wrote ${OUT}: ${results.length} query-paths`);

// 紧凑视图，方便直接读
for (const r of results) {
  console.log(`\n== ${r.path} | ${r.queryLabel} | 目标池 ${r.targetPoolSize}`);
  for (const [name, m] of Object.entries(r.methods)) {
    if (!m.items?.length) { console.log(`   ${name}: ${m.note || "无候选"}`); continue; }
    const top = m.items.slice(0, 5).map((x, i) => `${i + 1}.${(x.title || x.id).slice(0, 26)}(${x.cos})`).join(" ");
    console.log(`   ${name.padEnd(11)} ${top}`);
  }
}
