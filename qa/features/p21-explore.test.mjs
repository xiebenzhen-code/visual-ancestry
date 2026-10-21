// p21-explore.test.mjs — Phase 2.1 的契约：连续探索、证据语义、补货保护、媒介一致
//
// 钉的是"不许越界"的那几条：
//   · 远端作品必须是可再次进入的作品节点（有内部 href、有原始来源）
//   · 没有 Vision 确认就不许出现"同风格已验证"这类说法
//   · 保留证据与变化两段缺一，就不能算风格延展
//   · 补货同一查询不重复抓、队列有上限、失败有原因
//   · 媒介筛选对本地与远端是同一套口径，黑白影像不得成为参考

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

const service = await imp("scripts/discovery/service.mjs");
const jobs = await imp("scripts/discovery/jobs.mjs");
const storeMod = await imp("scripts/discovery/store.mjs");
const media = await imp("src/services/explore/externalMedia.js");

console.log("=== 1. 远端作品是作品节点，不是外链 ===");
await check("远端作品有内部路由 href（#artwork/r.<hash>）", () => {
  const works = storeMod.readWorks().filter((w) => w.imageHash && w.storedImage);
  assert.ok(works.length > 0);
  const w = works[0];
  const found = service.workByHash(w.imageHash);
  assert.ok(found, "workByHash 应能取到作品");
  assert.equal(`#artwork/r.${w.imageHash}`, `#artwork/r.${found.work.imageHash}`);
});

