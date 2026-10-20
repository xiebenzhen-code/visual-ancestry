// p414-b2-b3.test.mjs — P4.14-B2/B3 媒介分层与候选契约的最小回归
//
// 测的是可被推翻的契约，不是实现细节：
//   1. 旧枚举不许变：交给既有检索链的 medium 只能是 artwork / film
//   2. 动画与真人能区分，且 anime 必须有证据，不能从画风推断
//   3. 影片的 traditions:["电影"] 不能被当成创作传统
//   4. 缺 imageKind 的影片不能当「实际画面」用（堵住用海报冒充镜头）
//   5. 许可不是一个布尔：四问任一 unknown 就只能是 unconfirmed
//   6. 四个状态互斥且由证据推出；未分析的真实馆藏图停在 IMAGE_AVAILABLE，不被永久排除
//   7. 跨来源去重按作品身份，保留信息更全的一条
//
// 进程内运行，不联网、不调 Provider。

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

const tax = await imp("src/services/source/mediaTaxonomy.js");
const cand = await imp("src/services/source/candidate.js");
const artworksData = await imp("src/data/artworks.js");
const filmData = await imp("src/data/filmStills.js");
const svc = await imp("src/services/retrieval/retrievalService.js");

const ARTWORKS = artworksData.artworks || artworksData.default || [];
const FILMS = filmData.filmStills || filmData.default || [];

// ============================================================ B2 媒介分层
console.log("\n=== B2-1 旧枚举与缺省 ==");

check("绘画没有 medium 字段时按 artwork 处理（与 retrievalService.js:245 一致）", () => {
  const wanderer = ARTWORKS.find((a) => a.id === "wanderer");
  assert.equal(wanderer.medium, undefined, "前提：绘画数据确实没有 medium 字段");
  const m = tax.describeMedia(wanderer);
  assert.equal(m.medium, "artwork");
  assert.equal(m.evidence.medium, "medium-default");
});

check("本地影片是 film + live-action，来源标 film-fact", () => {
  const g = FILMS.find((f) => f.id === "film-the-general");
  const m = tax.describeMedia(g);
  assert.equal(m.medium, "film");
  assert.equal(m.visualForm, "live-action");
  assert.equal(m.evidence.visualForm, "film-fact");
});

check("未知影片不会被默认当成真人", () => {
  const m = tax.describeMedia({ id: "film-unknown-future-anime", medium: "film", imageKind: "frame" });
  assert.equal(m.visualForm, "unknown", "没有事实就不许推断");
});

check("assertLegacyMedium 只放行 artwork / film", () => {
  assert.equal(tax.assertLegacyMedium("artwork").ok, true);
  assert.equal(tax.assertLegacyMedium("film").ok, true);
  assert.equal(tax.assertLegacyMedium("animation").ok, false);
  assert.equal(tax.assertLegacyMedium("anime").ok, false);
});

console.log("\n=== B2-2 动画与动漫 ==");

const ANIME_ENTRY = {
  id: "external-anime-001",
  medium: "film",
  visualForm: "animation",
  tradition: "anime",
  imageKind: "frame",
  title: "（测试用，不在产品数据里）",
};

check("动画 + anime 证据 → isAnimation 与 isAnime 同时成立", () => {
  assert.equal(tax.isAnimation(ANIME_ENTRY), true);
  assert.equal(tax.isAnime(ANIME_ENTRY), true);
});

check("只有 anime 传统、没有 animation 形式 → 不算动漫", () => {
  const bad = { id: "x1", medium: "film", tradition: "anime", imageKind: "frame" };
  assert.equal(tax.isAnime(bad), false, "anime 必须同时是动画");
});

check("没有任何证据却像日漫 → 不许判为动漫", () => {
  const noEvidence = { id: "x2", medium: "film", imageKind: "frame" };
  const m = tax.describeMedia(noEvidence);
  assert.equal(m.tradition, null);
  assert.equal(tax.isAnime(noEvidence), false);
});

check("动画与真人可区分（同一 medium 下 visualForm 不同）", () => {
  const live = tax.describeMedia(FILMS.find((f) => f.id === "film-city-lights"));
  const anim = tax.describeMedia(ANIME_ENTRY);
  assert.equal(live.medium, anim.medium, "两者 medium 都是 film");
  assert.notEqual(live.visualForm, anim.visualForm, "visualForm 必须能分开");
});

console.log("\n=== B2-3 tradition 不能同义反复 ===");

check("影片 traditions:['电影'] 不被当成创作传统", () => {
  const g = FILMS.find((f) => f.id === "film-the-general");
  assert.deepEqual(g.traditions, ["电影"], "前提：本地影片确实这么写");
  assert.equal(tax.describeMedia(g).tradition, null, "媒介名不是流派");
});

