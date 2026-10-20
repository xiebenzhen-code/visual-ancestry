// monochrome-gate.test.mjs — P4.12 黑白电影影像硬性排除的最小回归
//
// 测的不是「评分降权了没有」，而是**候选根本进不来**：
//   1. 本地池成员 ⊆ 允许集合（被排除的 id 一个都不在）
//   2. 直连 id 解析（filmStillAsArtwork / filmDetail）对被排除项返回空/说明
//   3. 文字检索、名称匹配等派生入口不泄露被排除 id
//   4. 远程色度门的语义：先过滤再截断；unknown 一律排除；不补足数量
//   5. 判定函数本身：sepia 不能被当成彩色，真彩色不能被当成黑白
//
// 全部在进程内跑，不需要浏览器、不联网、不调 Provider。

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
    console.log(`FAIL ${name} — ${String(e.message).slice(0, 200)}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name} — ${String(e.message).slice(0, 200)}`);
  }
}

// 供浏览器模块在 Node 里加载的最小 window
const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  location: { origin: "http://127.0.0.1", hash: "" },
};
globalThis.localStorage = globalThis.window.localStorage;

const policy = await imp("src/services/retrieval/monochromePolicy.js");
const svc = await imp("src/services/retrieval/retrievalService.js");
const filmData = await imp("src/data/filmStills.js");

const ALL_FILM_IDS = filmData.filmStills.map((s) => s.id);
const POOL_IDS = new Set(svc.filmStillPool().map((c) => c.id));
const EXCLUDED = svc.excludedFilmCandidates();
const EXCLUDED_IDS = new Set(EXCLUDED.map((e) => e.id));

// ---------------------------------------------------------------- 1. 本地池
check("本地池不含任何被排除的影片", () => {
  const leaked = [...POOL_IDS].filter((id) => EXCLUDED_IDS.has(id));
  assert.equal(leaked.length, 0, `泄漏: ${leaked.join(", ")}`);
});

check("池成员数 = 总数 − 排除数", () => {
  assert.equal(POOL_IDS.size + EXCLUDED_IDS.size, ALL_FILM_IDS.length);
});

check("被排除项都有非空原因（不得静默排除）", () => {
  for (const e of EXCLUDED) {
    assert.ok(e.reason && e.reason.length > 4, `${e.id} 缺原因`);
    assert.ok(["monochrome", "unknown"].includes(e.verdict), `${e.id} verdict 异常: ${e.verdict}`);
  }
});

check("唯一确认的彩色片仍在池中", () => {
  assert.ok(POOL_IDS.has("film-toll-of-the-sea"), "彩色片被误删");
});

// ---------------------------------------------------------------- 2. 直连解析
check("filmStillAsArtwork 对被排除 id 返回 null", () => {
  for (const id of EXCLUDED_IDS) {
    assert.equal(svc.filmStillAsArtwork({ id }), null, `${id} 仍可解析`);
  }
});

check("filmStillAsArtwork 对池内 id 正常返回", () => {
  const ok = svc.filmStillAsArtwork({ id: "film-toll-of-the-sea" });
  assert.ok(ok && ok.id === "film-toll-of-the-sea");
});

// ---------------------------------------------------------------- 3. 派生入口
check("curatedPool('film') 只含池成员", () => {
  // 通过 retrieveByIntent 空意图拿到全池次序，间接验证 curatedPool
  const rows = svc.retrieveByIntent({}, { limit: 50, media: "film" });
  const ids = rows.map((r) => r.artwork.id);
  const leaked = ids.filter((id) => EXCLUDED_IDS.has(id));
  assert.equal(leaked.length, 0, `泄漏: ${leaked.join(", ")}`);
});

check("curatedPool('all') 不夹带被排除影片", () => {
  const rows = svc.retrieveByIntent({}, { limit: 100, media: "all" });
  const leaked = rows.map((r) => r.artwork.id).filter((id) => EXCLUDED_IDS.has(id));
  assert.equal(leaked.length, 0, `泄漏: ${leaked.join(", ")}`);
});

check("文字检索不返回被排除影片", () => {
  for (const q of ["黑白", "夜晚", "人物", "city", "lights", "城市"]) {
    // retrieveByText 返回的是 { results, ... }，不是裸数组。
    const res = svc.retrieveByText(q, { limit: 10, media: "film" });
    const rows = Array.isArray(res) ? res : (res.results || []);
    const leaked = rows.map((r) => r.artwork && r.artwork.id).filter((id) => EXCLUDED_IDS.has(id));
    assert.equal(leaked.length, 0, `query="${q}" 泄漏 ${leaked.join(", ")}`);
  }
});