await check("远端作品保留原始馆藏链接与来源字段", () => {
  const w = storeMod.readWorks().find((x) => x.sourceUrl);
  assert.ok(w, "至少有一条带 sourceUrl 的记录");
  assert.ok(/^https:\/\//.test(w.sourceUrl));
  assert.ok(w.provider);
});

await check("本地作品有预生成向量（请求期不需要跑 Python）", () => {
  const lv = service.localVectors();
  const ids = Object.keys(lv.vectors || {});
  assert.ok(ids.length >= 40, `只有 ${ids.length} 件有向量`);
  const v = lv.vectors[ids[0]];
  assert.equal(v.vector.length, 512);
  assert.ok(v.metrics && typeof v.metrics.aspect === "number", "向量条目应带像素特征");
});

await check("未预生成向量的作品返回 vector-pending，而不是同步现算", async () => {
  const r = await service.exploreFor({ artworkId: "__no_such_work__" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "vector-pending");
});

console.log("\n=== 2. 证据语义：不得宣称已验证同风格 ===");
await check("所有外部候选都带 level 与 claim，且 claim 不含「已验证」", async () => {
  const r = await service.exploreFor({ artworkId: "paris-rainy-day" });
  assert.ok(r.ok, r.error);
  const all = Object.values(r.branches).flat();
  assert.ok(all.length > 0, "应至少有一个候选");
  for (const c of all) {
    assert.ok(["style-candidate", "same-language", "changed-only"].includes(c.level), `未知 level ${c.level}`);
    assert.ok(!/已验证/.test(c.claim), `不许出现已验证：${c.claim}`);
    assert.ok(c.claim.length > 0);
  }
});

await check("风格延展必须同时有保留证据与变化证据", async () => {
  const r = await service.exploreFor({ artworkId: "paris-rainy-day" });
  for (const c of Object.values(r.branches).flat()) {
    if (c.level !== "style-candidate") continue;
    assert.ok((c.retained || []).length >= 3, `${c.title} 保留证据不足`);
    assert.ok((c.changed || []).length >= 1, `${c.title} 没有变化证据`);
  }
});

await check("只有向量近邻、像素不相似的候选不会升级为风格延展", async () => {
  // 构造一个"色温/饱和/对比/明度全不同"的候选，即使向量近邻很高也不能是 style-candidate
  const q = { warmth: "warm", meanSat: 0.45, contrast: 0.25, meanLum: 0.55, edgeDensity: 0.08, aspect: 1.3 };
  const c = { warmth: "cool", meanSat: 0.10, contrast: 0.05, meanLum: 0.18, edgeDensity: 0.30, aspect: 0.7 };
  const aff = service.visualAffinity(q, c);
  assert.ok(aff.score < service.THRESHOLD.retained, `不应达到阈值，实际 ${aff.score}`);
  assert.ok(aff.parts.length < service.THRESHOLD.minParts || !aff.parts.some((p) => /色温|饱和|明度/.test(p)));
});

await check("像素证据缺失时不给高分（不猜）", () => {
  const aff = service.visualAffinity({ warmth: "warm" }, null);
  assert.equal(aff.score, 0);
  assert.equal(aff.missing, "pixels");
});

console.log("\n=== 3. 按需补货：去重、上限、状态 ===");
await check("同一查询重复入队会被去重，不会重复抓取", () => {
  const q = `__test_dedupe_${Date.now()}`;
  const a = jobs.enqueue(q, { reason: "test" });
  const b = jobs.enqueue(q, { reason: "test" });
  assert.ok(a.job, "第一次应入队");
  assert.equal(b.deduped, true, "第二次应命中去重");
  assert.equal(a.job.id, b.job.id);
});

await check("作业状态可查询，且带队列深度", () => {
  const q = `__test_status_${Date.now()}`;
  const { job } = jobs.enqueue(q, { reason: "test" });
  const got = jobs.getJob(job.id);
  assert.ok(got, "应能查到作业");
  assert.ok(["queued", "running", "done", "failed"].includes(got.status));
  assert.equal(typeof got.queueDepth, "number");
});

await check("队列有上限，超限明确拒绝而不是无限排队", () => {
  let rejected = null;
  for (let i = 0; i < 20; i += 1) {
    const r = jobs.enqueue(`__test_fill_${i}_${Date.now()}`, { reason: "test" });
    if (r.reason === "queue-full") { rejected = r; break; }
  }
  assert.ok(rejected, "应触发 queue-full");
  assert.equal(rejected.job, null);
});

await check("补货查询词从画派+主体派生，不用作品 ID 写规则", () => {
  const q = service.harvestQueryFor({}, "雨天的巴黎街道", "city", ["impressionism"]);
  assert.equal(q, "impressionism city street");
  assert.ok(!/paris-rainy-day/.test(q));
});

console.log("\n=== 4. 媒介口径：本地与远端同一套 ===");
await check("绘画档只留 artwork", () => {
  assert.equal(media.matchesMedia({ imageKind: "artwork" }, "artwork"), true);
  assert.equal(media.matchesMedia({ imageKind: "photograph" }, "artwork"), false);
  assert.equal(media.matchesMedia({ imageKind: "anime-cover" }, "artwork"), false);
});

await check("黑白影像不得进入电影/动画档", () => {
  const mono = { imageKind: "tv-episode-still", metrics: { meanSat: 0.02 } };
  const color = { imageKind: "tv-episode-still", metrics: { meanSat: 0.31 } };
  assert.equal(media.matchesMedia(mono, "film"), false);
  assert.equal(media.matchesMedia(mono, "animation"), false);
  assert.equal(media.matchesMedia(color, "film"), true);
  assert.equal(media.matchesMedia(color, "animation"), true);
});

await check("跨媒介档排除绘画，但没有实测饱和度的条目不被误判为黑白", () => {
  assert.equal(media.matchesMedia({ imageKind: "artwork" }, "cross"), false);
  assert.equal(media.matchesMedia({ imageKind: "photograph" }, "cross"), true);
  assert.equal(media.matchesMedia({ imageKind: "photograph", metrics: {} }, "film"), false);
  assert.equal(media.isMonochromeItem({ imageKind: "photograph", metrics: {} }), false);
});

await check("筛选是同一份数据上的纯函数，切换不会改动候选本身", async () => {
  const r = await service.exploreFor({ artworkId: "paris-rainy-day" });
  const all = Object.values(r.branches).flat();
  const before = all.length;
  media.countVisible(all, "artwork");
  media.countVisible(all, "animation");
  media.countVisible(all, "all");
  const again = Object.values(r.branches).flat();
  assert.equal(again.length, before);
});

console.log("\n=== 5. 不许留第二套详情系统 ===");
await check("远端作品复用同一个路由前缀与同一个页面文件", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/pages/artwork.js"), "utf8");
  assert.ok(/REMOTE_PREFIX = "r\."/.test(src), "远端路由前缀应固定在 artwork 页内");
  const router = fs.readFileSync(path.join(ROOT, "src/app/router.js"), "utf8");
  assert.ok(router.includes('name === "artwork"'), "路由仍只有 artwork 一条");
  assert.ok(!fs.existsSync(path.join(ROOT, "src/pages/remoteArtwork.js")), "不得新建第二套详情页");
});

console.log(`\n=== Phase 2.1: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
