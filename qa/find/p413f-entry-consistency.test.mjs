// p413f-entry-consistency.test.mjs — P4.13-F 入口一致性的最小定向回归
//
// 测的不是「分数变高了没有」，而是四个可被推翻的契约：
//   1. 无效输入（null / 空对象 / 未知 id / 未知 key / 数组）**不得**返回
//      貌似正常但不相关的榜单 —— 必须带错误码返回空结果
//   2. id 兜底必须**可观测**（resolution 字段），不能算「静默回退」
//   3. 同一作品 + 同一候选范围 + 同一图像证据 → 两个入口（作品页 limit=4 /
//      FIND 选画 limit=6）前 4 名必须逐位一致，分数也必须一致
//   4. 图像证据不同（上传像素 / 档案签名 / 无像素）必须被**显式区分**，
//      不得强行让结果相同，也不得把「没有证据」伪装成「色彩很近」
//
// 另外锁住两条不许回退的旧契约：自匹配被排除、P4.12 电影池仍是 14 排除 / 1 保留。
//
// 全部在进程内跑，不需要浏览器、不联网、不调 Provider、不读像素。

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name} — ${String(e.message).slice(0, 240)}`);
  }
}

// 浏览器端存储垫片：检索链读 localStorage
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

const svc = await imp("src/services/retrieval/retrievalService.js");
const scoring = await imp("src/services/retrieval/scoring.js");
const data = await imp("src/data/artworks.js");
const ARTWORKS = data.artworks || data.default || [];
const byId = new Map(ARTWORKS.map((a) => [a.id, a]));

const {
  retrieveByArtwork,
  retrieveByArtworkChecked,
  resolveRetrievalArtwork,
  buildEnhancement,
  ENHANCEMENT_EVIDENCE,
  RETRIEVAL_ARTWORK_ERRORS,
} = svc;

// ============================================================ 1. 无效输入
console.log("\n=== 1. 无效输入不得返回貌似正常的榜单 ===");

const invalidCases = [
  ["null", null, RETRIEVAL_ARTWORK_ERRORS.NOT_AN_OBJECT],
  ["undefined", undefined, RETRIEVAL_ARTWORK_ERRORS.NOT_AN_OBJECT],
  ["字符串", "american-gothic", RETRIEVAL_ARTWORK_ERRORS.NOT_AN_OBJECT],
  ["数组", [], RETRIEVAL_ARTWORK_ERRORS.NOT_AN_OBJECT],
  ["空对象", {}, RETRIEVAL_ARTWORK_ERRORS.MISSING_KEY],
  ["只有 title", { title: "American Gothic" }, RETRIEVAL_ARTWORK_ERRORS.MISSING_KEY],
  ["未知 id", { id: "no-such-artwork" }, RETRIEVAL_ARTWORK_ERRORS.UNKNOWN],
  ["未知 key", { key: "local:no-such-artwork" }, RETRIEVAL_ARTWORK_ERRORS.UNKNOWN],
  ["伪造 key 前缀", { key: "remote:whatever" }, RETRIEVAL_ARTWORK_ERRORS.UNKNOWN],
];

for (const [label, input, expected] of invalidCases) {
  check(`拒绝 ${label}（${expected}）`, () => {
    const r = retrieveByArtworkChecked(input, { limit: 6 });
    assert.equal(r.ok, false, "ok 必须为 false");
    assert.equal(r.error, expected, "错误码必须精确");
    assert.deepEqual(r.results, [], "结果必须为空数组");
    assert.equal(r.enhancement, null, "无效输入不产生增强描述");
    // 数组接口同样不能吐出一份正常榜单
    assert.deepEqual(retrieveByArtwork(input, { limit: 6 }), [], "retrieveByArtwork 必须返回空数组");
  });
}

// ============================================================ 2. 可观测的兜底
console.log("\n=== 2. id 兜底必须可观测，不能静默 ===");

check("完整对象解析为 key", () => {
  const r = resolveRetrievalArtwork(byId.get("starry"));
  assert.equal(r.ok, true);
  assert.equal(r.resolution, "key");
  assert.equal(r.artwork.id, "starry");
});

check("仅有 id 时解析为 id 且被标记", () => {
  const r = resolveRetrievalArtwork({ id: "starry" });
  assert.equal(r.ok, true);
  assert.equal(r.resolution, "id", "缺 key 靠 id 兜住时必须留痕");
  assert.equal(r.artwork.id, "starry");
});

check("checked 结果透传 resolution", () => {
  const r = retrieveByArtworkChecked({ id: "starry" }, { limit: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.resolution, "id");
});

// ============================================================ 3. 缓存不串门
console.log("\n=== 3. 缓存键不得串门（同进程连续不同作品）===");

check("starry 与 wanderer 的 Top3 不相同", () => {
  const a = retrieveByArtworkChecked(byId.get("starry"), { limit: 3 }).results.map((x) => x.artwork.id);
  const b = retrieveByArtworkChecked(byId.get("wanderer"), { limit: 3 }).results.map((x) => x.artwork.id);
  assert.notDeepEqual(a, b, "不同作品的榜单不得相同");
});

check("重复查询同一作品结果稳定", () => {
  const a = retrieveByArtworkChecked(byId.get("wanderer"), { limit: 3 }).results.map((x) => x.artwork.id);
  const b = retrieveByArtworkChecked(byId.get("wanderer"), { limit: 3 }).results.map((x) => x.artwork.id);
  assert.deepEqual(a, b);
});

// ============================================================ 4. 两入口一致
console.log("\n=== 4. 同作品 + 同证据 + 同候选范围 → 两入口排序一致 ===");

const CONSISTENCY_SAMPLES = ["american-gothic", "starry", "wanderer", "the-kiss", "utamaro-three-beauties"];

for (const id of CONSISTENCY_SAMPLES) {
  check(`作品页(limit=4) 与 FIND 选画(limit=6) 前 4 名一致：${id}`, () => {
    const page = retrieveByArtworkChecked(byId.get(id), { limit: 4 });
    const find = retrieveByArtworkChecked(byId.get(id), { limit: 6 });
    assert.equal(page.ok, true);
    assert.equal(find.ok, true);

    const pageIds = page.results.map((x) => x.artwork.id);
    const findIds = find.results.slice(0, 4).map((x) => x.artwork.id);
    assert.deepEqual(pageIds, findIds, "前 4 名必须逐位一致");

    // 分数也必须一致：limit 只截断，不改变打分
    const pageScores = page.results.map((x) => x.retrievalScore);
    const findScores = find.results.slice(0, 4).map((x) => x.retrievalScore);
    assert.deepEqual(pageScores, findScores, "同名前缀分数必须一致");

    assert.equal(page.enhancement.evidence, ENHANCEMENT_EVIDENCE.ARCHIVE_SIGNATURE);
    assert.equal(find.enhancement.evidence, ENHANCEMENT_EVIDENCE.ARCHIVE_SIGNATURE);
  });
}

check("limit 不改变同名次分数（4 vs 8）", () => {
  const a = retrieveByArtworkChecked(byId.get("american-gothic"), { limit: 4 });
  const b = retrieveByArtworkChecked(byId.get("american-gothic"), { limit: 8 });
  const aScores = a.results.map((x) => x.retrievalScore);
  const bScores = b.results.slice(0, aScores.length).map((x) => x.retrievalScore);
  assert.deepEqual(aScores, bScores);
});

// ============================================================ 5. 证据区分
console.log("\n=== 5. 三种图像证据必须被显式区分 ===");

check("档案签名：evidence=archive-signature 且 origin 为本地资产", () => {
  const e = buildEnhancement({ evidence: ENHANCEMENT_EVIDENCE.ARCHIVE_SIGNATURE, artwork: byId.get("american-gothic") });
  assert.equal(e.evidence, "archive-signature");
  assert.equal(e.querySignatureOrigin, "precomputed-local-asset");
  assert.ok(e.querySig, "档案作品应有签名");
});

check("无像素：evidence=none 且 querySig 为 null，并记录降级原因", () => {
  const e = buildEnhancement({ evidence: ENHANCEMENT_EVIDENCE.NONE });
  assert.equal(e.evidence, "none");
  assert.equal(e.querySig, null);
  assert.ok(e.degradation, "降级必须写明原因");
});

check("上传像素失败时降级而不伪造", () => {
  const e = buildEnhancement({
    evidence: ENHANCEMENT_EVIDENCE.UPLOADED_PIXELS,
    querySig: { ok: false },
  });
  assert.equal(e.querySig, null, "失败的上传签名不得被当作证据");
  assert.equal(e.querySignatureOrigin, "unavailable");
  assert.ok(e.degradation);
});

check("档案签名不得冒充上传像素", () => {
  const e = buildEnhancement({ evidence: ENHANCEMENT_EVIDENCE.ARCHIVE_SIGNATURE, artwork: byId.get("starry") });
  assert.equal(e.querySignatureOrigin, "precomputed-local-asset");
  assert.notEqual(e.querySignatureOrigin, "computed-from-uploaded-pixels");
});

check("同一作品：档案签名 vs 无像素，证据不同且被记录", () => {
  const withSig = retrieveByArtworkChecked(byId.get("american-gothic"), { limit: 4 });
  const noSig = retrieveByArtworkChecked(byId.get("american-gothic"), {
    limit: 4,
    enhanced: buildEnhancement({ evidence: ENHANCEMENT_EVIDENCE.NONE }),
  });
  assert.equal(withSig.enhancement.evidence, "archive-signature");
  assert.equal(noSig.enhancement.evidence, "none");
  // 证据不同时排序【可以】不同，但差异必须可归因到证据本身，而非静默漂移
  assert.ok(Array.isArray(noSig.results));
});

// ============================================================ 6. 不许回退的旧契约
console.log("\n=== 6. 旧契约不许回退 ===");

check("查询作品自身不出现在结果里", () => {
  const r = retrieveByArtworkChecked(byId.get("american-gothic"), { limit: 12 });
  assert.ok(!r.results.some((x) => x.artwork.id === "american-gothic"));
});

check("P4.12 电影池：14 排除 / 1 保留，保留的是彩色片", () => {
  const pool = svc.filmStillPool();
  assert.equal(pool.length, 1, "池内应只剩 1 部");
  assert.equal(pool[0].id || pool[0].artwork?.id, "film-toll-of-the-sea");

  const excluded = svc.excludedFilmCandidates();
  assert.equal(excluded.length, 14);
  const excludedIds = excluded.map((x) => x.id || x.artwork?.id);
  assert.ok(excludedIds.includes("film-the-general"), "黑白片必须在排除名单");
  assert.ok(!pool.some((x) => (x.id || x.artwork?.id) === "film-the-general"), "黑白片不得在池内");
});

check("scoreIntent 仍是确定性纯函数（同输入同输出）", () => {
  const q = { subject: "group", subjectScale: "large", spatialDepth: "deep" };
  const c = { subject: "group", subjectScale: "large", spatialDepth: "shallow" };
  const a = scoring.scoreIntent(q, c);
  const b = scoring.scoreIntent(q, c);
  assert.deepEqual(a, b, "scoreIntent 必须确定性");
  // 命中 subject 1.5 + subjectScale 3 = 4.5；spatialDepth 不同不计分
  assert.equal(a.score, 4.5, "加权分数必须可手算复现");
});

// ============================================================ 汇总
console.log(`\n=== P4.13-F 入口一致性回归: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
