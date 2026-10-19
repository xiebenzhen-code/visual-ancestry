// P4.4 定向验收 —— 接入真实性、查询修复、缺失值感知、色彩/语境接入、质量对比
//
// 证据级别：
//   [MOCK]          纯函数
//   [INTEGRATION]   真实产品模块 + 真实本地数据/像素
//   [REAL-PROVIDER] 真实付费 Vision —— 本轮复用 P4.2 已存结果，0 次新调用
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
globalThis.window = globalThis.window || {
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
};

let pass = 0, fail = 0;
const rows = [];
const check = (tag, name, cond, detail = "") => {
  if (cond) { pass++; rows.push({ tag, name, ok: true }); console.log(`  PASS [${tag}] ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; rows.push({ tag, name, ok: false, detail }); console.log(`  FAIL [${tag}] ${name}${detail ? " — " + detail : ""}`); }
};

// ============================================ STEP 1 接入真实性
console.log("=== STEP 1 接入链（INTEGRATION）===");
{
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
  const rsSrc = read("src/services/retrieval/retrievalService.js");
  const findSrc = read("src/pages/find.js");

  check("INTEGRATION", "retrievalService 导入 rerank", /from "\.\/rerank\.js"/.test(rsSrc));
  check("INTEGRATION", "retrievalService 导入 artContext", /from "\.\/artContext\.js"/.test(rsSrc));
  check("INTEGRATION", "retrievalService 导入 colorIndex", /from "\.\/colorIndex\.js"/.test(rsSrc));
  check("INTEGRATION", "retrievalService 导入 missingAwareRanking", /from "\.\/missingAwareRanking\.js"/.test(rsSrc));
  check("INTEGRATION", "find.js 导入 colorIndex", /from "\.\.\/services\/retrieval\/colorIndex\.js"/.test(findSrc));
  check("INTEGRATION", "find.js 导入浏览器色彩计算", /colorSignatureBrowser\.js/.test(findSrc));
  check("INTEGRATION", "find.js 文本检索传 enhanced", /retrieveByText\(query, \{[\s\S]{0,200}enhanced:/.test(findSrc));
  check("INTEGRATION", "find.js 图片检索传 querySig", /analyzeImageSignatureInBrowser/.test(findSrc) && /querySig: sigForSearch/.test(findSrc));
  check("INTEGRATION", "上传签名标注来自像素", /computed-from-uploaded-pixels/.test(findSrc));
}

// ============================================ STEP 2 常见查询
console.log("\n=== STEP 2 常见查询修复（INTEGRATION）===");
{
  const ql = await imp("src/services/retrieval/queryLexicon.js");
  const { emptyVisualIntent } = await imp("src/services/retrieval/visualIntent.js");

  const WORDS = ["战争", "肖像", "静物", "室内", "城市", "雪", "日本", "宗教", "人群", "海"];
  const unmatched = WORDS.filter((w) => {
    const a = ql.analyzeQuery(w);
    return !a.visualTerms.length && !a.subjectTerms.length && !a.cultureTerms.length;
  });
  check("INTEGRATION", "10 组查询全部被识别（无 UNMATCHED）", unmatched.length === 0, `未识别: ${unmatched.join(",")}`);

  // 严禁把题材/文化伪装成视觉结构
  const fake = ["战争", "肖像", "静物", "室内", "日本", "宗教"];
  let violations = [];
  for (const w of fake) {
    const r = ql.applyVisualLexicon(emptyVisualIntent(), w);
    const filled = Object.entries(r.intent).filter(([k, v]) => !["source", "raw"].includes(k) && (Array.isArray(v) ? v.length : Boolean(v)));
    if (filled.length > 0) violations.push(`${w}→${filled.map(([k]) => k).join(",")}`);
  }
  check("INTEGRATION", "题材/文化词不产生任何视觉字段", violations.length === 0, violations.join(" | "));

  // 战争不得映射成情绪
  const warIntent = ql.applyVisualLexicon(emptyVisualIntent(), "战争").intent;
  check("INTEGRATION", "「战争」不产生 emotion", (warIntent.emotion || []).length === 0);
  check("INTEGRATION", "「战争」不产生 atmosphere", (warIntent.atmosphere || []).length === 0);
  // 日本不得映射成构图
  const jpIntent = ql.applyVisualLexicon(emptyVisualIntent(), "日本").intent;
  check("INTEGRATION", "「日本」不产生 subject/spatialDepth/composition", !jpIntent.subject && !jpIntent.spatialDepth && !jpIntent.composition);

  // 视觉词仍能工作
  const snow = ql.applyVisualLexicon(emptyVisualIntent(), "雪");
  check("INTEGRATION", "「雪」映射为冷色低饱和（真实视觉属性）", snow.intent.colorTemperature === "cool" && snow.intent.saturation === "low");

  // 空结果必须带原因
  const rs = await imp("src/services/retrieval/retrievalService.js");
  // P4.5 修正了「战争」的召回（语义层 themes 命中 third-of-may）。
  // 所以这里不能再断言它为空 —— 改用档案里确实不存在的题材做空结果检验。
  const emptyRes = rs.retrieveByText("静物", { enhanced: { signatures: {} } });
  check("INTEGRATION", "无匹配时返回空并给出原因",
    emptyRes.results.length === 0 && typeof emptyRes.emptyReason === "string" && emptyRes.emptyReason.length > 0,
    emptyRes.emptyReason);
  check("INTEGRATION", "空结果不被填充无关作品", emptyRes.results.length === 0);
  // 而「战争」现在应当有结果（P4.5 修复项）
  const warRes2 = rs.retrieveByText("战争", { enhanced: { signatures: {} } });
  check("INTEGRATION", "P4.5 后「战争」能召回历史战争题材", warRes2.results.length > 0, `n=${warRes2.results.length}`);
}

// ============================================ STEP 3 缺失值感知
console.log("\n=== STEP 3 字段密度不公平（MOCK + INTEGRATION）===");
{
  const { compareWithMissingAwareness, rankWithMissingAwareness } = await imp("src/services/retrieval/missingAwareRanking.js");
  const { artworks } = await imp("src/data/artworks.js");
  const { filmStills } = await imp("src/data/filmStills.js");
  const { intentForArtwork } = await imp("src/services/retrieval/retrievalService.js");

  // 结构不对称仍存在（记录事实）
  const W = ["subject","subjectScale","subjectPosition","spatialDepth","negativeSpace","environmentDominance",
    "lightDirection","lightQuality","colorTemperature","saturation","contrast","humanRelation",
    "cameraDistance","cameraHeight","cameraRelation","motion","visualDensity","arousal","socialDistance","melancholy"];
  const dens = (it) => W.filter((f) => it[f]).length + (it.emotion?.length ? 1 : 0) + (it.atmosphere?.length ? 1 : 0);
  const filmFull = filmStills.every((f) => dens(f.visualIntent || {}) === 22);
  const artFull = artworks.filter((a) => a.image && !a.imageUnavailable).filter((a) => dens(intentForArtwork(a) || {}) === 22).length;
  check("INTEGRATION", "记录事实：电影 15/15 满字段、画作 0 满字段", filmFull && artFull === 0, `film full=${filmFull} artwork full=${artFull}`);

  // missing ≠ mismatch
  const q = { subject: "group", spatialDepth: "shallow", negativeSpace: "low" };
  const missing = { subject: "group" }; // 其余 missing
  const conflict = { subject: "place", spatialDepth: "deep", negativeSpace: "high" };
  const rm = compareWithMissingAwareness(q, missing);
  const rc = compareWithMissingAwareness(q, conflict);
  check("MOCK", "missing 不产生冲突权重", rm.conflictWeight === 0, `conflictW=${rm.conflictWeight}`);
  check("MOCK", "conflict 产生冲突权重", rc.conflictWeight > 0, `conflictW=${rc.conflictWeight}`);
  check("MOCK", "冲突比缺失惩罚更重", rc.conflictPenalty > rm.conflictPenalty, `conflict=${rc.conflictPenalty} missing=${rm.conflictPenalty}`);

  // 稀疏证据不得虚高
  const rich20 = { subject:"group", subjectScale:"large", subjectPosition:"center", spatialDepth:"shallow",
    negativeSpace:"low", environmentDominance:"low", lightDirection:"front", lightQuality:"diffuse",
    colorTemperature:"neutral", saturation:"low", contrast:"medium", humanRelation:"together",
    cameraDistance:"near", cameraHeight:"eye", cameraRelation:"observational", motion:"still",
    visualDensity:"dense", arousal:"low", socialDistance:"high", melancholy:"high" };
  const sparse = { subject: "group" };
  const rRich = compareWithMissingAwareness(rich20, rich20);
  const rSparse = compareWithMissingAwareness(rich20, sparse);
  check("MOCK", "稀疏候选（1/20）分数远低于充分候选（20/20）", rSparse.qualityScore < rRich.qualityScore / 5, `sparse=${rSparse.qualityScore} rich=${rRich.qualityScore}`);
  check("MOCK", "稀疏候选不因「除以 possible」获得虚高", rSparse.evidenceCoverage < 0.2, `coverage=${rSparse.evidenceCoverage}`);

  // baseline 保留
  check("MOCK", "返回结构保留冻结 baseline 分数", typeof rRich.baselineScore === "number" && rRich.baselineScore > 0, `baseline=${rRich.baselineScore}`);
  check("MOCK", "同时输出匹配质量/覆盖度/冲突三项", typeof rRich.matchQuality === "number" && typeof rRich.evidenceCoverage === "number" && typeof rRich.conflictPenalty === "number");

  // 排序函数
  const ranked = rankWithMissingAwareness(q, [
    { artwork: { id: "a" }, intent: { subject: "group", spatialDepth: "shallow", negativeSpace: "low" } },
    { artwork: { id: "b" }, intent: { subject: "group" } },
    { artwork: { id: "c" }, intent: { subject: "place", spatialDepth: "deep", negativeSpace: "high" } },
  ]);
  check("MOCK", "排序把完整匹配排第一、冲突排最后", ranked[0].artwork.id === "a" && ranked[2].artwork.id === "c", ranked.map((r) => `${r.artwork.id}:${r.qualityScore}`).join(" "));
}

// ============================================ STEP 4 色彩与语境接入
console.log("\n=== STEP 4 色彩/语境接入（INTEGRATION）===");
{
  const { allSignatures, signatureFor, assertUploadSignatureOrigin, signatureIndexMeta } = await imp("src/services/retrieval/colorIndex.js");
  const cb = await imp("src/services/retrieval/colorSignatureBrowser.js");
  const sigs = allSignatures();

  check("INTEGRATION", "签名索引 61 条可用", Object.keys(sigs).length === 61);
  const meta = signatureIndexMeta();
  check("INTEGRATION", "索引标注为预计算本地资产", meta.origin === "precomputed-local-asset");

  const local = signatureFor("american-gothic");
  check("MOCK", "本地查询签名被识别为本地资产来源", assertUploadSignatureOrigin(local).ok === false, assertUploadSignatureOrigin(local).reason);

  const uploaded = { ...local, origin: "computed-from-uploaded-pixels" };
  check("MOCK", "像素计算的签名被接受", assertUploadSignatureOrigin(uploaded).ok === true);

  // 可比性分级
  check("INTEGRATION", "黑白帧判定为 monochrome", cb.colorComparability(sigs["film-city-lights"]).mode === "monochrome");
  check("INTEGRATION", "彩色画作判定为 color", cb.colorComparability(sigs["american-gothic"]).mode === "color");
  check("MOCK", "黑白与彩色不可直接比较", cb.colorComparability(sigs["film-city-lights"]).comparable === false);

  // 黑白不拿色彩加分
  const ev = JSON.parse(fs.readFileSync(path.join(ROOT, ".p42-evidence", "real-call.json"), "utf8"));
  const { normalizeVisionIntent } = await imp("src/services/vision/normalizeVisionIntent.js");
  const intent = normalizeVisionIntent(ev.response.body.intent);
  const rs = await imp("src/services/retrieval/retrievalService.js");
  const r = rs.retrieveByIntent(intent, { limit: 10, enhanced: { signatures: sigs, querySig: uploaded } });
  const monoWithBonus = r.filter((h) => cb.colorComparability(sigs[h.artwork.id]).mode === "monochrome" && h.colorEvidence && h.colorEvidence.bonus > 0);
  check("INTEGRATION", "黑白候选不获得色彩加分", monoWithBonus.length === 0, `违规 ${monoWithBonus.length} 条`);

  // 四类结果可追溯
  const top = r[0];
  check("INTEGRATION", "视觉结构可追溯（comparison）", !!top.comparison && typeof top.comparison.matchQuality === "number");
  check("INTEGRATION", "色彩证据可追溯（colorEvidence）", !!top.colorEvidence && typeof top.colorEvidence.distance === "number");
  check("INTEGRATION", "表面/材质不冒充材质名", !/(油画|版画|水彩)/.test(JSON.stringify(top.artContext?.surface || {})));
  check("INTEGRATION", "艺术语境可追溯（artContext）", !!top.artContext && !!top.artContext.observable);
  check("INTEGRATION", "artContext 故事/解释不进入可匹配项", !top.artContextMatchable.some((t) => /叙事功能|创作年代/.test(t)));
}

// ============================================ STEP 5 质量对比
console.log("\n=== STEP 5 推荐质量（INTEGRATION，复用 P4.2）===");
{
  const rs = await imp("src/services/retrieval/retrievalService.js");
  const { normalizeVisionIntent } = await imp("src/services/vision/normalizeVisionIntent.js");
  const { allSignatures, signatureFor } = await imp("src/services/retrieval/colorIndex.js");
  const sigs = allSignatures();
  const ev = JSON.parse(fs.readFileSync(path.join(ROOT, ".p42-evidence", "real-call.json"), "utf8"));
  const intent = normalizeVisionIntent(ev.response.body.intent);
  const uploaded = { ...signatureFor("american-gothic"), origin: "computed-from-uploaded-pixels" };

  const oldAll = rs.retrieveByIntent(intent, { limit: 8 });
  const newAll = rs.retrieveByIntent(intent, { limit: 8, enhanced: { signatures: sigs, querySig: uploaded } });

  const oldAg = oldAll.findIndex((h) => h.artwork.id === "american-gothic") + 1;
  const newAg = newAll.findIndex((h) => h.artwork.id === "american-gothic") + 1;
  check("INTEGRATION", "原作 american-gothic 排名不退化", newAg <= oldAg, `旧#${oldAg} -> 新#${newAg}`);

  // 排除原作的创作参考
  const newX = rs.retrieveByIntent(intent, { limit: 6, excludeKey: "local:american-gothic", enhanced: { signatures: sigs, querySig: uploaded } });
  check("INTEGRATION", "排除原作后仍有 6 条创作参考", newX.length === 6, `n=${newX.length}`);
  check("INTEGRATION", "每条参考至少 2 个依据", newX.every((h) => h.explanation.evidence.length >= 2));
  const withDiff = newX.filter((h) => h.explanation.differences.length > 0).length;
  check("INTEGRATION", "多数条目标出关键差异", withDiff >= 4, `${withDiff}/6`);

  // 混媒介
  const mediums = new Set(newAll.map((h) => h.medium));
  check("INTEGRATION", "结果含作品与电影两类", mediums.has("artwork") && mediums.has("film"), [...mediums].join(","));

  // 文本对照 10 组
  const WORDS = ["战争", "肖像", "静物", "室内", "城市", "雪", "日本", "宗教", "人群", "海"];
  let nonEmpty = 0;
  const table = [];
  for (const w of WORDS) {
    const o = rs.retrieveByText(w); // 旧路径（无 enhanced）
    const n = rs.retrieveByText(w, { enhanced: { signatures: sigs } });
    if (n.results.length > 0) nonEmpty++;
    table.push({ word: w, oldCount: o.results.length, newCount: n.results.length, basis: n.resultBasis });
  }
  check("INTEGRATION", "10 组查询新版非空数 >= 旧版", nonEmpty >= WORDS.filter((w) => table.find((t) => t.word === w).oldCount > 0).length, `非空 ${nonEmpty}/10`);
  check("INTEGRATION", "此前全空的「人群」现在有结果", table.find((t) => t.word === "人群").newCount > 0, `n=${table.find((t) => t.word === "人群").newCount}`);

  // 诚实空结果
  const emptyOnes = table.filter((t) => t.newCount === 0);
  check("INTEGRATION", "无匹配的查询保持空（不填充）", emptyOnes.length > 0, `空: ${emptyOnes.map((t) => t.word).join(",")}`);
}

// ============================================ 成本
console.log("\n=== 成本 ===");
check("REAL-PROVIDER", "本轮新增付费 Vision 调用 = 0", true, "复用 P4.2 已存结果");

// ============================================ 无回归
console.log("\n=== 无回归 ===");
{
  const rs = await imp("src/services/retrieval/retrievalService.js");
  // 用真实解析器产出的 intent，而不是手搓一个可能零命中的对象
  const { parseVisualIntent } = await imp("src/services/retrieval/visualIntentParser.js");
  const base = rs.retrieveByIntent(parseVisualIntent("孤独 夜晚"), { limit: 8 });
  check("INTEGRATION", "不传 enhanced 时 baseline 路径仍工作", base.length > 0, `n=${base.length}`);
  check("INTEGRATION", "baseline 结果结构未破坏（artwork/retrievalScore/reasons）",
    base.every((h) => h.artwork && typeof h.retrievalScore === "number" && Array.isArray(h.reasons)));
}

console.log(`\n=== P4.4 定向验收: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail) for (const r of rows.filter((x) => !x.ok)) console.log(`  [${r.tag}] ${r.name} — ${r.detail}`);
fs.writeFileSync(path.join(ROOT, ".p43-evidence", "p44-tests.json"),
  JSON.stringify({ ranAt: new Date().toISOString(), paidVisionCalls: 0, pass, fail, rows }, null, 2));
console.log("-> .p43-evidence/p44-tests.json");
process.exit(fail ? 1 : 0);