check("绘画的视觉传统可作为 tradition", () => {
  const w = ARTWORKS.find((a) => a.id === "wanderer");
  assert.equal(tax.describeMedia(w).tradition, "romanticism");
});

console.log("\n=== B2-4 图像性质（堵住海报冒充镜头）===");

check("缺 imageKind 的影片不能当实际画面", () => {
  const m = tax.describeMedia({ id: "film-x", medium: "film" });
  assert.equal(m.imageKind, "unknown");
  assert.equal(tax.isActualScreenImage({ id: "film-x", medium: "film" }), false);
});

check("frame 与 scene-still 算实际画面，publicity / poster 不算", () => {
  assert.equal(tax.isActualScreenImage({ id: "a", medium: "film", imageKind: "frame" }), true);
  assert.equal(tax.isActualScreenImage({ id: "b", medium: "film", imageKind: "scene-still" }), true);
  assert.equal(tax.isActualScreenImage({ id: "c", medium: "film", imageKind: "publicity-photo" }), false);
  assert.equal(tax.isActualScreenImage({ id: "d", medium: "film", imageKind: "poster" }), false);
});

check("绘画默认是作品复制图", () => {
  const m = tax.describeMedia(ARTWORKS.find((a) => a.id === "american-gothic"));
  assert.equal(m.imageKind, "artwork-reproduction");
});

// ============================================================ B3 候选契约
console.log("\n=== B3-1 四个状态由证据推出 ===");

const FULL_RIGHTS = cand.makeRightsEvidence({
  imageSourceClear: true,
  workRightsClear: true,
  displayAllowed: true,
  cacheRedistributionAllowed: true,
  decidedBy: "provider-field",
  obtainedAt: "runtime",
  fields: [{ field: "is_public_domain", value: true }],
});

const VISUAL = cand.makeVisualEvidence({
  intent: { subject: "group", spatialDepth: "deep" },
  signature: { ok: true, origin: "precomputed-local-asset" },
});

function mk(over = {}) {
  return cand.toSourceCandidate({
    stableId: "t-1",
    sourceProvider: "test",
    medium: "film",
    visualForm: "live-action",
    imageKind: "frame",
    imageURL: "https://example.org/a.jpg",
    imageVerification: { verified: true, format: "jpeg", width: 800, height: 600, bytes: 12345 },
    rights: FULL_RIGHTS,
    visual: VISUAL,
    ...over,
  });
}

check("无图 → METADATA_ONLY", () => {
  const r = mk({ imageURL: null });
  assert.equal(r.state, cand.CANDIDATE_STATE.METADATA_ONLY);
});

check("有图无视觉 → IMAGE_AVAILABLE（不被永久排除）", () => {
  const r = mk({ visual: cand.makeVisualEvidence({}) });
  assert.equal(r.state, cand.CANDIDATE_STATE.IMAGE_AVAILABLE);
  assert.equal(cand.isRecommendable(r.candidate), false, "但还不能推荐");
});

check("有视觉但许可未确认 → VISUAL_ANALYZED", () => {
  const r = mk({ rights: cand.unknownRights() });
  assert.equal(r.state, cand.CANDIDATE_STATE.VISUAL_ANALYZED);
});

check("全部满足 → RECOMMENDABLE", () => {
  const r = mk();
  assert.equal(r.state, cand.CANDIDATE_STATE.RECOMMENDABLE);
  assert.equal(cand.isRecommendable(r.candidate), true);
});

console.log("\n=== B3-2 许可不是一个布尔 ===");

check("四问全 yes 才是 confirmed", () => {
  assert.equal(FULL_RIGHTS.verdict, "confirmed");
});

check("任一 unknown → unconfirmed（不默认放行，也不写成 denied）", () => {
  const partial = cand.makeRightsEvidence({
    imageSourceClear: true,
    workRightsClear: true,
    displayAllowed: true,
    cacheRedistributionAllowed: null,
  });
  assert.equal(partial.verdict, "unconfirmed");
  assert.equal(partial.cacheRedistributionAllowed, "unknown");
});

check("任一 no → denied，且优先于 unknown", () => {
  const mixed = cand.makeRightsEvidence({
    imageSourceClear: true,
    workRightsClear: true,
    displayAllowed: false,
    cacheRedistributionAllowed: null,
  });
  assert.equal(mixed.verdict, "denied");
});

check("unknownRights 明确表达不知道，而不是 false", () => {
  const u = cand.unknownRights();
  assert.equal(u.verdict, "unconfirmed");
  assert.equal(u.decidedBy, "none");
  assert.equal(u.displayAllowed, "unknown");
});

console.log("\n=== B3-2b 图像验证（HTTP 200 不算证据）===");

check("明确解码失败 → 退回 METADATA_ONLY，不是「有图待分析」", () => {
  const r = mk({ imageVerification: { verified: false, reason: "HTTP 403" } });
  assert.equal(r.state, cand.CANDIDATE_STATE.METADATA_ONLY);
  assert.equal(r.candidate.imageStatus, "failed");
  assert.equal(cand.isRecommendable(r.candidate), false);
});

