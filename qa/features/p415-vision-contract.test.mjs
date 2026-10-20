// p415-vision-contract.test.mjs — P4.15 STEP 2/4/5 的契约测试
//
// 这里**不测模型答得好不好**——那只能靠真实调用和真图验收（STEP 6）。
// 这里钉的是我们自己的纪律：
//   · 多图请求里第一张必须是查询图，后续顺序与候选一致
//   · 模型说 high 却给不出两处具体相似点 → 必须降级
//   · 「同为群像」这类无法核对的话不算相似点
//   · 看不见的字段必须留 null 并进 unknown，不许补
//   · 没配置 provider 时不许假装成功；超额时不许继续调
//   · 缓存键必须随模型/提示版本变化

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

const mm = await imp("server/vision/multimodalCompare.js");
const cacheMod = await imp("experiment/p415/analysis-cache.mjs");
const { buildCompareMessages, parseComparison, isConcrete, parseAnalysis, compareImages, VERDICTS, COMPARE_ERRORS } = mm;

const img = (tag) => ({ b64: `BASE64-${tag}`, mime: "image/jpeg" });

// ============================================================ 1. 多图请求
console.log("=== 1. 多图请求结构 ===");

await check("第一张是查询图，其余按候选顺序", () => {
  const msgs = buildCompareMessages({
    queryImage: img("query"),
    candidates: [img("c1"), img("c2"), img("c3")],
  });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  const parts = msgs[1].content;
  assert.equal(parts[0].type, "text");
  const urls = parts.filter((p) => p.type === "image_url").map((p) => p.image_url.url);
  assert.equal(urls.length, 4, "应为 1 张查询 + 3 张候选");
  assert.ok(urls[0].includes("BASE64-query"), "第一张不是查询图");
  assert.ok(urls[1].includes("BASE64-c1"));
  assert.ok(urls[3].includes("BASE64-c3"));
});

await check("文本里写明候选数量与顺序约定", () => {
  const msgs = buildCompareMessages({ queryImage: img("q"), candidates: [img("a"), img("b")] });
  const text = msgs[1].content[0].text;
  assert.match(text, /第 1 张图/);
  assert.match(text, /候选共 2 张/);
});

await check("缺图时构造直接失败，不发请求", () => {
  assert.throws(() => buildCompareMessages({ queryImage: null, candidates: [img("a")] }), /missing-query-image/);
  assert.throws(() => buildCompareMessages({ queryImage: img("q"), candidates: [] }), /missing-candidates/);
  assert.throws(() => buildCompareMessages({ queryImage: img("q"), candidates: [{ b64: "" }] }), /missing-candidate-image/);
});

// ============================================================ 2. 降级纪律
console.log("\n=== 2. 判定降级：不许空口号 ===");

const wrap = (arr) => ({ candidates: arr });
const base = { figureOrganization: null, borrowableLight: null, borrowableColor: null, borrowableSpace: null, majorDifferences: ["人物组织完全不同"], borrowableForCreation: null, unknown: [] };

await check("high + 2 条具体相似点 → 保持 high", () => {
  const r = parseComparison(wrap([{ ...base, verdict: "high", similarPoints: ["两人并立居中，正对镜头", "背景建筑形成竖向框架"] }]), 1);
  assert.equal(r.ok, true);
  assert.equal(r.judgments[0].verdict, VERDICTS.HIGH);
  assert.equal(r.judgments[0].downgraded, false);
});

await check("high + 只有 1 条 → 降为 partial", () => {
  const r = parseComparison(wrap([{ ...base, verdict: "high", similarPoints: ["两人并立居中"] }]), 1);
  assert.equal(r.judgments[0].verdict, VERDICTS.PARTIAL);
  assert.equal(r.judgments[0].downgraded, true);
});

