// discovery-service.mjs — 应用内部的自动发现入口（服务端）。
//
// 为什么放在服务端：TMDB Token 只能在服务端；浏览器直连还会撞 CORS，
// 也会把各馆的频率限制暴露到每个用户标签页。
//
// 对外只暴露三件事：
//   GET  /api/discovery/status          来源状态与库存
//   POST /api/discovery/harvest         按查询补货（有并发/额度上限，幂等）
//   POST /api/discovery/neighbors       给定本地作品 id，返回可参与探索的候选
//
// 关键行为：先查索引；不够才向外查询；查询失败只返回已有结果。

import fs from "node:fs";
import path from "node:path";
import { readWorks, readIndex, stats } from "./store.mjs";
import { harvestQuery } from "./engine.mjs";

const ROOT = process.cwd();

// 简单的进程内额度：同一查询 10 分钟内不重复抓，全局每分钟最多 2 次抓取。
const lastRun = new Map();
const RUN_TTL = 10 * 60 * 1000;
let tokens = 2;
let lastRefill = Date.now();

function takeToken() {
  const now = Date.now();
  if (now - lastRefill > 60 * 1000) { tokens = 2; lastRefill = now; }
  if (tokens <= 0) return false;
  tokens -= 1;
  return true;
}

export function discoveryStatus() {
  const s = stats();
  return {
    ok: true,
    works: s.works,
    byProvider: s.byProvider,
    indexed: s.indexed,
    model: s.model,
    images: s.images,
    bytesOnDisk: s.bytesOnDisk,
    providers: {
      museums: "ready",
      openverse: "ready",
      commons: "ready",
      anilist: "ready",
      tmdb: process.env.TMDB_READ_ACCESS_TOKEN ? "ready" : "credential-required",
    },
  };
}

/**
 * 按需补货：命中 10 分钟窗口直接返回上次结果。
 * @returns {{ok:boolean, harvested:number, reason?:string}}
 */
export async function ensureDiscovery(query, { limit = 24, providers = ["museums", "openverse", "commons"] } = {}) {
  const key = `${query}|${providers.join(",")}`;
  const prev = lastRun.get(key);
  if (prev && Date.now() - prev.at < RUN_TTL) return { ok: true, harvested: 0, cached: true, works: prev.works };
  if (!takeToken()) return { ok: false, harvested: 0, reason: "rate-limited" };
  try {
    const res = await harvestQuery(query, { limit, providers });
    lastRun.set(key, { at: Date.now(), works: res.added });
    return { ok: true, harvested: res.added, works: readWorks().length };
  } catch (e) {
    return { ok: false, harvested: 0, reason: String(e.message).slice(0, 120) };
  }
}

/* ---------------- 候选检索 ---------------- */

const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]; return s; };

let cacheIndex = null;
let cacheAt = 0;
function indexDoc() {
  if (!cacheIndex || Date.now() - cacheAt > 30000) { cacheIndex = readIndex(); cacheAt = Date.now(); }
  return cacheIndex;
}

/**
 * 给一件"查询作品"找外部候选。
 * @param {{vector:number[], metrics:object, excludeIds?:Set<string>, limit?:number}} q
 */
export function neighborsOf(q, { limit = 12, excludeIds = new Set() } = {}) {
  const doc = indexDoc();
  const works = readWorks();
  const byHash = new Map(Object.entries(doc.byHash || {}));
  const scored = [];
  for (const w of works) {
    if (!w.imageHash || excludeIds.has(w.id)) continue;
    const entry = byHash.get(w.imageHash);
    if (!entry?.vector) continue;
    scored.push({ work: w, cos: cos(q.vector, entry.vector), metrics: entry.metrics });
  }
  scored.sort((a, b) => b.cos - a.cos);
  return scored.slice(0, limit).map((s) => ({
    id: s.work.id,
    provider: s.work.provider,
    providerId: s.work.providerId,
    title: s.work.title,
    creator: s.work.creator,
    year: s.work.year,
    imageKind: s.work.imageKind,
    medium: s.work.medium,
    rights: s.work.rightsStatus || s.work.license,
    sourceUrl: s.work.sourceUrl,
    image: `/api/discovery/image/${encodeURIComponent(s.work.imageHash)}`,
    cos: Number(s.cos.toFixed(4)),
    metrics: s.metrics,
    foundBy: s.work.query || null,
  }));
}

