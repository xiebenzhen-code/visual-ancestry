// service.mjs — 自动发现的服务端实现（HTTP 层只调这里）。
//
// 这一版的核心变化：外部作品不再只是"一张外部图片"，而是可再次进入详情页、
// 可继续作为探索起点的作品节点。而且分支语义改成"证据两段"：
//   保留的视觉语言（像素实测 + 向量近邻） × 发生的变化（主体/场景/构图）
// 两段缺一，就不给"风格延展"的说法——只如实标注缺的是哪一段。

import fs from "node:fs";
import path from "node:path";
import { readWorks, readIndex, stats } from "./store.mjs";
import { harvestQuery } from "./engine.mjs";
import { enqueue, getJob, jobStats, queryCache } from "./jobs.mjs";

const ROOT = process.cwd();
const LOCAL_VECTORS = path.join(ROOT, ".rc1-audit/discovery/local-vectors.json");

/* ---------------- 状态 ---------------- */

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
    jobs: jobStats(),
    queries: Object.keys(queryCache()).length,
    providers: {
      museums: "ready",
      openverse: "ready",
      commons: "ready",
      anilist: "ready",
      tmdb: process.env.TMDB_READ_ACCESS_TOKEN ? "ready" : "credential-required",
    },
  };
}

/* ---------------- 按查询补货（同步版本，仅供旧调用与 CLI 复用） ---------------- */

export async function ensureDiscovery(query, { limit = 24, providers = ["museums", "openverse", "commons"] } = {}) {
  const cache = queryCache()[query];
  if (cache && Date.now() - cache.at < 30 * 60 * 1000) return { ok: true, harvested: 0, cached: true, works: readWorks().length };
  const r = enqueue(query, { limit, providers, reason: "explicit" });
  return { ok: Boolean(r.job), queued: true, job: r.job, deduped: r.deduped };
}

/* ---------------- 索引与作品查找 ---------------- */

let cacheIndex = null;
let cacheAt = 0;
function indexDoc() {
  if (!cacheIndex || Date.now() - cacheAt > 15000) { cacheIndex = readIndex(); cacheAt = Date.now(); }
  return cacheIndex;
}

let cacheWorks = null;
let cacheWorksAt = 0;
function worksById() {
  if (!cacheWorks || Date.now() - cacheWorksAt > 15000) {
    cacheWorks = new Map(readWorks().map((w) => [w.id, w]));
    cacheWorksAt = Date.now();
  }
  return cacheWorks;
}

export function workByHash(hash) {
  const w = [...worksById().values()].find((x) => x.imageHash === hash);
  if (!w) return null;
  const entry = indexDoc().byHash?.[hash];
  return { work: w, metrics: entry?.metrics || null, vector: entry?.vector || null };
}

export function imageFile(hash) {
  const dir = path.join(ROOT, ".rc1-audit/discovery/images");
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((n) => n.startsWith(hash));
  return f ? path.join(dir, f) : null;
}

export function wallWorks(topic, limit = 8) {
  const works = readWorks().filter((w) => w.storedImage && w.imageHash);
  const q = String(topic || "").toLowerCase();
  const pool = q
    ? works.filter((w) => String(w.query || "").toLowerCase().includes(q) || String(w.title || "").toLowerCase().includes(q))
    : works;
  return pool.slice(0, limit).map(publicWork);
}

function publicWork(w) {
  return {
    id: w.id,
    href: `#artwork/r.${w.imageHash}`,
    provider: w.provider,
    providerId: w.providerId,
    title: String(w.title || "").replace(/\.(jpe?g|png|tiff?|webp|gif)$/i, ""),
    creator: w.creator,
    year: w.year,
    medium: w.medium,
    imageKind: w.imageKind,
    rights: w.rightsStatus || w.license,
    sourceUrl: w.sourceUrl,
    image: `/api/discovery/image/${encodeURIComponent(w.imageHash)}`,
    foundBy: w.query || null,
  };
}

/* ---------------- 本地作品向量（构建时预生成，请求只读缓存） ---------------- */

let cacheLocalVec = null;
let cacheLocalAt = 0;
export function localVectors() {
  if (!cacheLocalVec || Date.now() - cacheLocalAt > 30000) {
    try { cacheLocalVec = JSON.parse(fs.readFileSync(LOCAL_VECTORS, "utf8")); } catch { cacheLocalVec = { vectors: {} }; }
    cacheLocalAt = Date.now();
  }
  return cacheLocalVec;
}

