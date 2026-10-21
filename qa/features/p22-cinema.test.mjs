// p22-cinema.test.mjs — Phase 2.2A：电影/动画画面的授权与语义契约
//
// 钉四件事：
//   1. 画面 vs 非画面（海报、片名字卡、预告、幕后）——分类与标题都要能挡
//   2. 只有公有领域 / CC 许可能入库；缺字段一律跳过，不为凑数放宽
//   3. 动画帧与电影帧是不同 imageKind，媒介筛选各自认各的
//   4. 入库画面必须能追溯到影片、时间戳、许可与来源链接

import assert from "node:assert/strict";
import path from "node:path";
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
const cinema = await imp("scripts/discovery/providers/commonsCinema.mjs");
const media = await imp("src/services/explore/externalMedia.js");
const storeMod = await imp("scripts/discovery/store.mjs");

console.log("=== 1. 画面 vs 非画面 ===");
await check("海报、片名字卡、预告、幕后都不算画面", () => {
  for (const bad of ["Film poster.jpg", "Opening title card.png", "Intertitle 1924.png", "Trailer screenshot.jpg", "Behind the scenes.jpg", "Making-of photo.jpg", "DVD cover.jpg"]) {
    assert.equal(cinema.isFrameCandidate(bad, "Category:Film screenshots"), false, `应排除 ${bad}`);
  }
});

await check("正常画面文件名可以进入候选", () => {
  assert.equal(cinema.isFrameCandidate("Film frame 1927.jpg", "Category:Film frames"), true);
  assert.equal(cinema.isFrameCandidate("Bosko-sinkininthebathtub1930.jpg", "Category:Animated film screenshots"), true);
});

console.log("\n=== 2. 许可判定 ===");
await check("公有领域与 CC 许可通过", () => {
  for (const lic of ["Public domain", "CC0", "CC BY-SA 4.0", "CC BY 3.0"]) {
    const v = cinema.licenseVerdict({ LicenseShortName: { value: lic } });
    assert.equal(v.ok, true, `${lic} 应通过`);
  }
});

await check("fair use / 保留所有权利 / 缺字段一律拒绝", () => {
  assert.equal(cinema.licenseVerdict({ LicenseShortName: { value: "Fair use" } }).ok, false);
  assert.equal(cinema.licenseVerdict({ LicenseShortName: { value: "All rights reserved" } }).ok, false);
  assert.equal(cinema.licenseVerdict({}).ok, false);
});

await check("拒绝时给出原因，不静默丢弃", () => {
  const v = cinema.licenseVerdict({ LicenseShortName: { value: "Fair use" } });
  assert.ok(/不可用|不明/.test(v.reason));
});

console.log("\n=== 3. 画面类型与媒介 ===");
await check("动画帧是独立 imageKind，且被视为动画画面", () => {
  assert.equal(norm.IMAGE_KINDS.ANIMATION_FRAME, "animation-frame");
  assert.equal(norm.isAnimationFrame({ imageKind: "animation-frame" }), true);
  assert.equal(norm.isAnimationFrame({ imageKind: "anime-cover" }), false, "目录封面不是画面");
});

await check("电影档只认 film-still / tv-episode-still，动画档只认 animation-frame / tv-episode-still", () => {
  const film = { imageKind: "film-still", metrics: { meanSat: 0.3 } };
  const anim = { imageKind: "animation-frame", metrics: { meanSat: 0.35 } };
  assert.equal(media.matchesMedia(film, "film"), true);
  assert.equal(media.matchesMedia(film, "animation"), false);
  assert.equal(media.matchesMedia(anim, "animation"), true);
  assert.equal(media.matchesMedia(anim, "film"), false);
  assert.equal(media.matchesMedia(anim, "cross"), true);
  assert.equal(media.matchesMedia(anim, "artwork"), false);
});

await check("黑白影片画面仍被排除在参考之外", () => {
  const mono = { imageKind: "film-still", metrics: { meanSat: 0.02 } };
  assert.equal(media.matchesMedia(mono, "film"), false);
});

console.log("\n=== 4. 入库画面可追溯 ===");
await check("库里电影帧与动画帧各自达到 10 张", () => {
  const works = storeMod.readWorks();
  const film = works.filter((w) => w.imageKind === "film-still");
  const anim = works.filter((w) => w.imageKind === "animation-frame");
  assert.ok(film.length >= 10, `电影帧只有 ${film.length}`);
  assert.ok(anim.length >= 10, `动画帧只有 ${anim.length}`);
});

await check("每一张画面都有许可、来源链接与真实尺寸", () => {
  const frames = storeMod.readWorks().filter((w) => w.imageKind === "film-still" || w.imageKind === "animation-frame");
  assert.ok(frames.length > 0);
  for (const f of frames) {
    assert.ok(f.rightsStatus || f.license, `${f.id} 缺许可`);
    assert.ok(/^https?:\/\//.test(f.sourceUrl || ""), `${f.id} 缺来源链接`);
    assert.ok(f.width >= 200 && f.height >= 200, `${f.id} 尺寸异常 ${f.width}x${f.height}`);
    assert.ok(!/poster|title.?card|trailer/i.test(f.title || ""), `${f.id} 标题像非画面内容：${f.title}`);
  }
});

await check("Blender 抽帧带影片名与时间戳（可回溯到第几秒）", () => {
  const blender = storeMod.readWorks().filter((w) => w.provider === "blender");
  assert.ok(blender.length >= 10, `抽帧只有 ${blender.length} 条`);
  for (const b of blender) {
    assert.ok(b.extra && b.extra.movie, `${b.id} 缺影片名`);
    assert.equal(typeof b.timestamp, "number", `${b.id} 缺时间戳`);
    assert.ok(/CC BY/.test(b.license || ""), `${b.id} 许可应为 CC BY`);
    assert.ok(b.extra.licenseUrl, `${b.id} 缺许可链接`);
  }
});

await check("抽帧没有被当成封面：imageKind 只有 film-still / animation-frame", () => {
  const kinds = new Set(storeMod.readWorks().filter((w) => w.provider === "blender").map((w) => w.imageKind));
  for (const k of kinds) assert.ok(["film-still", "animation-frame"].includes(k), `异常类型 ${k}`);
});

console.log(`\n=== Phase 2.2A: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