await check("high + 0 条 → 降为 unrelated", () => {
  const r = parseComparison(wrap([{ ...base, verdict: "high", similarPoints: [] }]), 1);
  assert.equal(r.judgments[0].verdict, VERDICTS.UNRELATED);
  assert.equal(r.dropped.length, 1);
});

await check("partial + 0 条 → 降为 unrelated", () => {
  const r = parseComparison(wrap([{ ...base, verdict: "partial", similarPoints: [] }]), 1);
  assert.equal(r.judgments[0].verdict, VERDICTS.UNRELATED);
});

await check("泛泛而谈不算相似点（同为群像/低饱和）", () => {
  assert.equal(isConcrete("同为群像"), false);
  assert.equal(isConcrete("都是低饱和"), false);
  assert.equal(isConcrete("都有纵深"), false);
  assert.equal(isConcrete("人物都在画面下半部，视线朝向左侧"), true);
  assert.equal(isConcrete("光源从左前方来，右下留白"), true);
});

await check("把「同为群像」当唯一相似点的 high → 降到 unrelated", () => {
  const r = parseComparison(wrap([{ ...base, verdict: "high", similarPoints: ["同为群像", "都是低饱和"] }]), 1);
  assert.equal(r.judgments[0].verdict, VERDICTS.UNRELATED);
});

await check("候选数量对不上就整份报废，不猜对齐", () => {
  const r = parseComparison(wrap([{ ...base, verdict: "partial", similarPoints: ["x"] }]), 3);
  assert.equal(r.ok, false);
  assert.match(r.detail, /候选数量不符/);
});

await check("没有 candidates 数组 → 失败", () => {
  assert.equal(parseComparison({}, 1).ok, false);
  assert.equal(parseComparison(null, 1).ok, false);
});

// ============================================================ 3. 看不见就不写
console.log("\n=== 3. 单图分析 V2：未知字段留空 ===");

await check("全空 → 判定为没有可用证据", () => {
  const r = parseAnalysis({ subject: {}, space: {}, composition: {}, color: {}, light: {} });
  assert.equal(r.ok, false);
});

await check("缺字段填 null 并进 unknown，不补零", () => {
  const r = parseAnalysis({
    subject: { description: "两人并立", count: 2 },
    space: { foreground: "前景草地", midground: null, background: "木屋", depthCue: "线性透视" },
    composition: { skeleton: "三角形", subjectPosition: "中央", visualWeight: "偏上" },
    color: { dominant: "土绿与橄榄", temperature: "neutral", contrast: "medium" },
    light: { direction: "右前方", quality: "硬光", organization: "面部受光、背景压暗" },
    unknown: ["texture"],
  });
  assert.equal(r.ok, true);
  assert.equal(r.analysis.space.midground, null);
  assert.deepEqual(r.analysis.unknown, ["texture"]);
  assert.equal(r.analysis.subject.count, 2);
});