/* ---------------- 证据：保留 vs 变化 ---------------- */

const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]; return s; };

/** 像素层面的"视觉语言相近"打分，0..1。权重写死在这里，别处不再复制一份。 */
export function visualAffinity(q, c) {
  if (!q || !c) return { score: 0, parts: [], missing: "pixels" };
  const parts = [];
  let score = 0;
  if (q.warmth && c.warmth && q.warmth === c.warmth) { score += 0.28; parts.push(`色温一致（${c.warmth}）`); }
  const dSat = Math.abs((q.meanSat ?? 0) - (c.meanSat ?? 0));
  const satPart = 0.22 * Math.max(0, 1 - dSat / 0.15);
  score += satPart;
  if (dSat <= 0.15) parts.push(`饱和度差 ${dSat.toFixed(3)}`);
  const dCon = Math.abs((q.contrast ?? 0) - (c.contrast ?? 0));
  score += 0.18 * Math.max(0, 1 - dCon / 0.18);
  if (dCon <= 0.18) parts.push(`对比度差 ${dCon.toFixed(3)}`);
  const dLum = Math.abs((q.meanLum ?? 0) - (c.meanLum ?? 0));
  score += 0.12 * Math.max(0, 1 - dLum / 0.22);
  if (dLum <= 0.22) parts.push(`平均明度差 ${dLum.toFixed(2)}`);
  const relEdge = Math.abs((q.edgeDensity ?? 0) - (c.edgeDensity ?? 0)) / Math.max(q.edgeDensity ?? 0.02, 0.02);
  score += 0.10 * Math.max(0, 1 - relEdge / 0.6);
  if (relEdge <= 0.6) parts.push(`边缘密度差 ${(relEdge * 100).toFixed(0)}%`);
  const dAspect = Math.abs(Math.log((q.aspect ?? 1) / (c.aspect ?? 1)));
  score += 0.10 * Math.max(0, 1 - dAspect / 0.5);
  return { score: Number(Math.min(1, score).toFixed(3)), parts, missing: null };
}

const ASPECT_BUCKET = (a) => (a > 1.15 ? "竖幅" : a < 0.85 ? "横幅" : "近方形");
const VER_ID = { "top-heavy": "重心偏上", "bottom-heavy": "重心偏下", even: "重心居中" };

let classifyMod = null;
async function classifiers() {
  if (!classifyMod) classifyMod = await import("../../src/services/explore/styleBranches.js");
  return classifyMod;
}

function compDiffs(qm, cm) {
  const diffs = [];
  if (!qm || !cm) return diffs;
  if (ASPECT_BUCKET(qm.aspect) !== ASPECT_BUCKET(cm.aspect)) diffs.push(`画幅 ${ASPECT_BUCKET(qm.aspect)} → ${ASPECT_BUCKET(cm.aspect)}`);
  const qv = qm.lumTop - qm.lumBottom;
  const cv = cm.lumTop - cm.lumBottom;
  const qBand = qv > 0.06 ? "top-heavy" : qv < -0.06 ? "bottom-heavy" : "even";
  const cBand = cv > 0.06 ? "top-heavy" : cv < -0.06 ? "bottom-heavy" : "even";
  if (qBand !== cBand) diffs.push(`明度${VER_ID[qBand]} → ${VER_ID[cBand]}`);
  if ((qm.asymmetry < 0.12) !== (cm.asymmetry < 0.12)) diffs.push(`对称性 ${qm.asymmetry < 0.12 ? "对称" : "不对称"} → ${cm.asymmetry < 0.12 ? "对称" : "不对称"}`);
  return diffs;
}

// 保留判据：分数够高、且至少 3 项像素证据通过、且必须有"色调类"证据（色温/饱和/明度之一）。
// 只用对比度与边缘密度就判"视觉语言相近"，会把深色器物也算进来——那是假关联。
export const THRESHOLD = { retained: 0.68, minParts: 3, thin: 8 };
const TONE_PARTS = /色温一致|饱和度差|平均明度差/;

/**
 * 核心：给定一个查询（本地作品 id 或远端作品 hash），返回分类后的候选。
 * 分类只决定"放在哪一栏"，证据文案明确写出缺哪一段。
 */