/** 本地作品的向量：优先用已索引的，没有就现算（不落盘，避免污染索引）。 */
export async function vectorForImage(absPath) {
  const doc = indexDoc();
  const { execFileSync } = await import("node:child_process");
  const out = path.join(ROOT, ".rc1-audit/discovery/_query-vector.json");
  execFileSync("python", ["scripts/p414/embed.py", "--image", path.relative(ROOT, absPath), "--out", path.relative(ROOT, out)], { cwd: ROOT, stdio: "ignore" });
  const vec = Object.values(JSON.parse(fs.readFileSync(out, "utf8")).vectors || {})[0] || null;
  return { vector: vec, model: doc.model };
}

/* ---------------- 归类到四条探索分支 ---------------- */
// 复用前端的判别函数（subjectClass / sceneClass / compositionProfile / colorProfile），
// 保证"外部候选"和"本地候选"走同一套规则，不出现两套口径。
let classifyMod = null;
async function classifiers() {
  if (!classifyMod) classifyMod = await import("../../src/services/explore/styleBranches.js");
  return classifyMod;
}

const BUCKET_LABEL = { tall: "竖幅", wide: "横幅", square: "近方形" };

/**
 * @param {{work:object, metrics:object}} query 查询作品（本地档案项 + 其像素特征）
 * @param {Array} candidates neighborsOf 的结果
 */
export async function classifyCandidates(query, candidates) {
  const { subjectClass, sceneClass, compositionProfile, colorProfile } = await classifiers();
  const q = { ...query.work, metrics: query.metrics };
  const qSubject = subjectClass(q);
  const qScene = sceneClass(q);
  const qComp = compositionProfile(q);
  const qColor = colorProfile(q);

  const buckets = { subject: [], scene: [], composition: [], local: [] };
  for (const c of candidates) {
    const w = { ...c };
    const subj = subjectClass(w);
    const scene = sceneClass(w);
    const comp = compositionProfile(w);
    const color = colorProfile(w);

    if (subj !== "other" && subj !== qSubject) {
      buckets.subject.push({ ...c, branchReason: `主体：${qSubject} → ${subj}` });
    }
    if (scene !== "other" && scene !== qScene) {
      buckets.scene.push({ ...c, branchReason: `场景：${qScene} → ${scene}` });
    }
    if (comp && qComp && comp.bucket !== qComp.bucket) {
      buckets.composition.push({ ...c, branchReason: `画幅：${BUCKET_LABEL[qComp.bucket]} → ${BUCKET_LABEL[comp.bucket]}` });
    }
    if (color && qColor && color.warmth === qColor.warmth && Math.abs(color.sat - qColor.sat) <= 0.12) {
      buckets.local.push({ ...c, branchReason: `色彩：暖度 ${qColor.warmness || qColor.warmth} 一致，饱和度差 ${Math.abs(color.sat - qColor.sat).toFixed(2)}` });
    }
  }
  // 每个分支最多 3 条，且一件作品最多出现在两条分支里
  const used = new Map();
  const out = {};
  for (const [k, arr] of Object.entries(buckets)) {
    out[k] = arr
      .filter((c) => (used.get(c.id) || 0) < 2)
      .slice(0, 3)
      .map((c) => { used.set(c.id, (used.get(c.id) || 0) + 1); return c; });
  }
  return { buckets: out, queryProfile: { subject: qSubject, scene: qScene, comp: qComp, color: qColor } };
}

/** 首页用：从已入库的作品里按主题挑几张可展示的（不发起外部请求）。 */
export function wallWorks(topic, limit = 8) {
  const works = readWorks().filter((w) => w.storedImage && w.imageHash);
  const q = String(topic || "").toLowerCase();
  const pool = q
    ? works.filter((w) => String(w.query || "").toLowerCase().includes(q) || String(w.title || "").toLowerCase().includes(q))
    : works;
  return pool.slice(0, limit).map((w) => ({
    id: w.id,
    provider: w.provider,
    title: w.title,
    creator: w.creator,
    year: w.year,
    imageKind: w.imageKind,
    rights: w.rightsStatus || w.license,
    sourceUrl: w.sourceUrl,
    image: `/api/discovery/image/${encodeURIComponent(w.imageHash)}`,
  }));
}

export function imageFile(hash) {
  const dir = path.join(ROOT, ".rc1-audit/discovery/images");
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((n) => n.startsWith(hash));
  return f ? path.join(dir, f) : null;
}