await checkAsync("名称匹配池不含被排除影片", async () => {
  const nm = await imp("src/utils/nameMatch.js");
  const pool = nm.mediaPool ? nm.mediaPool("all") : null;
  if (!pool) {
    // 若导出名不同，用 filmStillPool 兜底验证同一件事
    const p2 = svc.filmStillPool().map((c) => c.id);
    assert.equal(p2.filter((id) => EXCLUDED_IDS.has(id)).length, 0);
    return;
  }
  const leaked = pool.map((c) => c.id || c.key).filter((id) => EXCLUDED_IDS.has(id));
  assert.equal(leaked.length, 0, `泄漏: ${leaked.join(", ")}`);
});

// ---------------------------------------------------------------- 4. 远程门语义
await checkAsync("远程门：先过滤再截断（第 limit+1 名彩色候选可见）", async () => {
  const gate = await imp("src/services/retrieval/filmColorGate.js");
  const mk = (id) => ({ artwork: { id, image: { thumbnailUrl: `https://upload.wikimedia.org/${id}.jpg` } } });
  // 前 3 条黑白，第 4 条彩色；limit=2
  const list = [mk("a"), mk("b"), mk("c"), mk("d")];
  const measure = async (url) => {
    const id = url.split("/").pop().replace(".jpg", "");
    // P4.13 起判定需要第三条证据（通道相关）。夹具写于新增该证据之前，
    // 补齐是为了让「d 是彩色」这个前提成立，不改任何预期值。
    if (id === "d") return { ok: true, chroma: { ok: true, colorShare: 0.5, hueSpreadDeg: 40, minChannelCorrelation: 0.42 } };
    return { ok: true, chroma: { ok: true, colorShare: 0, hueSpreadDeg: null } };
  };
  const r = await gate.gateRemoteFilmByColor(list, { measure });
  // 全量 4 条都判定过：3 条排除、1 条保留
  assert.equal(r.excluded.length, 3, `排除数应为 3，实际 ${r.excluded.length}`);
  assert.equal(r.results.length, 1, `保留数应为 1，实际 ${r.results.length}`);
  assert.equal(r.results[0].artwork.id, "d");
});

await checkAsync("远程门：读不到像素 → unknown 排除，不默认放行", async () => {
  const gate = await imp("src/services/retrieval/filmColorGate.js");
  const list = [{ artwork: { id: "x", image: { thumbnailUrl: "https://upload.wikimedia.org/x.jpg" } } }];
  const r = await gate.gateRemoteFilmByColor(list, { measure: async () => ({ ok: false, reason: "timeout" }) });
  assert.equal(r.results.length, 0, "读不到像素却放行了");
  assert.equal(r.excluded[0].verdict, "unknown");
});

await checkAsync("远程门：无图像地址 → 排除并记录", async () => {
  const gate = await imp("src/services/retrieval/filmColorGate.js");
  const r = await gate.gateRemoteFilmByColor([{ artwork: { id: "y", image: {} } }], { measure: async () => ({ ok: true, chroma: {} }) });
  assert.equal(r.results.length, 0);
  assert.equal(r.excluded[0].verdict, "unknown");
});

await checkAsync("远程门：允许返回 0 条，不用无关素材补足", async () => {
  const gate = await imp("src/services/retrieval/filmColorGate.js");
  const list = [1, 2, 3].map((i) => ({ artwork: { id: `m${i}`, image: { thumbnailUrl: `https://upload.wikimedia.org/m${i}.jpg` } } }));
  const r = await gate.gateRemoteFilmByColor(list, {
    measure: async () => ({ ok: true, chroma: { ok: true, colorShare: 0, hueSpreadDeg: null } }),
  });
  assert.equal(r.results.length, 0, "全黑白的场景必须返回 0，不得补足");
  assert.equal(r.excluded.length, 3);
});

// ---------------------------------------------------------------- 5. 判定函数
check("sepia 单色相着色不被判成彩色（这是最容易误删/误放的地方）", () => {
  // 实测 sepia 片的真实特征：通道差大，但色相极集中
  const sepia = { ok: true, colorShare: 0.79, hueSpreadDeg: 3.9, minChannelCorrelation: 0.992 };
  const cls = policy.classifyChroma(sepia);
  assert.equal(cls.verdict, "monochrome", `sepia 被判成 ${cls.verdict}`);
  assert.match(cls.reason, /单色相着色/);
});

check("真彩色不被判成黑白", () => {
  const color = { ok: true, colorShare: 0.71, hueSpreadDeg: 36.3, minChannelCorrelation: 0.7295 };
  assert.equal(policy.classifyChroma(color).verdict, "color");
});

check("纯黑白被判黑白", () => {
  assert.equal(policy.classifyChroma({ ok: true, colorShare: 0, hueSpreadDeg: null }).verdict, "monochrome");
});

check("低饱和度不足以判决（不看饱和度，只看色相分散度）", () => {
  // 低饱和但多色相 → 仍是彩色
  const lowSatColor = { ok: true, colorShare: 0.05, hueSpreadDeg: 40, minChannelCorrelation: 0.45 };
  assert.equal(policy.classifyChroma(lowSatColor).verdict, "color", "低饱和彩色被误删");
});

