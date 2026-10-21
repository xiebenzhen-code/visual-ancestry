// v03-explore.test.mjs — Phase 1：首页补位规则 + 四条探索分支 + 媒介筛选
//
// 钉的是产品承诺，不是观感：
//   1. 四条分支各自"保留什么/改变什么"明确，且每件结果都带证据与 Vision 状态
//   2. 结果可以是空的；空必须给理由，不能拿重复作品凑栏
//   3. 黑白电影永远不作为参考（任何媒介模式都不出现）
//   4. 动画没有素材时是空状态，不是空白
//   5. 探索分支不读 P4.15.4 的档位——档位不得变成门禁
//   6. 产品数据副本与实验产物一致（防止两处漂移）

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

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

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

const media = await imp("src/services/explore/media.js");
const branchesMod = await imp("src/services/explore/styleBranches.js");
const { artworks } = await imp("src/data/artworks.js");
const artService = await imp("src/services/artService.js");

const byId = (id) => artworks.find((a) => a.id === id);

console.log("=== 1. 四条分支的形状 ===");
const baseBranches = branchesMod.buildBranches(byId("american-gothic"));
await check("四条分支齐全且顺序固定", () => {
  assert.deepEqual(baseBranches.map((b) => b.id), ["subject", "scene", "composition", "local"]);
  for (const b of baseBranches) {
    assert.ok(b.label && b.changeDim && b.preserves, `${b.id} 缺少说明字段`);
  }
});

await check("每条结果都写明保留与改变，并带证据", () => {
  let n = 0;
  for (const b of baseBranches) {
    for (const r of b.results) {
      n += 1;
      assert.ok(r.preserves, `${r.id} 缺 preserves`);
      assert.ok(r.changes, `${r.id} 缺 changes`);
      assert.ok(Array.isArray(r.evidence) && r.evidence.length >= 1, `${r.id} 缺证据`);
      assert.equal(typeof r.visionVerified, "boolean");
    }
  }
  assert.ok(n > 0, "三条路径一件结果都没有，样本失去意义");
});

await check("空分支必须给理由", () => {
  const q = byId("guo-xi-early-spring");
  const empty = branchesMod.buildBranches(q, { media: "animation" });
  assert.ok(empty.every((b) => b.empty), "动画档应当全空");
  for (const b of empty) assert.ok(b.emptyReason && b.emptyReason.length > 6, `${b.id} 空得没有理由`);
});

await check("同一件作品在同一分支里不重复", () => {
  for (const q of ["american-gothic", "paris-rainy-day", "fan-kuan-travelers"]) {
    for (const b of branchesMod.buildBranches(byId(q))) {
      const ids = b.results.map((r) => r.id);
      assert.equal(new Set(ids).size, ids.length, `${q}/${b.id} 有重复`);
    }
  }
});

await check("同一件作品只出现在一条分支（不靠堆同一件作品凑四栏）", () => {
  for (const q of ["american-gothic", "paris-rainy-day", "fan-kuan-travelers", "guo-xi-early-spring"]) {
    const counts = new Map();
    for (const b of branchesMod.buildBranches(byId(q))) {
      for (const r of b.results) counts.set(r.id, (counts.get(r.id) || 0) + 1);
    }
    for (const [id, n] of counts) assert.equal(n, 1, `${q}: ${id} 出现在 ${n} 条分支`);
  }
});

await check("没有独立画像的候选不会被标成已验证", () => {
  const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/vision-profiles.js"), "utf8")
    .replace(/^\/\/[^\n]*\r?\n/, "").replace("export const VISION_PROFILES = ", "").replace(/;\s*$/, ""));
  for (const b of branchesMod.buildBranches(byId("fan-kuan-travelers"))) {
    for (const r of b.results) {
      assert.equal(r.visionVerified, Boolean(profiles.profiles[r.id]), `${r.id} 的验证状态与画像表不一致`);
    }
  }
});

console.log("\n=== 2. 媒介筛选 ===");
const pool = branchesMod.explorePool();
await check("池子里既有绘画也有电影剧照", () => {
  const kinds = new Set(pool.map((w) => media.kindOf(w)));
  assert.ok(kinds.has("artwork"), "没有绘画");
  assert.ok(kinds.has("film"), "没有电影剧照");
});

await check("黑白电影在任何模式下都不出现", () => {
  const mono = pool.filter((w) => media.kindOf(w) === "film" && media.isMonochrome(w));
  assert.ok(mono.length > 0, "样本里应当有黑白影片，否则这条约束没被验证");
  for (const mode of ["all", "artwork", "film", "animation", "cross"]) {
    const { items } = media.filterByMedia(pool, mode, "artwork");
    for (const w of items) {
      if (media.kindOf(w) === "film") assert.ok(!media.isMonochrome(w), `${mode} 里出现了黑白影片 ${w.id}`);
    }
  }
});

await check("彩色电影档只出非黑白影片", () => {
  const { items } = media.filterByMedia(pool, "film", "artwork");
  for (const w of items) assert.equal(media.kindOf(w), "film");
  assert.ok(items.every((w) => !media.isMonochrome(w)));
});