check("未验证的图像可以列出，但不得进入推荐", () => {
  // 无视觉特征 + 图像未验证 → 仍属「有图待分析」
  const bare = mk({ imageVerification: null, visual: cand.makeVisualEvidence({}) });
  assert.equal(bare.state, cand.CANDIDATE_STATE.IMAGE_AVAILABLE, "未验证不等于失败");
  assert.equal(bare.candidate.imageStatus, "unverified");

  // 有视觉特征但图像未验证 → 只能到 VISUAL_ANALYZED，不得推荐
  const analyzed = mk({ imageVerification: null });
  assert.equal(analyzed.state, cand.CANDIDATE_STATE.VISUAL_ANALYZED);
  assert.equal(cand.isRecommendable(analyzed.candidate), false, "没解码过就不许推荐");
});

check("已验证的图像带格式与尺寸", () => {
  const r = mk();
  assert.equal(r.candidate.imageStatus, "decoded");
  assert.equal(r.candidate.imageVerification.format, "jpeg");
  assert.equal(r.candidate.imageVerification.width, 800);
});

console.log("\n=== B3-3 政策与去重 ===");

check("海报即使有图有许可也不可推荐", () => {
  const r = mk({ imageKind: "poster" });
  assert.equal(cand.isRecommendable(r.candidate), false);
});

check("黑白排除优先于一切：有图有许可有视觉也不可推荐", () => {
  const r = mk({ blackAndWhiteExcluded: true });
  assert.equal(cand.isRecommendable(r.candidate), false);
});

check("缺 stableId / sourceProvider 直接报错，不产出半成品", () => {
  assert.equal(cand.toSourceCandidate({ sourceProvider: "x" }).error, "missing-stable-id");
  assert.equal(cand.toSourceCandidate({ stableId: "x" }).error, "missing-source-provider");
  assert.equal(cand.toSourceCandidate(null).error, "not-an-object");
});

check("去重按作品身份，保留信息更全的一条", () => {
  const thin = {
    stableId: "p1",
    sourceProvider: "local",
    originalWork: { title: "American Gothic", creator: "Grant Wood", year: 1930 },
    imageURL: "https://example.org/a.jpg",
    rights: cand.unknownRights(),
    visual: cand.makeVisualEvidence({}),
  };
  const rich = { ...thin, stableId: "p2", sourceProvider: "met", rights: FULL_RIGHTS, visual: VISUAL };
  const a = cand.toSourceCandidate(thin).candidate;
  const b = cand.toSourceCandidate(rich).candidate;
  const out = cand.dedupeCandidates([a, b]);
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].stableId, "p2", "应保留可推荐的那条");
  assert.equal(out.dropped.length, 1);
});

check("没有标题时退化为 provider+stableId，不会误合并", () => {
  const k1 = cand.dedupeKey({ sourceProvider: "a", stableId: "1", originalWork: null });
  const k2 = cand.dedupeKey({ sourceProvider: "b", stableId: "1", originalWork: null });
  assert.notEqual(k1, k2);
});

// ============================================================ 只读核验真实数据
console.log("\n=== 真实记录桥接（不改数据）===");

check("46 件绘画桥接后全部可判定，且 medium 仍为 artwork", () => {
  const withImage = ARTWORKS.filter((a) => a.image && !a.imageUnavailable);
  assert.ok(withImage.length >= 46, `实际 ${withImage.length}`);
  for (const a of withImage) {
    const r = cand.bridgeLocalRecord(a, {
      imageURL: `https://example.org/${a.id}.webp`,
      rights: FULL_RIGHTS,
      intent: a.visualIntent,
    });
    assert.equal(r.ok, true, `${a.id} 桥接失败`);
    assert.equal(r.candidate.medium, "artwork");
    assert.equal(tax.assertLegacyMedium(r.candidate.medium).ok, true);
  }
});

check("15 部影片桥接后 visualForm 全部为 live-action", () => {
  for (const f of FILMS) {
    const r = cand.bridgeLocalRecord(f, { imageURL: "https://example.org/x.jpg", rights: FULL_RIGHTS });
    assert.equal(r.ok, true, `${f.id} 桥接失败`);
    assert.equal(r.candidate.medium, "film");
    assert.equal(r.candidate.visualForm, "live-action", `${f.id} 形式不对`);
  }
});

check("P4.12 黑白排除仍有效：影片池仍只留 1 部彩色片", () => {
  const pool = svc.filmStillPool();
  assert.equal(pool.length, 1);
  assert.equal(pool[0].id, "film-toll-of-the-sea");
  assert.equal(svc.excludedFilmCandidates().length, 14);
});

// ============================================================ 汇总
console.log(`\n=== P4.14-B2/B3 回归: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
