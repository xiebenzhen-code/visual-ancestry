// artService.js — single entry point for all artwork data. Pages must never
// touch museum APIs or adapters directly; everything flows through here.
//
// Responsibilities:
//   - local curated catalog (featured works with full analysis)
//   - remote museum works via adapters (AIC / Met / Cleveland / Rijks)
//   - cross-source search: local first, remote merged, deduped by key
//   - feed cursor for infinite scroll (local batches, then remote browse)
//   - localStorage cache for remote search results (24h TTL)
//   - similarity neighborhood for the detail page

import { artworks } from "../data/artworks.js";
import { filterArtworks } from "../utils/search.js";
import { normalizeArtwork } from "./normalizeArtwork.js";
import { aicAdapter } from "./adapters/aicAdapter.js";
import { metAdapter } from "./adapters/metAdapter.js";
import { clevelandAdapter } from "./adapters/clevelandAdapter.js";
import { rijksAdapter } from "./adapters/rijksAdapter.js";

export const adapters = [aicAdapter, metAdapter, clevelandAdapter, rijksAdapter];

const CACHE_KEY = "va-remote-cache-v1";
const CACHE_TTL = 24 * 60 * 60 * 1000;

// Session pool of remote works, keyed by `source:sourceId`.
const remotePool = new Map();

// Broad browse queries for the remote tail of the infinite feed.
const BROWSE_QUERIES = [
  "portrait", "landscape", "still life", "japan", "china", "flowers",
  "seascape", "interior", "night", "street", "cat", "horse",
  // Phase 1：首页要凑到「远端约 2/3」，原有 12 条查询在过滤后供给不足，
  // 补 4 条平面绘画相关检索词（不改排序，只扩供给）。
  "oil painting", "watercolor", "drawing", "cityscape",
];

function loadCache() {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveCache(cache) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // storage unavailable — cache is best-effort
  }
}

function rememberRemote(works) {
  for (const work of works) remotePool.set(work.key, work);
}

// Museum APIs can hang; every adapter call gets a hard timeout so the UI can
// always report "remote unavailable" instead of spinning forever.
const REMOTE_TIMEOUT = 20000;
function withTimeout(promise, ms = REMOTE_TIMEOUT) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

export function getCachedRemote(query) {
  const cache = loadCache();
  const entry = cache[query];
  if (entry && Date.now() - entry.ts < CACHE_TTL) {
    rememberRemote(entry.works);
    return entry.works;
  }
  return null;
}

function storeCachedRemote(query, works) {
  if (!works.length) return;
  const cache = loadCache();
  cache[query] = { ts: Date.now(), works };
  // keep the cache small
  const keys = Object.keys(cache);
  if (keys.length > 40) {
    const oldest = keys.sort((a, b) => cache[a].ts - cache[b].ts).slice(0, keys.length - 40);
    for (const k of oldest) delete cache[k];
  }
  saveCache(cache);
}

// ---------- local catalog ----------

export function getLocalWorks() {
  return artworks;
}

export function findLocalById(id) {
  return artworks.find((a) => a.id === id) || null;
}

export function findByKey(key) {
  return remotePool.get(key) || artworks.find((a) => a.key === key) || null;
}

export function allKnownWorks() {
  return [...artworks, ...remotePool.values()];
}

// ---------- search ----------

export function searchLocal(query) {
  if (!query || !query.trim()) return [];
  return filterArtworks(artworks, { query });
}

