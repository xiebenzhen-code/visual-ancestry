// recall-multipath.mjs — P4.15.1 多路候选召回（实验）
//
// 问题：单靠 MobileCLIP 向量排前 N，会把「视觉上其实可参考、但向量不占优」的
// 候选永久挡在门外；而且两对作品的向量完全相同（fan-kuan ≡ shitao、
// guo-xi ≡ fuchun），纯向量路径根本无法把它们分开。
//
// 三条路径并行召回，再融合：
//   1. vector     —— 图像向量余弦（MobileCLIP）
//   2. structure  —— 已有结构特征逐维比较（构图/主体/空间的可比维度）
//   3. observable —— 像素实测的可观察语义（明度、对比、饱和、冷暖、分区明度、
//                    边缘密度、对称度）。这一路不是模型语义：这一轮禁止付费调用，
//                    V2 分析只对少数图片有缓存，所以用确定性像素测量替代，
//                    并在结果里标明来源，不冒充模型判断。
//
// 融合用 RRF（reciprocal rank fusion）：只看名次，不看分数尺度，
// 避免把余弦和结构分硬拼成一个没有意义的加数。
// 每条候选保留「哪几路召回的、各路名次、以及可读理由」，便于复核。

import fs from "node:fs";
import path from "node:path";
import {
  library, searchByEmbedding, searchByStructure, passMedia, mediaLabel,
} from "../../src/services/features/visualSearch.js";

export const RECALL_PATHS = Object.freeze(["vector", "structure", "observable"]);
const RRF_K = 60;

let cachedObs = null;
let cachedObsPath = null;
/** 读可观察特征表；缺失时第三条路径自动降级，不报错。缓存按路径区分。 */
export function loadObservables(root) {
  const p = path.join(root, "experiment/p415/observables.json");
  if (cachedObs && cachedObsPath === p) return cachedObs;
  try {
    cachedObs = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    cachedObs = { format: 0, entries: {} };
  }
  cachedObsPath = p;
  return cachedObs;
}

/** 可观察特征之间的距离与可读理由。权重要能解释，不能是玄学。 */
const OBS_WEIGHTS = {
  aspect: 1.0,      // 形制（长卷 vs 竖幅）几乎是硬指标
  meanLum: 1.2,
  contrast: 1.2,
  meanSat: 1.0,
  warmthValue: 1.0,
  hue: 0.8,         // 色族不同再罚一点
  lumBottom: 0.6,   // 竖向明度分布 ≈ 构图重心
  lumTop: 0.6,
  edgeDensity: 0.5,
  asymmetry: 0.4,
};

function obsDistance(a, b) {
  let sum = 0, wsum = 0;
  const parts = [];
  for (const [k, w] of Object.entries(OBS_WEIGHTS)) {
    const va = a[k], vb = b[k];
    if (typeof va === "number" && typeof vb === "number") {
      // aspect 用对数比，避免长卷把距离拉爆
      const d = k === "aspect" ? Math.min(1, Math.abs(Math.log((va || 1) / (vb || 1))) / Math.log(6)) : Math.abs(va - vb);
      sum += w * d; wsum += w;
    }
  }
  if (a.hue && b.hue && a.hue !== b.hue) { sum += OBS_WEIGHTS.hue * 0.6; }
  wsum += OBS_WEIGHTS.hue * 0.6;
  return wsum ? sum / wsum : 1;
}

/** 把距离翻成人能读懂、能核对的话。 */
function obsReason(q, c) {
  const bits = [];
  const dLum = Math.abs(q.meanLum - c.meanLum);
  if (dLum < 0.12) bits.push(`明度接近（${q.meanLum.toFixed(2)} / ${c.meanLum.toFixed(2)}）`);
  if (q.warmth === c.warmth) bits.push(`同为${q.warmth === "warm" ? "暖" : q.warmth === "cool" ? "冷" : "中性"}调`);
  if (Math.abs(q.meanSat - c.meanSat) < 0.1) bits.push(`饱和度接近（${q.meanSat.toFixed(2)} / ${c.meanSat.toFixed(2)}）`);
  const aspRatio = (q.aspect || 1) / (c.aspect || 1);
  if (aspRatio > 0.75 && aspRatio < 1.33) bits.push("画幅比例相近");
  else if (aspRatio >= 1.33 || aspRatio <= 0.75) bits.push(`形制差异大（${q.aspect} : ${c.aspect}）`);
  if (Math.abs(q.lumBottom - c.lumBottom) < 0.12) bits.push("下部明度分布相近（构图重心同侧）");
  if (bits.length === 0) bits.push("仅整体明暗接近");
  return bits.join("，");
}

/**
 * 三路召回 + RRF 融合。
 * @returns {{candidates: object[], paths: object, note: string|null}}
 */
