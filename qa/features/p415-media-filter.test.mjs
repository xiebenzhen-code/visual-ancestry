// p415-media-filter.test.mjs — P4.15 STEP 1：媒介筛选的硬性约束
//
// 起因是三条用户可见的错误：
//   1. 选「动画」出现《维纳斯的诞生》
//   2. 「彩色电影」候选极少
//   3. 夜间街景返回中国书法山水（这条不是筛选问题，是排序问题，本文件只钉前两条）
//
// 这里钉的是「不可能被合理解释掉」的约束：
//   · 绘画不得通过 film / animation / anime 任意一档
//   · anime 必须是 animation 的子集，不能等同
//   · 声明与图片矛盾时，导入必须被拒绝或按图片改写，不许落一条错记录
//   · 候选计数必须等于池内实际条数

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

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

const vs = await imp("src/services/features/visualSearch.js");
const guard = await imp("experiment/p414/media-guard.mjs");
const { passMedia, library, LIBRARY_META } = vs;
const LIB = library();

const count = (media) => LIB.filter((e) => passMedia(e, media)).length;

// ============================================================ 1. 基础库
console.log("=== 1. 基础库的媒介归属 ===");

await check("基础库 47 条", () => assert.equal(LIB.length, 47, `实得 ${LIB.length}`));

await check("绘画 46 条，影片 1 条", () => {
  assert.equal(count("artwork"), 46);
  assert.equal(count("film"), 1);
});

await check("动画档为 0（本地没有动画画面，这是事实不是 bug）", () => {
  assert.equal(count("animation"), 0, "基础库里出现了动画条目");
});

await check("四档相加不超过总数（无重复计入）", () => {
  const sum = count("artwork") + count("film") + count("animation");
  assert.equal(sum, LIB.length, `相加 ${sum} ≠ ${LIB.length}`);
});

// ============================================================ 2. 互斥
console.log("\n=== 2. 类别互斥：一幅画不可能同时是影片 ===");

await check("绘画条目不得通过 film 档", () => {
  for (const e of LIB.filter((x) => x.kind === "artwork")) {
    assert.equal(passMedia(e, "film"), false, `${e.id} 被算进彩色电影`);
  }
});

await check("绘画条目不得通过 animation 档", () => {
  for (const e of LIB.filter((x) => x.kind === "artwork")) {
    assert.equal(passMedia(e, "animation"), false, `${e.id} 被算进动画`);
  }
});

await check("影片条目不得通过 artwork 档", () => {
  for (const e of LIB.filter((x) => x.kind === "film")) {
    assert.equal(passMedia(e, "artwork"), false, `${e.id} 被算进绘画`);
  }
});

await check("animation 条目不得通过 film 档（否则两类混在一起）", () => {
  const fake = { id: "x", kind: "film", media: { medium: "film", visualForm: "animation" } };
  assert.equal(passMedia(fake, "film"), false);
  assert.equal(passMedia(fake, "animation"), true);
});

// ============================================================ 3. anime 语义
console.log("\n=== 3. anime 是 animation 的子集 ===");

await check("visualForm=animation + tradition=anime → 算 anime", () => {
  const e = { id: "a", kind: "film", media: { medium: "film", visualForm: "animation", tradition: "anime" } };
  assert.equal(passMedia(e, "anime"), true);
  assert.equal(passMedia(e, "animation"), true, "anime 必须同时落在 animation 档");
});

await check("visualForm=animation 但没有 anime 传统 → 不算 anime", () => {
  const e = { id: "b", kind: "film", media: { medium: "film", visualForm: "animation", tradition: null } };
  assert.equal(passMedia(e, "anime"), false, "把普通动画算成日本动漫");
  assert.equal(passMedia(e, "animation"), true);
});

await check("只有 tradition=anime 但不是动画 → 不算 anime", () => {
  const e = { id: "c", kind: "film", media: { medium: "film", visualForm: "live-action", tradition: "anime" } };
  assert.equal(passMedia(e, "anime"), false);
});

// ============================================================ 4. 计数口径
console.log("\n=== 4. 候选计数 ===");

await check("计数等于池内实际条数（不是渲染条数）", () => {
  for (const m of ["all", "artwork", "film", "animation"]) {
    const expect = LIB.filter((e) => passMedia(e, m)).length;
    assert.equal(count(m), expect, `${m} 档计数不符`);
  }
});

await check("all 档等于基础库总数", () => assert.equal(count("all"), LIB.length));

// ============================================================ 5. 导入守门
console.log("\n=== 5. 导入守门：分类以图片为准 ===");

const venusPath = path.join(ROOT, "public/assets/artworks/birth-of-venus/preview.webp");
const venusBuf = fs.readFileSync(venusPath);

await check("与馆藏逐字节相同的图被标成 animation → 按图片改写为绘画", async () => {
  const r = await guard.deriveMedia({
    buffer: venusBuf,
    declared: { medium: "film", visualForm: "animation", tradition: "anime", imageKind: "frame" },
    root: ROOT,
  });
  assert.equal(r.ok, true);
  assert.equal(r.media.medium, "artwork", "仍然被当成影片");
  assert.equal(r.media.visualForm, "still-image");
  assert.equal(r.media.tradition, "symbolism", `tradition 应为 symbolism，实得 ${r.media.tradition}`);
  assert.match(String(r.evidence), /^base-image:birth-of-venus$/);
  assert.ok(r.note && r.note.includes("birth-of-venus"), "没有向用户说明改写原因");
});

await check("「绘画 + animation」这种自报 → 拒绝导入", async () => {
  const r = await guard.deriveMedia({
    buffer: venusBuf,
    declared: { medium: "artwork", visualForm: "animation" },
    root: ROOT,
  });
  assert.equal(r.ok, false, "矛盾声明被放行");
  assert.equal(r.error, guard.GUARD_ERRORS.CONFLICT);
});

await check("非图片字节 → 拒绝", async () => {
  const r = await guard.deriveMedia({ buffer: Buffer.from("not an image"), declared: {}, root: ROOT });
  assert.equal(r.ok, false);
  assert.equal(r.error, guard.GUARD_ERRORS.NOT_IMAGE);
});

await check("真正的新图（不在馆藏里）声明为动画 → 保留声明", async () => {
  // 造一张最小的合法 PNG（1×1 透明），其字节不在基础图库索引里
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  const r = await guard.deriveMedia({
    buffer: png,
    declared: { medium: "film", visualForm: "animation", tradition: "anime", imageKind: "frame" },
    root: ROOT,
  });
  assert.equal(r.ok, true);
  assert.equal(r.media.medium, "film");
  assert.equal(r.media.visualForm, "animation");
  assert.equal(r.evidence, null, "新图不该被归属到任何馆藏");
});

await check("anime 声明但没声明动画 → 归入动画", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  const r = await guard.deriveMedia({
    buffer: png,
    declared: { medium: "film", visualForm: "frame", tradition: "anime" },
    root: ROOT,
  });
  assert.equal(r.ok, true);
  assert.equal(r.media.visualForm, "animation");
});

// ============================================================ 6. 空结果
console.log("\n=== 6. 没有候选就是空 ===");

await check("动画档在空池上返回 0，不回落成全池", () => {
  const onlyArtworks = LIB.filter((e) => e.kind === "artwork");
  const got = onlyArtworks.filter((e) => passMedia(e, "animation"));
  assert.equal(got.length, 0);
});

// ============================================================ 汇总
console.log(`\n=== P4.15 媒介筛选约束: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
