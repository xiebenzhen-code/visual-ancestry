// p414-d.test.mjs — P4.14-D 实验检索层的最小回归
//
// 测的是可被推翻的契约：
//   1. 图库只收有真实图片与向量的条目，黑白影片一个都不许在
//   2. 同一查询重复结果稳定；不同查询不得返回同一份榜单
//   3. 媒介筛选：动画当前没有数据就必须是 0 条，且不报错
//   4. 结构特征只用真实数据；拿不到的维度必须列为 unavailable，不得补零
//   5. 结构比较：缺失维度不参与，不得当成 0 分
//   6. 组合检索：结构只在可比维度够多时才参与
//   7. 海报不能当参考画面

import assert from "node:assert/strict";
import path from "node:path";
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

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name} — ${String(e.message).slice(0, 240)}`); }
}

const vs = await imp("src/services/features/visualSearch.js");
const sf = await imp("src/services/features/structureFeatures.js");
const emb = JSON.parse((await import("node:fs")).readFileSync("src/data/visual-embeddings.json", "utf8"));

// ============================================================ 图库
console.log("\n=== 1. 图库构成 ===");

check("图库有条目，且每个都有向量", () => {
  const lib = vs.library();
  assert.ok(lib.length >= 40, `只有 ${lib.length} 条`);
  for (const e of lib) assert.ok(Array.isArray(e.vector) && e.vector.length === 512, `${e.id} 向量不对`);
});

check("黑白影片不在图库内", () => {
  const ids = vs.library().map((e) => e.id);
  for (const banned of ["film-the-general", "film-city-lights", "film-ten-commandments"]) {
    assert.ok(!ids.includes(banned), `${banned} 混进图库了`);
  }
});

check("彩色影片在库内且标为 film", () => {
  const toll = vs.library().find((e) => e.id === "film-toll-of-the-sea");
  assert.ok(toll, "彩色片缺失");
  assert.equal(toll.kind, "film");
});

check("向量维度与元信息一致", () => {
  assert.equal(vs.LIBRARY_META.dim, 512);
  assert.equal(vs.LIBRARY_META.fit, "pad", "取景方式必须是 pad —— crop 会让竖幅画被切边");
  assert.match(vs.LIBRARY_META.license, /MIT/);
});

// ============================================================ 检索稳定性
console.log("\n=== 2. 检索稳定性与区分度 ===");

const AG = emb.vectors["american-gothic"];
const STARRY = emb.vectors["starry"];

check("同一查询重复结果一致", () => {
  const a = vs.searchByEmbedding(AG, { excludeId: "american-gothic", limit: 5 }).results.map((r) => r.id);
  const b = vs.searchByEmbedding(AG, { excludeId: "american-gothic", limit: 5 }).results.map((r) => r.id);
  assert.deepEqual(a, b);
});

check("不同查询不得返回同一份榜单", () => {
  const a = vs.searchByEmbedding(AG, { excludeId: "american-gothic", limit: 5 }).results.map((r) => r.id);
  const b = vs.searchByEmbedding(STARRY, { excludeId: "starry", limit: 5 }).results.map((r) => r.id);
  assert.notDeepEqual(a, b, "两张完全不同的画给出同一榜单，说明查询没生效");
});

check("排除自身生效", () => {
  const r = vs.searchByEmbedding(AG, { excludeId: "american-gothic", limit: 10 }).results.map((x) => x.id);
  assert.ok(!r.includes("american-gothic"));
});

check("余弦相似度落在 [-1,1] 且降序", () => {
  const res = vs.searchByEmbedding(AG, { excludeId: "american-gothic", limit: 10 }).results;
  let prev = Infinity;
  for (const r of res) {
    assert.ok(r.similarity <= 1.0001 && r.similarity >= -1.0001, `${r.id} 相似度越界`);
    assert.ok(r.similarity <= prev, "结果未按相似度降序");
    prev = r.similarity;
  }
});

// ============================================================ 媒介筛选
console.log("\n=== 3. 媒介筛选 ===");

check("绘画筛选只返回绘画", () => {
  const res = vs.searchByEmbedding(AG, { media: "artwork", limit: 10 }).results;
  assert.ok(res.length > 0);
  assert.ok(res.every((r) => r.kind === "artwork"));
});

check("电影筛选只返回电影", () => {
  const res = vs.searchByEmbedding(AG, { media: "film", limit: 10 }).results;
  assert.ok(res.every((r) => r.kind === "film"));
});

check("动画筛选返回 0 条且不报错（当前确实没有动画素材）", () => {
  const res = vs.searchByEmbedding(AG, { media: "animation", limit: 10 });
  assert.equal(res.results.length, 0);
  assert.equal(res.note, null);
});

// ============================================================ 结构特征
console.log("\n=== 4. 结构特征只用真实数据 ===");

check("画幅比例来自实测像素", () => {
  const lib = vs.library();
  const ag = lib.find((e) => e.id === "american-gothic");
  assert.equal(ag.structure.aspect.source, "measured-pixels");
  assert.ok(ag.structure.aspect.aspect > 0);
  // 0.83 左右的竖幅
  assert.ok(ag.structure.aspect.aspect < 1.0, `AG 应是竖幅，实测 ${ag.structure.aspect.aspect}`);
});

check("拿不到的维度必须列进 unavailable，不得补零", () => {
  const ag = vs.library().find((e) => e.id === "american-gothic");
  const u = ag.structure.unavailable;
  assert.ok(u.includes("arrangement"), "主体排布应标为不可得");
  assert.ok(u.includes("occlusion"));
  assert.ok(u.includes("props"));
  assert.equal(ag.structure.figure.count, null, "人数不能凭空给值");
});

check("影调来自既有色彩签名", () => {
  const ag = vs.library().find((e) => e.id === "american-gothic");
  assert.equal(ag.structure.tone.source, "color-signature");
  assert.ok(ag.structure.tone.lightness >= 0 && ag.structure.tone.lightness <= 1);
});

check("无记录时返回 null 而不是假特征", () => {
  assert.equal(sf.structureFeatures(null), null);
  assert.equal(sf.structureFeatures({}), null);
});

// ============================================================ 结构比较
console.log("\n=== 5. 结构比较 ===");

check("同一份特征自比接近满分", () => {
  const lib = vs.library();
  const s = lib[0].structure;
  const cmp = sf.compareStructure(s, s);
  assert.ok(cmp.score > 0.95, `自比只有 ${cmp.score}`);
});

check("缺失维度不参与，而不是当 0 分", () => {
  const full = vs.library()[0].structure;
  const empty = {
    id: "x", aspect: { aspect: null, orientation: null, source: "unavailable" },
    figure: { subject: null, scale: null, relation: null, count: null, source: "unavailable" },
    space: { depth: null, environmentDominance: null, negativeSpace: null, source: "unavailable" },
    tone: { lightness: null, saturation: null, warmth: null, source: "unavailable" },
    unavailable: [], sources: {},
  };
  const cmp = sf.compareStructure(full, empty);
  assert.equal(cmp.score, null, "一边全缺时应返回 null，而不是 0");
  assert.equal(cmp.comparable, 0);
});

check("逐维明细带方向（相同/差异）", () => {
  const lib = vs.library();
  const cmp = sf.compareStructure(lib[0].structure, lib[1].structure);
  assert.ok(Array.isArray(cmp.parts) && cmp.parts.length > 0);
  for (const p of cmp.parts) {
    assert.ok("value" in p && "weight" in p && "name" in p);
  }
});

// ============================================================ 组合检索
console.log("\n=== 6. 组合检索 ===");

check("组合结果带结构分与逐维结论", () => {
  const ag = vs.library().find((e) => e.id === "american-gothic");
  const res = vs.searchCombined(AG, ag.structure, { excludeId: "american-gothic", limit: 5 }).results;
  assert.ok(res.length > 0);
  for (const r of res) {
    assert.ok(typeof r.score === "number");
    assert.ok(Array.isArray(r.samePoints));
    assert.ok(Array.isArray(r.differences));
  }
});

check("没有结构特征时退化为纯向量，不报错", () => {
  const a = vs.searchCombined(AG, null, { excludeId: "american-gothic", limit: 5 }).results.map((r) => r.id);
  const b = vs.searchByEmbedding(AG, { excludeId: "american-gothic", limit: 5 }).results.map((r) => r.id);
  assert.deepEqual(a, b, "无结构证据时不应改变排序");
});

// ============================================================ 参考适用性
console.log("\n=== 7. 海报不能当参考画面 ===");

check("poster 被拒绝", () => {
  const r = vs.referenceSuitability({ media: { imageKind: "poster" } });
  assert.equal(r.ok, false);
});

check("frame 可用", () => {
  const r = vs.referenceSuitability({ media: { imageKind: "frame" } });
  assert.equal(r.ok, true);
});

// ============================================================ 汇总
console.log(`\n=== P4.14-D 实验检索回归: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
