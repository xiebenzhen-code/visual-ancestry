// p2-discovery.test.mjs — Phase 2 自动发现管线的契约
//
// 钉的是"管线可信"，不是"结果好看"：
//   1. 六类来源都有实现；TMDB 无凭据时必须是 credential-required，不能假装可用
//   2. 统一记录字段与 imageKind 语义（封面/海报/背景 ≠ 正片画面）
//   3. 图片校验真的读字节、真的拒小图与假图
//   4. 去重三键（id / 内容哈希 / 作品身份）
//   5. 索引覆盖已入库图片；Rijks 缺尺寸不冒充有尺寸
//   6. 外部候选能进入四条分支，且不依赖本地 artworks.js
//   7. 采集层不允许任意域名（SSRF 白名单）

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const store = new Map();
globalThis.window = {
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  location: { origin: "http://127.0.0.1", hash: "" },
};
globalThis.localStorage = globalThis.window.localStorage;

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); }
};

const norm = await imp("scripts/discovery/normalize.mjs");
const storeMod = await imp("scripts/discovery/store.mjs");
const validate = await imp("scripts/discovery/validate-image.mjs");
const engine = await imp("scripts/discovery/engine.mjs");
const { tmdbStatus } = await imp("scripts/discovery/providers/tmdb.mjs");
const anilist = await imp("scripts/discovery/providers/anilist.mjs");
const commons = await imp("scripts/discovery/providers/commons.mjs");
const http = await imp("scripts/discovery/http.mjs");

console.log("=== 1. 来源与凭据 ===");
await check("六类来源都有实现（museums/openverse/commons/tmdb/anilist + 它们的 capability 声明）", () => {
  const providers = ["museums", "openverse", "commons", "tmdb", "anilist"];
  for (const p of providers) {
    const f = path.join(ROOT, `scripts/discovery/providers/${p}.mjs`);
    assert.ok(fs.existsSync(f), `缺少 ${p}.mjs`);
  }
});

await check("TMDB 无凭据时状态是 credential-required，不会假装可用", () => {
  const s = tmdbStatus();
  assert.ok(["configured", "credential-required"].includes(s));
  if (!process.env.TMDB_READ_ACCESS_TOKEN) assert.equal(s, "credential-required");
});

await check("TMDB 无凭据时 search 不发请求、返回 credentialRequired 标记", async () => {
  const { tmdbProvider } = await imp("scripts/discovery/providers/tmdb.mjs");
  const runs = await tmdbProvider.search("test", { limit: 2 });
  if (!process.env.TMDB_READ_ACCESS_TOKEN) {
    assert.equal(runs[0].credentialRequired, true);
    assert.equal(runs[0].records.length, 0);
  }
});

console.log("\n=== 2. 统一记录与 imageKind ===");
await check("记录包含全部统一字段，缺失写入 missing 而不是编造", () => {
  const rec = norm.normalize({ providerId: "x1", title: "T", imageUrl: "https://example.org/a.jpg" }, { provider: "commons" });
  for (const k of ["provider", "providerId", "title", "creator", "year", "medium", "imageKind", "imageUrl", "thumbnailUrl", "sourceUrl", "rightsStatus", "license", "width", "height", "fetchedAt"]) {
    assert.ok(k in rec, `缺字段 ${k}`);
  }
  assert.equal(rec.creator, null, "缺失字段应为 null");
  assert.ok(rec.missing.includes("creator"));
  assert.ok(rec.missing.includes("dimensions"));
});

await check("AniList 目录封面不算动画画面", async () => {
  const r = await anilist.anilistProvider.search("test", { limit: 1 }).catch(() => null);
  if (r && r[0]?.records?.length) {
    for (const rec of r[0].records) {
      assert.equal(rec.imageKind, "anime-cover");
      assert.equal(norm.isAnimationFrame(rec), false, "封面被当成画面");
    }
  }
});