export async function exploreFor({ artworkId = null, hash = null, limit = 40 } = {}) {
  const { subjectClass, sceneClass } = await classifiers();
  const doc = indexDoc();
  let queryWork;
  let queryMetrics;
  let queryVector;

  if (hash) {
    const found = workByHash(hash);
    if (!found) return { ok: false, error: "work-not-found" };
    queryWork = publicWork(found.work);
    queryMetrics = found.metrics;
    queryVector = found.vector;
  } else if (artworkId) {
    const lv = localVectors().vectors?.[artworkId];
    if (!lv) return { ok: false, error: "vector-pending", artworkId };
    queryVector = lv.vector;
    queryMetrics = lv.metrics || null;
    queryWork = {
      id: artworkId, href: `#artwork/${artworkId}`, title: lv.title || artworkId, titleEn: lv.titleEn || "", kind: "artwork",
      traditions: lv.traditions || [], subject: lv.subject || "other", scene: lv.scene || "other",
    };
  } else {
    return { ok: false, error: "query-required" };
  }

  const qWork = { ...queryWork, metrics: queryMetrics };
  const qSubject = queryWork.subject && queryWork.subject !== "other" ? queryWork.subject : subjectClass(qWork);
  const qScene = queryWork.scene && queryWork.scene !== "other" ? queryWork.scene : sceneClass(qWork);
  const normTitle = (s) => String(s || "")
    .replace(/\.(jpe?g|png|tiff?|webp|gif)$/i, "")
    .toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ").trim();
  const qTitles = new Set([normTitle(queryWork.title), normTitle(queryWork.titleEn)].filter(Boolean));

  const scored = [];
  for (const w of worksById().values()) {
    if (hash && w.imageHash === hash) continue;
    if (!w.imageHash) continue;
    const entry = doc.byHash?.[w.imageHash];
    if (!entry?.vector) continue;
    const affinity = visualAffinity(queryMetrics, entry.metrics);
    // 同一件作品换了个来源再出现一次，不算"换主体"
    if (normTitle(w.title) && qTitles.has(normTitle(w.title))) continue;
    const cWork = { ...publicWork(w), metrics: entry.metrics };
    // 远端作品往往只有标题；标题分不出来时，用"它是被哪个关键词发现的"作弱证据
    let cSubject = subjectClass(cWork);
    let cScene = sceneClass(cWork);
    let kindHint = null;
    if ((cSubject === "other" || cScene === "other") && w.query) {
      const hintWork = { title: w.query, composition: "", lighting: "", color: "", spatialStructure: "", visualDNA: [] };
      if (cSubject === "other") { cSubject = subjectClass(hintWork); if (cSubject !== "other") kindHint = "来源关键词"; }
      if (cScene === "other") cScene = sceneClass(hintWork);
    }
    const diffs = compDiffs(queryMetrics, entry.metrics);
    scored.push({
      work: cWork,
      cos: Number(cos(queryVector, entry.vector).toFixed(4)),
      affinity,
      cSubject,
      cScene,
      compDiffs: diffs,
      subjectChanged: cSubject !== "other" && qSubject !== "other" && cSubject !== qSubject,
      sceneChanged: cScene !== "other" && qScene !== "other" && cScene !== qScene,
      kindHint,
    });
  }

  // 向量近邻先取候选池，再按证据分级。向量只是召回，不是风格证明。
  scored.sort((a, b) => b.cos - a.cos);
  const pool = scored.slice(0, Math.max(limit, 40));

  const retainedOf = (s) =>
    s.affinity.score >= THRESHOLD.retained &&
    s.affinity.parts.length >= THRESHOLD.minParts &&
    s.affinity.parts.some((p) => TONE_PARTS.test(p));
  const changedOf = (s) => s.subjectChanged || s.sceneChanged || s.compDiffs.length > 0;

  const verifyLevel = (s) => {
    if (retainedOf(s) && changedOf(s)) return "style-candidate";
    if (retainedOf(s)) return "same-language";
    if (changedOf(s)) return "changed-only";
    return "unrelated";
  };

  const buckets = { subject: [], scene: [], composition: [], local: [] };
  const counts = { styleCandidate: 0, sameLanguage: 0, changedOnly: 0, unrelated: 0 };
  const used = new Map();
  const LEVEL_RANK = { "style-candidate": 0, "same-language": 1, "changed-only": 2 };

  for (const s of pool) {
    const level = verifyLevel(s);
    counts[level === "style-candidate" ? "styleCandidate" : level === "same-language" ? "sameLanguage" : level === "changed-only" ? "changedOnly" : "unrelated"] += 1;
    if (level === "unrelated") continue;
    if (!retainedOf(s) && !s.compDiffs.length) continue;

    const evidence = [];
    if (s.affinity.parts.length) evidence.push({ kind: "像素实测", text: s.affinity.parts.join("；") });
    evidence.push({ kind: "向量近邻", text: `cos ${s.cos}（仅用于召回，不作为风格证据）` });
    if (s.kindHint) evidence.push({ kind: "来源关键词", text: `主体判断回退到发现时的检索词（${s.work.foundBy}），证据强度低于画面描述` });

    const changes = [];
    if (s.subjectChanged) changes.push(`主体 ${qSubject} → ${s.cSubject}`);
    if (s.sceneChanged) changes.push(`场景 ${qScene} → ${s.cScene}`);
    if (s.compDiffs.length) changes.push(...s.compDiffs);

    const card = {
      ...s.work,
      metrics: s.work.metrics || null,
      cos: s.cos,
      affinity: s.affinity.score,
      level,
      retained: s.affinity.parts,
      changed: changes,
      evidence,
      // 没有 Vision 确认，任何情况下都不写"已验证同风格"
      claim: level === "style-candidate" ? "待验证的风格延展" : level === "same-language" ? "同一视觉语言，主体未见变化" : "主体/场景已变，视觉语言证据不足",
    };

    const place = (key) => {
      if ((used.get(card.id) || 0) >= 1) return;
      if (buckets[key].length >= 3) return;
      used.set(card.id, (used.get(card.id) || 0) + 1);
      buckets[key].push(card);
    };
    if (s.subjectChanged && level !== "changed-only") place("subject");
    if (s.sceneChanged && level !== "changed-only") place("scene");
    if (s.compDiffs.length && level !== "changed-only") place("composition");
    if (retainedOf(s) && (s.subjectChanged || s.compDiffs.length)) place("local");
    // 证据不足的候选只在"这一栏否则为空"时补位，避免用弱证据占满结果
    if (level === "changed-only" && s.compDiffs.length && buckets.composition.length === 0) place("composition");
  }

  // 每栏按证据强度排序：待验证的风格延展 → 同一语言 → 证据不足；同档内按亲和度与近邻
  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) =>
      (LEVEL_RANK[a.level] ?? 3) - (LEVEL_RANK[b.level] ?? 3) || b.affinity - a.affinity || b.cos - a.cos);
  }

  const total = buckets.subject.length + buckets.scene.length + buckets.composition.length + buckets.local.length;
  const thin = total < THRESHOLD.thin;

  let job = null;
  if (thin) {
    const r = enqueue(
      harvestQueryFor(
        queryWork,
        hash ? queryWork.title : localVectors().vectors?.[artworkId]?.title,
        qSubject,
        hash ? null : localVectors().vectors?.[artworkId]?.traditions,
      ),
      { reason: "thin-candidates" },
    );
    job = r.job;
  }

  return {
    ok: true,
    query: { ...queryWork, subject: qSubject, scene: qScene, metrics: queryMetrics },
    branches: buckets,
    total,
    thin,
    job,
    counts,
    threshold: THRESHOLD,
    indexed: Object.keys(doc.byHash || {}).length,
  };
}

export { getJob };

/* 补货查询词：从"画派 + 主体"派生，不针对任何作品 ID 写规则。 */
const SUBJECT_SEARCH = { people: "portrait", city: "city street", landscape: "landscape", other: "art" };

export function harvestQueryFor(work, title, subject, traditions) {
  const trad = (traditions && traditions[0]) ? String(traditions[0]).replace(/-/g, " ") : "";
  const subj = SUBJECT_SEARCH[subject] || "art";
  // 远端作品没有画派字段：退回用它的标题做检索词，总比一个泛词 "art" 有用
  const parts = trad ? [trad, subj] : [String(title || "").slice(0, 48)];
  if (!parts.filter(Boolean).length && title) parts.push(String(title).slice(0, 40));
  return parts.join(" ").trim().slice(0, 60);
}
