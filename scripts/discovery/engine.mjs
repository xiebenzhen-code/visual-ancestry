// engine.mjs — 一次「按查询补货」的完整流程（CLI 与服务器共用同一份实现）。
//
// providers → 统一记录 → 图片校验 → 去重 → 落库。
// 与 CLI 的差异只有一处：不打印，返回结构化结果。

import path from "node:path";
import { mapLimit, LIMITS } from "./http.mjs";
import { validateImage } from "./validate-image.mjs";
import { isPublishable } from "./normalize.mjs";
import { readWorks, appendWorks, appendRun, saveImage } from "./store.mjs";
import fs from "node:fs";
import { dimensionsOf } from "./validate-image.mjs";
import { museumsProvider } from "./providers/museums.mjs";
import { commonsCinemaProvider } from "./providers/commonsCinema.mjs";
import { blenderRecords } from "./providers/blenderFrames.mjs";
import { openverseProvider } from "./providers/openverse.mjs";
import { commonsProvider } from "./providers/commons.mjs";
import { tmdbProvider } from "./providers/tmdb.mjs";
import { anilistProvider } from "./providers/anilist.mjs";

const PROVIDERS = {
  "commons-cinema": commonsCinemaProvider,
  blender: { id: "blender", label: "Blender Open Movies", capabilities: ["film-still", "animation-frame"], credentialRequired: false, search: async () => [{ provider: "blender", status: 200, returned: 0, records: [], latencyMs: 0 }] },
  museums: museumsProvider,
  openverse: openverseProvider,
  commons: commonsProvider,
  tmdb: tmdbProvider,
  anilist: anilistProvider,
};

const normTitle = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ").trim();
const workKey = (r) => [normTitle(r.title), normTitle(r.creator), normTitle(r.year)].join("|");

export function dedupeAgainst(records, existing) {
  const byId = new Map(existing.map((w) => [w.id, w]));
  const byHash = new Map(existing.filter((w) => w.imageHash).map((w) => [w.imageHash, w]));
  const byWork = new Map(existing.map((w) => [workKey(w), w]));
  const fresh = [];
  const seenId = new Set();
  let dupId = 0, dupHash = 0, dupWork = 0;
  for (const rec of records) {
    const wk = workKey(rec);
    if (byId.has(rec.id)) { dupId += 1; continue; }
    if (rec.imageHash && byHash.has(rec.imageHash)) { dupHash += 1; continue; }
    if (wk.replace(/\|/g, "") && (byWork.has(wk) || seenId.has(wk))) { dupWork += 1; continue; }
    byId.set(rec.id, rec);
    if (rec.imageHash) byHash.set(rec.imageHash, rec);
    if (wk.replace(/\|/g, "")) { byWork.set(wk, rec); seenId.add(wk); }
    fresh.push(rec);
  }
  return { fresh, dupId, dupHash, dupWork };
}

/** 本地文件（ffmpeg 抽帧）直接入库：读字节 → 真解码尺寸 → 落盘 → 记哈希。 */
function ingestLocal(records) {
  const good = [];
  for (const rec of records) {
    try {
      const abs = path.resolve(process.cwd(), rec.localFile);
      const bytes = fs.readFileSync(abs);
      const dims = dimensionsOf(bytes);
      if (!dims || Math.min(dims.width, dims.height) < 200) continue;
      const ct = /\.png$/i.test(abs) ? "image/png" : "image/jpeg";
      const stored = saveImage(bytes, ct);
      good.push({ ...rec, imageHash: stored.hash, storedImage: stored.rel, width: dims.width, height: dims.height, validatedAt: new Date().toISOString() });
    } catch { /* 单帧失败不影响其它帧 */ }
  }
  return good;
}

/**
 * cinema：Commons 分类画面 + Blender 开放影片抽帧，一次跑完。
 * 两类分开统计，不用一类凑另一类。
 */