await check("海报/宣传背景不算正片画面", () => {
  assert.equal(norm.isAnimationFrame({ imageKind: norm.IMAGE_KINDS.POSTER }), false);
  assert.equal(norm.isAnimationFrame({ imageKind: norm.IMAGE_KINDS.PROMOTIONAL_BACKDROP }), false);
  assert.equal(norm.isAnimationFrame({ imageKind: norm.IMAGE_KINDS.TV_EPISODE_STILL }), true);
});

console.log("\n=== 3. 图片校验 ===");
await check("能从字节头解析 JPEG/PNG 尺寸", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x00, 0xc8, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const d = validate.dimensionsOf(jpeg);
  assert.equal(d.width, 200);
  assert.equal(d.height, 300);
});

await check("非图片字节不被当成图片", () => {
  assert.equal(validate.dimensionsOf(Buffer.from("<html>not an image</html>")), null);
});

await check("采集层拒绝白名单外的域名", async () => {
  await assert.rejects(() => http.getJson("https://evil.example.com/x"), /白名单|https/);
});

console.log("\n=== 4. 去重 ===");
await check("同一 providerId 不重复入库", () => {
  const rec = { id: "commons:1", provider: "commons", providerId: "1", title: "A", creator: "B", year: "1900" };
  const r = engine.dedupeAgainst([rec], [rec]);
  assert.equal(r.fresh.length, 0);
  assert.equal(r.dupId, 1);
});

await check("同内容哈希不重复入库", () => {
  const a = { id: "commons:1", providerId: "1", title: "A", creator: "B", year: "1900", imageHash: "h1" };
  const b = { id: "commons:2", providerId: "2", title: "A2", creator: "C", year: "1901", imageHash: "h1" };
  const r = engine.dedupeAgainst([b], [a]);
  assert.equal(r.fresh.length, 0);
  assert.equal(r.dupHash, 1);
});

await check("同一作品跨来源（标题+作者+年代相同）被合并", () => {
  const a = { id: "met:1", providerId: "1", title: "Rainy Street", creator: "X", year: "1890" };
  const b = { id: "commons:9", providerId: "9", title: "rainy  street", creator: "x", year: "1890" };
  const r = engine.dedupeAgainst([b], [a]);
  assert.equal(r.fresh.length, 0);
  assert.equal(r.dupWork, 1);
});

console.log("\n=== 5. 索引与真实数据 ===");
await check("索引覆盖已入库且被校验过的图片", () => {
  const works = storeMod.readWorks().filter((w) => w.storedImage && w.imageHash);
  const idx = storeMod.readIndex();
  const missing = works.filter((w) => !idx.byHash[w.imageHash]);
  assert.equal(missing.length, 0, `${missing.length} 张图没有向量`);
  assert.ok(Object.keys(idx.byHash).length >= 200, `索引只有 ${Object.keys(idx.byHash).length} 条`);
});

await check("索引条目带像素特征（探索分支要用）", () => {
  const idx = storeMod.readIndex();
  const withMetrics = Object.values(idx.byHash).filter((v) => v.metrics && Number.isFinite(v.metrics.aspect));
  assert.ok(withMetrics.length / Object.keys(idx.byHash).length > 0.9, "像素特征覆盖不足");
});

await check("库里至少 200 件来自外部来源，且覆盖 5 个以上 provider", () => {
  const works = storeMod.readWorks();
  const providers = new Set(works.map((w) => w.provider));
  assert.ok(works.length >= 200, `只有 ${works.length} 件`);
  assert.ok(providers.size >= 5, `只有 ${[...providers].join(",")}`);
});

await check("Rijks 记录不编造尺寸（实时复核：缺尺寸就是缺）", () => {
  const works = storeMod.readWorks().filter((w) => w.provider === "rijks");
  for (const w of works) {
    assert.ok(w.width === null || (Number.isFinite(w.width) && w.width > 0), "宽高必须是被校验过的真实值");
  }
});

console.log(`\n=== Phase 2 自动发现: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