await check("模型把 null 写成字符串也要还原成 null", () => {
  const r = parseAnalysis({
    subject: { description: "街景", count: 0 },
    space: { foreground: "街道" },
    light: { direction: "unknown", quality: "null", organization: "均匀平光" },
    composition: { skeleton: "水平线" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.analysis.light.direction, null);
  assert.equal(r.analysis.light.quality, null);
});

await check("缺核心块就明确报错，不静默返回 null 并声明成功", () => {
  const r = parseAnalysis({ subject: { description: "街景", count: 0 }, composition: { skeleton: "水平线" } });
  assert.equal(r.ok, false, "缺少 light / space 却被当成成功");
  assert.equal(r.error, "incomplete-analysis");
  assert.deepEqual(r.missing, ["light", "space"]);
  assert.ok(r.detail.includes("light"));
});

await check("四个核心块齐了才算成功", () => {
  const r = parseAnalysis({
    subject: { description: "x", count: 1 },
    composition: { visualWeight: "中" },
    light: { organization: "平光" },
    space: { depthCue: "线性透视" },
  });
  assert.equal(r.ok, true);
});

// ============================================================ 4. 不配置就不装
console.log("\n=== 4. 未配置 / 超额 ===");

await check("未配置 provider → NOT_CONFIGURED，不发请求", async () => {
  let called = false;
  const r = await compareImages({
    queryImage: img("q"),
    candidates: [img("c")],
    config: { configured: false },
    fetchImpl: async () => { called = true; return { ok: true }; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, COMPARE_ERRORS.NOT_CONFIGURED);
  assert.equal(called, false, "未配置却发了请求");
});

await check("本轮上限用完 → LIMIT，不发请求", async () => {
  let called = false;
  const r = await compareImages({
    queryImage: img("q"),
    candidates: [img("c")],
    config: { configured: true, roundLimit: 5, used: 5, endpoint: "http://x", credential: "k", model: "m" },
    fetchImpl: async () => { called = true; },
  });
  assert.equal(r.error, COMPARE_ERRORS.LIMIT);
  assert.equal(called, false);
});

await check("预算账本缺失时 fail-closed", async () => {
  let called = false;
  const r = await compareImages({
    queryImage: img("q"),
    candidates: [img("c")],
    config: {
      configured: true, roundLimit: 0, used: 0, endpoint: "http://x", credential: "k", model: "m",
      budget: { enabled: false, file: null },
    },
    reserve: true,
    fetchImpl: async () => { called = true; },
  });
  assert.equal(r.error, COMPARE_ERRORS.BUDGET);
  assert.equal(called, false, "没有账本却扣费了");
});

// ============================================================ 5. 缓存
console.log("\n=== 5. 分析缓存 ===");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p415-cache-"));
const cache = new cacheMod.AnalysisCache(tmp);
const buf = Buffer.from("fake-image-bytes");

await check("同一图 + 同模型 + 同提示版本 → 同键", () => {
  const a = cacheMod.cacheKey(buf, { model: "m1", promptVersion: "p1" });
  const b = cacheMod.cacheKey(buf, { model: "m1", promptVersion: "p1" });
  assert.equal(a, b);
});

await check("换模型或换提示版本 → 不同键（不许复用旧结果）", () => {
  const a = cacheMod.cacheKey(buf, { model: "m1", promptVersion: "p1" });
  const b = cacheMod.cacheKey(buf, { model: "m2", promptVersion: "p1" });
  const c = cacheMod.cacheKey(buf, { model: "m1", promptVersion: "p2" });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

await check("写入后能读回，且键对不上返回 null", () => {
  const k = cacheMod.cacheKey(buf, { model: "m1", promptVersion: "p1" });
  cache.put(k, { kind: "analysis", model: "m1", promptVersion: "p1", payload: { ok: true, analysis: { a: 1 } } });
  assert.deepEqual(cache.get(k).payload.analysis, { a: 1 });
  assert.equal(cache.get("wrong-key"), null);
});

await check("同一张图第二次不再调用模型", async () => {
  let calls = 0;
  const compute = async () => { calls++; return { ok: true, analysis: { x: 1 } }; };
  const k = cacheMod.cacheKey(Buffer.from("img2"), { model: "m1", promptVersion: "p1" });
  await cacheMod.cachedAnalysis({ cache, key: k, kind: "analysis", model: "m1", promptVersion: "p1", compute });
  const second = await cacheMod.cachedAnalysis({ cache, key: k, kind: "analysis", model: "m1", promptVersion: "p1", compute });
  assert.equal(calls, 1, `调用了 ${calls} 次`);
  assert.equal(second.hit, true);
});

await check("失败的调用不写缓存", async () => {
  const k = cacheMod.cacheKey(Buffer.from("img3"), { model: "m1", promptVersion: "p1" });
  await cacheMod.cachedAnalysis({ cache, key: k, kind: "analysis", model: "m1", promptVersion: "p1", compute: async () => ({ ok: false, error: "timeout" }) });
  assert.equal(cache.get(k), null);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n=== P4.15 视觉链路契约: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