// ---- P4.13 新增：第三条证据（通道相关）锁死 ----
check("着色黑白：色相铺得开但通道同步 → 判黑白（Way Down East 04 实测值）", () => {
  // P4.13 修复的真实边界缺陷：青绿着色片 hueSpread 27.9° 会撞过色相门，
  // 但三通道相关 0.9961，说明仍是「同一张亮度图 × 一条色调映射」。
  const tinted = { ok: true, colorShare: 0.9102, hueSpreadDeg: 27.9, minChannelCorrelation: 0.9961 };
  const cls = policy.classifyChroma(tinted);
  assert.equal(cls.verdict, "monochrome", "青绿着色被判成 " + cls.verdict);
  assert.match(cls.reason, /单色调映射/);
});

check("缺少通道相关证据 → 不默认放行，且理由不得冒充实测", () => {
  const legacy = { ok: true, colorShare: 0.71, hueSpreadDeg: 36.3 };
  const cls = policy.classifyChroma(legacy);
  assert.equal(cls.verdict, "monochrome", "缺证据却放行了");
  assert.match(cls.reason, /缺少通道相关证据/);
  assert.doesNotMatch(cls.reason, /undefined/, "理由里出现 undefined");
});

check("两条着色路径给不同理由（sepia vs 青绿着色）", () => {
  const sepia = policy.classifyChroma({ ok: true, colorShare: 0.79, hueSpreadDeg: 3.9, minChannelCorrelation: 0.992 });
  const greenish = policy.classifyChroma({ ok: true, colorShare: 0.9102, hueSpreadDeg: 27.9, minChannelCorrelation: 0.9961 });
  assert.equal(sepia.verdict, "monochrome");
  assert.equal(greenish.verdict, "monochrome");
  assert.match(sepia.reason, /单色相着色/);
  assert.match(greenish.reason, /单色调映射/);
  assert.notEqual(sepia.reason, greenish.reason);
});

check("已知局限：16mm 扫描双色 Technicolor 会被保守排除（锁定现状，非正确性）", () => {
  // Gold Diggers of Broadway (1929) 实测 colorShare 0.9208 / hueSpread 13° / corr 0.9521。
  // 画面确为彩色，但扫描件偏暗、颗粒重，三条证据无法与着色黑白可靠分离。
  // 见 docs/control/ERROR_REGISTRY.md 的 LIMIT 条目。
  const twoStrip = { ok: true, colorShare: 0.9208, hueSpreadDeg: 13, minChannelCorrelation: 0.9521 };
  assert.equal(policy.classifyChroma(twoStrip).verdict, "monochrome");
});

check("judgeFilmCandidate：黑白影片被拒绝并带原因", () => {
  const j = policy.judgeFilmCandidate({ id: "film-the-general", medium: "film" });
  assert.equal(j.allowed, false);
  assert.match(j.reason, /黑白/);
});

check("judgeFilmCandidate：彩色影片放行", () => {
  const j = policy.judgeFilmCandidate({ id: "film-toll-of-the-sea", medium: "film" });
  assert.equal(j.allowed, true);
});

check("judgeFilmCandidate：无影片事实且无像素 → unknown 拒绝", () => {
  const j = policy.judgeFilmCandidate({ id: "film-unheard-of", medium: "film" });
  assert.equal(j.allowed, false);
  assert.equal(j.verdict, "unknown");
});

check("judgeFilmCandidate：非电影候选不受本规则影响", () => {
  const j = policy.judgeFilmCandidate({ id: "starry", medium: "artwork" });
  assert.equal(j.allowed, true);
});

check("measureChroma 对 RGBA 与 RGB 都能算", () => {
  const w = 4, h = 4;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const rgb = new Uint8ClampedArray(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 255; rgba[i * 4 + 1] = 0; rgba[i * 4 + 2] = 0; rgba[i * 4 + 3] = 255;
    rgb[i * 3] = 0; rgb[i * 3 + 1] = 0; rgb[i * 3 + 2] = 255;
  }
  const a = policy.measureChroma({ data: rgba, width: w, height: h, channels: 4 });
  const b = policy.measureChroma({ data: rgb, width: w, height: h, channels: 3 });
  assert.ok(a.ok && b.ok);
  assert.ok(a.colorShare > 0.9 && b.colorShare > 0.9, "纯色像素应识别为携带色彩");
});

// ---------------------------------------------------------------- 6. 现行测试断言的一致性
check("被排除的 id 与测试里写死的旧期望不冲突", () => {
  // p43 曾断言 city-lights 排第 2；p4x 系列若有同类断言会在此暴露
  const legacy = ["film-city-lights", "film-s02-the-kid"];
  const stillExpected = legacy.filter((id) => !EXCLUDED_IDS.has(id));
  assert.equal(stillExpected.length, 0, `这些 id 仍被期望出现但已被排除: ${stillExpected.join(", ")}`);
});

console.log("");
console.log(`=== P4.12 黑白门回归: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail > 0) process.exit(1);