export function multipathRecall({
  queryEntry, extraEntries = [], media = "all", limit = 12, root,
  perPath = 12,
} = {}) {
  const obs = loadObservables(root);
  const qObs = obs.entries?.[queryEntry.id] || null;
  const paths = { vector: 0, structure: 0, observable: 0, skipped: [] };

  const byId = new Map();
  const add = (entry, pathName, rank, score, reason) => {
    const cur = byId.get(entry.id) || { entry, sources: [] };
    cur.sources.push({ path: pathName, rank, score: score ?? null, reason });
    byId.set(entry.id, cur);
  };

  // ---- 路径 1：向量
  if (Array.isArray(queryEntry.vector) && queryEntry.vector.length) {
    const r = searchByEmbedding(queryEntry.vector, { media, limit: perPath, excludeId: queryEntry.id, extraEntries });
    r.results.forEach((e, i) => {
      add(e, "vector", i + 1, e.similarity, `向量相似度 ${e.similarity}`);
    });
    paths.vector = r.results.length;
  } else {
    paths.skipped.push({ path: "vector", why: "查询没有可用向量" });
  }

  // ---- 路径 2：结构
  if (queryEntry.structure) {
    const r = searchByStructure(queryEntry.structure, { media, limit: perPath, excludeId: queryEntry.id, extraEntries });
    r.results.forEach((e, i) => {
      const dims = e.samePoints?.length || 0;
      add(e, "structure", i + 1, e.structureMatch,
        `结构 ${dims} 处一致${e.structureComparable != null ? `（可比 ${e.structureComparable} 维）` : ""}`);
    });
    paths.structure = r.results.length;
  } else {
    paths.skipped.push({ path: "structure", why: "查询没有结构特征" });
  }

  // ---- 路径 3：可观察语义
  if (qObs) {
    const pool = library().concat(extraEntries);
    const scored = [];
    for (const e of pool) {
      if (e.id === queryEntry.id) continue;
      if (!passMedia(e, media)) continue;
      const o = obs.entries?.[e.id];
      if (!o) continue;
      const d = obsDistance(qObs, o);
      scored.push({ e, d });
    }
    scored.sort((a, b) => a.d - b.d);
    scored.slice(0, perPath).forEach(({ e, d }, i) => {
      const o = obs.entries[e.id];
      add(e, "observable", i + 1, Math.round((1 - d) * 1000) / 1000, obsReason(qObs, o));
    });
    paths.observable = Math.min(perPath, scored.length);
  } else {
    paths.skipped.push({ path: "observable", why: "查询没有实测特征（例如上传图尚未测量）" });
  }

  // ---- 融合 + 去重
  const merged = [];
  for (const [id, rec] of byId) {
    let fused = 0;
    for (const s of rec.sources) fused += 1 / (RRF_K + s.rank);
    const vec = byId.get(id); // 自身
    merged.push({
      entry: rec.entry,
      id,
      fused: Math.round(fused * 10000) / 10000,
      sources: rec.sources.sort((a, b) => a.rank - b.rank),
      fromPaths: rec.sources.map((s) => s.path),
      multiPath: rec.sources.length > 1,
    });
  }
  merged.sort((a, b) => b.fused - a.fused);

  // 向量孪生：两幅不同作品向量完全相同 → 纯向量无法区分，标出来
  const twinIndex = new Map();
  for (const m of merged) {
    const v = m.entry.vector;
    if (!Array.isArray(v)) continue;
    const key = v.map((x) => Math.round(x * 1e4)).join(",").slice(0, 4000);
    if (!twinIndex.has(key)) twinIndex.set(key, []);
    twinIndex.get(key).push(m.id);
  }
  for (const m of merged) {
    const v = m.entry.vector;
    if (!Array.isArray(v)) continue;
    const key = v.map((x) => Math.round(x * 1e4)).join(",").slice(0, 4000);
    const twins = (twinIndex.get(key) || []).filter((x) => x !== m.id);
    if (twins.length) m.vectorTwinOf = twins;
  }

  const note = merged.length === 0
    ? (media === "all" ? "库里没有可比较的候选" : `「${media}」下没有可比较的候选`)
    : null;

  return { candidates: merged.slice(0, limit), paths, note };
}

/**
 * 从融合列表里挑出要送进模型比较的候选。
 *
 * 纯按融合分取前 N 会有个副作用：某一路的强项（比如向量第 3 名）会被
 * 另外两路的高分候选沉到 N 名之外，于是「扩大召回」反而把上一轮唯一可用的
 * 候选换掉了。这里先每路各取第一名，再按融合分补齐，保证比较集不全是同一路。
 */
export function selectForComparison(candidates, judgeCount) {
  const picked = [];
  const seen = new Set();
  const bestPerPath = new Map();
  for (const c of candidates) {
    for (const s of c.sources) {
      const cur = bestPerPath.get(s.path);
      if (!cur || s.rank < cur.rank) bestPerPath.set(s.path, { c, rank: s.rank });
    }
  }
  for (const p of RECALL_PATHS) {
    const best = bestPerPath.get(p);
    if (best && !seen.has(best.c.id) && picked.length < judgeCount) {
      picked.push(best.c); seen.add(best.c.id);
    }
  }
  for (const c of candidates) {
    if (picked.length >= judgeCount) break;
    if (!seen.has(c.id)) { picked.push(c); seen.add(c.id); }
  }
  return picked;
}

/** 给前端/报告用的紧凑视图。 */
export function compactCandidate(m) {
  return {
    id: m.id,
    title: m.entry.title,
    media: mediaLabel(m.entry),
    fused: m.fused,
    fromPaths: m.fromPaths,
    multiPath: m.multiPath,
    vectorTwinOf: m.vectorTwinOf || null,
    sources: m.sources,
  };
}