// Status-aware variant: the channel outcome travels with the results instead of
// living in a module-level flag. The flag is process-wide, so two overlapping
// searches overwrite each other's state and the UI can be told "a channel is
// down" because of somebody else's query. Callers that render per-source
// conclusions use this one; searchRemote() stays as the array-shaped wrapper.
export async function searchRemoteWithStatus(query, { limit = 24 } = {}) {
  const cached = getCachedRemote(query);
  if (cached) {
    // An entry only exists when every enabled channel answered, so a cache hit
    // means "complete" — clear the flag instead of inheriting an old failure.
    remoteUnavailable = false;
    return { works: cached.slice(0, limit), failed: [], complete: true, cached: true };
  }

  remoteUnavailable = false;
  const enabled = adapters.filter((a) => a.enabled);
  const per = Math.max(1, Math.ceil(limit / (enabled.length || 1)));

  // Channels run concurrently. Sequential calls made one hanging museum add its
  // full timeout to the wait of every search (measured: one hung channel turned a
  // search into 22.8s of dead time). Each channel keeps its own hard timeout, and
  // Promise.allSettled preserves adapter order so the merge stays deterministic.
  const settled = await Promise.allSettled(
    enabled.map((adapter) => withTimeout(adapter.search(query, { limit: per })))
  );

  const out = [];
  const seen = new Set();
  const failed = [];
  settled.forEach((result, index) => {
    const adapter = enabled[index];
    if (result.status !== "fulfilled") {
      failed.push(adapter.source);
      remoteUnavailable = true;
      console.warn(`[artService] ${adapter.source} search failed:`, result.reason?.message ?? result.reason);
      return;
    }
    for (const raw of result.value || []) {
      if (!raw) continue;
      const work = normalizeArtwork({ ...raw, analysisLevel: 0 });
      if (seen.has(work.key)) continue;
      seen.add(work.key);
      remotePool.set(work.key, work);
      out.push(work);
    }
  });

  // Partial results must not be cached as if they were the full four-channel
  // answer: a later cache hit would serve them for 24h with no failure notice.
  if (failed.length === 0) storeCachedRemote(query, out);
  return {
    works: out.slice(0, limit),
    failed,
    // `complete` is what callers render: true only when every enabled channel
    // answered (or the cache hit was written under that condition).
    complete: failed.length === 0,
    cached: false,
  };
}

// Array-shaped wrapper kept for every existing caller (home feed, search layer,
// mixed feed, the Agent Skill). Behaviour is identical to before this refactor.
export async function searchRemote(query, { limit = 24 } = {}) {
  const { works } = await searchRemoteWithStatus(query, { limit });
  return works;
}

// true when the last museum call failed/timed out (UI shows the failure
// message instead of pretending "no results").
let remoteUnavailable = false;
export function wasRemoteUnavailable() {
  return remoteUnavailable;
}

// local-first merged search (used by the search page)
export async function searchAll(query, { limit = 60 } = {}) {
  const local = searchLocal(query);
  const remote = await searchRemote(query, { limit: limit - local.length });
  const seen = new Set(local.map((w) => w.key));
  const merged = [...local, ...remote.filter((w) => !seen.has(w.key))];
  return merged.slice(0, limit);
}

// ---------- feed (infinite scroll) ----------

// Works shown in the visual feed NEVER include rights-analysis-only entries
// (no "版权保护期内·仅分析" placeholders occupying the canvas).
export function feedVisibleWorks() {
  return artworks.filter((a) => !a.imageUnavailable);
}

export function getLocalFeed({ cursor = 0, batch = 24, filter = null } = {}) {
  let list = feedVisibleWorks();
  if (filter && filter.category && filter.term) {
    list = list.filter((a) => {
      if (filter.category === "tradition") return (a.traditions || []).includes(filter.term);
      if (filter.category === "emotion") return (a.emotion || []).includes(filter.term);
      if (filter.category === "atmosphere") return (a.atmosphere || []).includes(filter.term);
      return true;
    });
  }
  const slice = list.slice(cursor, cursor + batch);
  return {
    items: slice,
    nextCursor: cursor + slice.length,
    ended: cursor + slice.length >= list.length,
  };
}

// Mixed endless feed: curated chunk <-> remote discovery chunk, interleaved,
// so the homepage never reads as "a wall of the same 51 works".
export function createMixedFeedState() {
  return {
    localBatch: 12,
    remoteBatch: 9,
    localCursor: 0,
    localEnded: false,
    remote: createRemoteFeedState(),
    phase: "local",
  };
}

