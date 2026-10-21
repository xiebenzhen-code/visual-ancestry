// discover.mjs — v0.3 自动图片发现 PoC（STEP 2）
//
// 只用公开不可付费接口：AIC / Met / Cleveland / Rijks / Openverse。
// 不调用 Vision，不抓整站，不做 HTML 解析。
//
// 产出 .rc1-audit/poc/discovery.json：
//   每个「关键词 × 来源」记录 HTTP 状态、返回条数、有图条数、耗时、失败原因
// 以及 .rc1-audit/poc/candidates.json（合并去重后的候选，供解码与 embedding 使用）

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const OUT = path.join(ROOT, ".rc1-audit/poc");
fs.mkdirSync(path.join(OUT, "thumbs"), { recursive: true });

const imp = (r) => import(pathToFileURL(path.join(ROOT, r)).href);
const { adapters } = await imp("src/services/artService.js");

const KEYWORDS = process.env.POC_KEYWORDS ? process.env.POC_KEYWORDS.split("|") : ["rainy city street", "mountain landscape", "decorative painting"];
const LIMIT = { aic: 50, met: 24, cleveland: 50, rijks: 40, openverse: 50 };

// 缓存：同一关键词 + 同一来源，24h 内不重复请求（STEP 4 复用）
const CACHE = path.join(OUT, "api-cache.json");
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
const now = Date.now();
const TTL = 24 * 3600 * 1000;

const keyOf = (src, q) => `${src}::${q.toLowerCase().trim()}`;

function imageKey(w) {
  // 去重键：同一张图可能被不同来源收录（Openverse 里就常有 AIC/Met 的图）
  const u = (w.image && (w.image.url || "")) || "";
  try {
    const url = new URL(u);
    return `${url.host}${url.pathname}`.toLowerCase();
  } catch {
    return `${w.source}:${w.sourceId}`;
  }
}

const results = [];
const merged = new Map(); // imageKey -> work（保留首个来源，记录 alsoFoundIn）
// 次级去重键：同一件作品在不同来源的图片 URL 不同（Openverse 走自己的缩略图代理），
// 只按 URL 去重会漏。这里用「标题+作者+年代」的规范化字符串做第二道闸。
const titleIndex = new Map();
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ").trim();
const workKey = (w) => [norm(w.title), norm(w.artist), norm(w.year)].join("|");

for (const q of KEYWORDS) {
  for (const adapter of adapters) {
    const k = keyOf(adapter.source, q);
    const hit = cache[k];
    const record = { keyword: q, source: adapter.source, sourceName: adapter.sourceName, limit: LIMIT[adapter.source] || 24 };
    // 只复用成功结果；上次失败的来源要重新试（失败不是可缓存的事实）
    if (hit && now - hit.at < TTL && hit.status === 200 && (hit.items || []).length >= 0) {
      Object.assign(record, { cached: true, status: hit.status, latencyMs: hit.latencyMs, returned: hit.items.length });
      record.items = hit.items;
    } else {
      const started = Date.now();
      try {
        const items = await adapter.search(q, { limit: record.limit });
        record.status = 200;
        record.latencyMs = Date.now() - started;
        record.returned = items.length;
        record.items = items;
        cache[k] = { at: now, status: 200, latencyMs: record.latencyMs, items };
      } catch (e) {
        record.status = Number((String(e.message).match(/\b(\d{3})\b/) || [])[1]) || 0;
        record.latencyMs = Date.now() - started;
        record.returned = 0;
        record.items = [];
        record.error = String(e.message).slice(0, 160);
        cache[k] = { at: now, status: record.status, latencyMs: record.latencyMs, items: [], error: record.error };
        if (/AbortError|timeout/i.test(record.error)) record.error = "timeout: " + record.error;
      }
    }

    // 有图 / 无图
    const withImage = (record.items || []).filter((w) => w && w.image && w.image.url);
    record.withImage = withImage.length;
    record.ratioKnown = withImage.filter((w) => w.image.ratio).length;

    for (const w of withImage) {
      const ik = imageKey(w);
      const wk = workKey(w);
      const byTitle = wk.replace(/\|/g, "") !== "" ? titleIndex.get(wk) : null;
      const prev = merged.get(ik) || byTitle;
      if (prev) {
        prev.alsoFoundIn = prev.alsoFoundIn || [];
        if (!prev.alsoFoundIn.includes(w.source)) prev.alsoFoundIn.push(w.source);
      } else {
        const rec = { ...w, dedupeKey: ik, foundBy: [q] };
        merged.set(ik, rec);
        if (wk.replace(/\|/g, "") !== "") titleIndex.set(wk, rec);
      }
    }
    results.push(record);
    const tag = record.cached ? "cache" : `HTTP ${record.status}`;
    console.log(`  ${q.padEnd(20)} ${adapter.source.padEnd(10)} ${tag.padEnd(10)} 返回 ${String(record.returned).padStart(2)} | 有图 ${String(record.withImage).padStart(2)} | ${record.latencyMs}ms${record.error ? " | " + record.error : ""}`);
  }
}

// 语料库累积：每次发现的新作品并进 corpus.json，旧的不丢。
// （实测教训：第一版直接覆盖 candidates.json，换关键词后发现记录被冲掉。）
const CORPUS = path.join(OUT, "corpus.json");
const corpus = fs.existsSync(CORPUS) ? JSON.parse(fs.readFileSync(CORPUS, "utf8")) : { at: null, items: [] };
const known = new Map(corpus.items.map((w) => [w.dedupeKey, w]));
let added = 0;
for (const w of merged.values()) {
  const prev = known.get(w.dedupeKey);
  if (prev) {
    for (const k of w.foundBy || []) if (!(prev.foundBy || []).includes(k)) (prev.foundBy = prev.foundBy || []).push(k);
  } else {
    known.set(w.dedupeKey, w);
    added += 1;
  }
}
const candidates = [...known.values()];
fs.writeFileSync(CORPUS, JSON.stringify({ at: new Date().toISOString(), total: candidates.length, items: candidates }, null, 2), "utf8");
fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1), "utf8");
fs.writeFileSync(path.join(OUT, "discovery.json"), JSON.stringify({ at: new Date().toISOString(), keywords: KEYWORDS, results: results.map(({ items, ...rest }) => rest) }, null, 2), "utf8");
fs.writeFileSync(path.join(OUT, "candidates.json"), JSON.stringify({ at: new Date().toISOString(), total: candidates.length, items: candidates }, null, 2), "utf8");

console.log(`\n  本轮新增 ${added} 件；语料库合计 ${candidates.length} 件`);
const bySource = candidates.reduce((a, w) => { a[w.source] = (a[w.source] || 0) + 1; return a; }, {});
console.log("  按来源:", JSON.stringify(bySource));