await check("动画档为空且有解释", () => {
  const { items, emptyReason } = media.filterByMedia(pool, "animation", "artwork");
  assert.equal(items.length, 0);
  assert.match(emptyReason, /动画/);
});

await check("跨媒介档只出与查询不同的媒介", () => {
  const { items } = media.filterByMedia(pool, "cross", "artwork");
  for (const w of items) assert.equal(media.kindOf(w), "film");
});

await check("黑白判定沿用 0.06 饱和度阈值", () => {
  assert.equal(media.MONOCHROME_SAT, 0.06);
  const monoStill = pool.find((w) => w.id === "film-city-lights");
  const colorStill = pool.find((w) => w.id === "film-toll-of-the-sea");
  assert.equal(media.isMonochrome(monoStill), true);
  assert.equal(media.isMonochrome(colorStill), false);
});

console.log("\n=== 3. 档位不得变成门禁 ===");
await check("分支模块不导入任何 P4.15 判定模块", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/services/explore/styleBranches.js"), "utf8");
  const imports = src.split("\n").filter((l) => /^\s*import /.test(l)).join("\n");
  assert.ok(!/relationTier|relation-audit|p415|vision-search/.test(imports), `分支模块引入了判定模块：\n${imports}`);
});

await check("把查询换成任意作品，分支都只依赖本地档案与像素", () => {
  const a = branchesMod.buildBranches(byId("american-gothic"));
  const b = branchesMod.buildBranches(byId("american-gothic"));
  assert.deepEqual(
    a.map((x) => x.results.map((r) => r.id)),
    b.map((x) => x.results.map((r) => r.id)),
    "同一输入两次生成结果不一致"
  );
});

console.log("\n=== 4. 首页远端准入 ===");
await check("缺图/缺比例/缺权利/缺馆方记录的条目被拒", () => {
  const base = { title: "x", artist: "y", key: "aic:1", image: { url: "u", ratio: 1.2 }, publicDomain: true, sourceUrl: "s" };
  assert.equal(artService.isFeedEligible(base), true);
  assert.equal(artService.isFeedEligible({ ...base, image: null }), false);
  assert.equal(artService.isFeedEligible({ ...base, image: { url: "u" } }), false);
  assert.equal(artService.isFeedEligible({ ...base, publicDomain: false, source: { rightsStatus: "" } }), false);
  assert.equal(artService.isFeedEligible({ ...base, sourceUrl: "", source: { rightsStatus: "CC0" } }), false);
});

await check("三维器物/工艺品的馆藏照不进首页", () => {
  const base = { title: "x", artist: "y", key: "aic:2", image: { url: "u", ratio: 1.2 }, publicDomain: true, sourceUrl: "s" };
  assert.equal(artService.isFeedEligible({ ...base, medium: "Oil on canvas" }), true);
  assert.equal(artService.isFeedEligible({ ...base, medium: "Glazed porcelain" }), false);
  assert.equal(artService.isFeedEligible({ ...base, medium: "Silver, gilt bronze" }), false);
  assert.equal(artService.isFeedEligible({ ...base, medium: "" }), true, "没有媒介字段时不应误杀");
});

await check("去重同时挡住 key 与「标题+作者」重复", () => {
  const a = { key: "aic:1", title: "Same", artist: "A" };
  const b = { key: "met:9", title: "same", artist: "a" };
  const c = { key: "met:10", title: "Other", artist: "A" };
  const out = artService.dedupeFeed([a, b, c]);
  assert.equal(out.length, 2, "同标题同作者没有被去重");
});

console.log("\n=== 5. 产品数据副本与实验产物一致 ===");
await check("visual-metrics 与 observables.json 同源同值", () => {
  const obs = JSON.parse(fs.readFileSync(path.join(ROOT, "experiment/p415/observables.json"), "utf8"));
  const src = fs.readFileSync(path.join(ROOT, "src/data/visual-metrics.js"), "utf8");
  const metrics = JSON.parse(src.replace(/^\/\/[^\n]*\r?\n/, "").replace("export const VISUAL_METRICS = ", "").replace(/;\s*$/, ""));
  for (const [id, e] of Object.entries(obs.entries)) {
    const got = metrics.entries[id];
    assert.ok(got, `${id} 在产品数据里缺失`);
    assert.equal(got.aspect, e.aspect, `${id} aspect 漂移`);
    assert.equal(got.meanSat, e.meanSat, `${id} meanSat 漂移`);
  }
});

await check("vision-profiles 只收 A 级独立画像且带 callId", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/data/vision-profiles.js"), "utf8");
  const doc = JSON.parse(src.replace(/^\/\/[^\n]*\r?\n/, "").replace("export const VISION_PROFILES = ", "").replace(/;\s*$/, ""));
  const ids = Object.keys(doc.profiles);
  assert.equal(ids.length, 4, `应为 4 件，实得 ${ids.length}`);
  for (const [id, p] of Object.entries(doc.profiles)) {
    assert.equal(p.tier, "A", `${id} 不是 A 级`);
    assert.ok(p.callId, `${id} 缺 callId`);
  }
});

console.log(`\n=== Phase 1 探索骨架: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