export async function harvestCinema({ commonsLimit = 40, categories = [], force = false, skipCommons = false, skipBlender = false } = {}) {
  const dbg = (...a) => { if (process.env.DISCOVERY_DEBUG === "1") console.error("  [cinema]", ...a, `${Date.now() % 100000}ms`); };
  dbg("start", { commonsLimit, skipCommons, skipBlender });
  const existing = readWorks();
  const knownIds = new Set(existing.map((w) => w.id));
  const stats = { commons: null, blender: null, added: 0 };

  // 1) Commons 分类
  let commonsRecords = [];
  const filmCats = categories.filter((c) => /film screenshots|film frames|film stills/i.test(c) && !/animat/i.test(c));
  const animCats = categories.filter((c) => /animat/i.test(c));
  for (const [cats, hint] of (skipCommons ? [] : [[filmCats, null], [animCats, "animation"]])) {
    if (!cats.length) continue;
    dbg("commons 请求", cats);
    const runs = await commonsCinemaProvider.search("", { limit: commonsLimit, categories: cats, kindHint: hint });
    dbg("commons 返回", runs[0].returned, "条");
    const run = runs[0];
    stats.commons = {
      status: run.status,
      returned: run.returned,
      skipped: run.skipped,
      errors: run.errors,
      latencyMs: run.latencyMs,
    };
    commonsRecords.push(...run.records);
  }
  const commonsFresh = commonsRecords.filter((r) => !knownIds.has(r.id));
  dbg("待校验图片", commonsFresh.length);
  const validated = await mapLimit(commonsFresh, LIMITS.concurrency, async (rec) => {
    const v = await validateImage(rec.thumbnailUrl || rec.imageUrl);
    if (!v.ok) return null;
    const stored = saveImage(v.bytes, v.contentType);
    return { ...rec, imageHash: stored.hash, storedImage: stored.rel, width: v.width, height: v.height, validatedAt: new Date().toISOString() };
  });
  const commonsGood = validated.filter(Boolean);
  dbg("校验通过", commonsGood.length);

  // 2) Blender 抽帧（离线）
  const blenderRecs = skipBlender ? [] : await blenderRecords({ force });
  const blenderFresh = blenderRecs.filter((r) => !knownIds.has(r.id));
  const blenderGood = ingestLocal(blenderFresh);
  stats.blender = { extracted: blenderRecs.length, ingested: blenderGood.length };

  const all = [...commonsGood, ...blenderGood];
  const { fresh, dupId, dupHash, dupWork } = dedupeAgainst(all, existing);
  appendWorks(fresh);
  appendRun({
    at: new Date().toISOString(), mode: "cinema",
    totals: { commonsValidated: commonsGood.length, blenderIngested: blenderGood.length, fresh: fresh.length, dupId, dupHash, dupWork },
    sources: [stats.commons, stats.blender],
  });
  stats.added = fresh.length;
  stats.fresh = fresh.length;
  return stats;
}

/**
 * @returns {Promise<{added:number, runs:object[], totals:object}>}
 */
export async function harvestQuery(query, { limit = 24, providers = ["museums", "openverse", "commons"] } = {}) {
  const selected = providers.map((p) => PROVIDERS[p]).filter(Boolean);
  const allRuns = [];
  const all = [];
  for (const provider of selected) {
    try {
      const runs = await provider.search(query, { limit });
      for (const run of runs) {
        allRuns.push({ provider: run.provider, status: run.status, returned: run.returned, latencyMs: run.latencyMs, error: run.error || null });
        all.push(...(run.records || []));
      }
    } catch (e) {
      allRuns.push({ provider: provider.id, status: 0, returned: 0, latencyMs: 0, error: String(e.message).slice(0, 140) });
    }
  }

  const candidate = all.filter(isPublishable);
  // 先按 providerId 预过滤：已入库的记录不必再下载图片（重复运行的核心节省）
  const known = new Set(readWorks().map((w) => w.id));
  const toFetch = candidate.filter((r) => !known.has(r.id));
  const skippedKnown = candidate.length - toFetch.length;
  const validated = await mapLimit(toFetch, LIMITS.concurrency, async (rec) => {
    const v = await validateImage(rec.thumbnailUrl || rec.imageUrl);
    if (!v.ok) return null;
    const stored = saveImage(v.bytes, v.contentType);
    return { ...rec, imageHash: stored.hash, storedImage: stored.rel, width: v.width, height: v.height, validatedAt: new Date().toISOString() };
  });
  const good = validated.filter(Boolean);
  const existing = readWorks();
  const { fresh, dupId, dupHash, dupWork } = dedupeAgainst(good, existing);
  appendWorks(fresh);
  appendRun({
    at: new Date().toISOString(), mode: "harvest", query,
    totals: { raw: all.length, publishable: candidate.length, validated: good.length, fresh: fresh.length, dupId, dupHash, dupWork },
    sources: allRuns,
  });
  return { added: fresh.length, skippedKnown, runs: allRuns, totals: { raw: all.length, validated: good.length, fresh: fresh.length, dupId, dupHash, dupWork } };
}

export { PROVIDERS };