export async function getMixedFeed(state) {
  const items = [];
  if (state.phase === "local") {
    const local = getLocalFeed({ cursor: state.localCursor, batch: state.localBatch });
    items.push(...local.items);
    state.localCursor = local.nextCursor;
    if (local.ended) state.localEnded = true;
    state.phase = state.localEnded ? "remote" : "remote"; // always alternate after this chunk
    if (!state.localEnded) {
      // interleave: give the next chunk to remote discovery, then come back
      state.phase = "remote";
    }
    return items;
  }
  // remote phase
  state.phase = "local";
  const remote = await getRemoteFeed(state.remote, { batch: state.remoteBatch });
  items.push(...remote);
  return items;
}

// ---- 首页远端准入与去重（Phase 1）----
// 只做两件事，不改任何既有函数的行为：
//   1) 准入：能展示的真实图片 + 比例已知 + 有权利状态（或公有领域）+ 有馆方记录链接。
//      缺一项就不进首页——首页是用户看到的第一批图，不能用"可能没问题"的条目。
//   2) 去重：按 key 与「标题+作者」双键，挡住不同馆藏编号的同一件作品。
// 三维器物/工艺品的馆藏照不适合当"画面参考"：构图与光线的可借鉴性低，
// 而且会让首页看起来像博物馆藏品目录。用排除法而不是白名单——
// 四馆的媒介词表差异很大，白名单会把绘画误杀。
const NON_PICTORIAL = /ceramic|porcelain|silver|glass|furniture|bronze|vessel|jade|enamel|metalwork|textile|costume|jewelry|armor|sculpture|relief/i;

export function isFeedEligible(work) {
  if (!work || !work.image || !work.image.url || !work.image.ratio) return false;
  const rights = work.source && work.source.rightsStatus ? String(work.source.rightsStatus) : "";
  const hasRights = Boolean(work.publicDomain) || rights.trim().length > 0;
  const hasRecord = Boolean(work.sourceUrl || (work.source && work.source.url));
  if (!hasRights || !hasRecord) return false;
  const medium = typeof work.medium === "string" ? work.medium : "";
  if (medium && NON_PICTORIAL.test(medium)) return false;
  return true;
}

export function dedupeFeed(works, seenKeys = new Set()) {
  const keys = new Set(seenKeys);
  const titles = new Set();
  const out = [];
  for (const w of works) {
    if (!w) continue;
    if (w.key && keys.has(w.key)) continue;
    const t = `${String(w.title || "").toLowerCase().trim()}|${String(w.artist || "").toLowerCase().trim()}`;
    if (titles.has(t)) continue;
    if (w.key) keys.add(w.key);
    titles.add(t);
    out.push(w);
  }
  return out;
}

// Remote browse state machine for the feed's tail.
export function createRemoteFeedState() {
  return { queryIndex: 0, offset: 0, perQuery: 12 };
}

export async function getRemoteFeed(state, { batch = 24 } = {}) {
  const items = [];
  while (items.length < batch && state.queryIndex < BROWSE_QUERIES.length) {
    const query = BROWSE_QUERIES[state.queryIndex];
    let works = getCachedRemote(query);
    if (!works) {
      try {
        works = await searchRemote(query, { limit: state.perQuery });
      } catch {
        works = [];
      }
    }
    const chunk = works.slice(state.offset, state.offset + (batch - items.length));
    items.push(...chunk);
    state.offset += chunk.length;
    if (state.offset >= works.length) {
      state.queryIndex += 1;
      state.offset = 0;
    }
    if (!chunk.length) state.queryIndex += 1; // avoid infinite loop on empty source
  }
  rememberRemote(items);
  return items;
}

// ---------- similarity (detail page) ----------

export function getSimilar(artwork, { limit = 6 } = {}) {
  const pool = allKnownWorks().filter((w) => w.key !== artwork.key);
  const scored = pool
    .map((w) => {
      let score = 0;
      if (artwork.artist && w.artist && artwork.artist === w.artist) score += 5;
      for (const t of artwork.traditions || []) if ((w.traditions || []).includes(t)) score += 2;
      for (const e of artwork.emotion || []) if ((w.emotion || []).includes(e)) score += 1.5;
      for (const at of artwork.atmosphere || []) if ((w.atmosphere || []).includes(at)) score += 1.5;
      return { w, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.w);
  return scored;
}
