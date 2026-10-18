// film-discovery-check.mjs — STEP 5 最小验证：动态电影发现的真实浏览器验收。
//
// 用法: node qa/ui/film-discovery-check.mjs <baseUrl> [label]
//
// 两类查询（任务书指定）：
//   A. 已知片名「Intolerance」→ 验证来源、电影身份、图像性质
//   B. 视觉描述「冷色 孤独 空旷街道」→ 验证动态召回能力 + 是否存在真实图像分析证据
//
// 只报告实测到的：候选数、真实解码数、身份核验、许可、图像分析覆盖率、失败原因。
// 判定「显示出来」与「解码成功」用两套口径（getClientRects / naturalWidth），
// 不用 textContent —— 隐藏占位的文字也在 textContent 里。
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:5173";
const LABEL = process.argv[3] || "film-discovery";
const OUT = join(HERE, "film-discovery-shots", LABEL);
const PORT = 9477;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];
const skips = [];
// skipIf：外部依赖当次不可用时**跳过**而不是 FAIL —— 但必须给出可核查的
// 理由（如 Wikidata 本次全部传输失败），不能是「跑不通就算过」。
// 实测踩过：Wikidata 会间歇性 429，把这种网络抖动算成「产品没核实身份」
// 是冤枉产品；反过来把它无条件放过，就是把失败藏起来。
//
// 参数必须是 { condition, skipWhen, reason, detail }：
// 不给 condition 就默认通过的话，这条断言就变成永远为真的空断言，
// 那正是本项目已经踩过一次（preflight 缺失导致 0===0 也算过）的坑。
const skipIf = (name, { condition = true, skipWhen = false, reason = "", detail = "" }) => {
  if (skipWhen) {
    skip++;
    skips.push({ name, reason });
    console.log(`  SKIP ${name} — ${reason}`);
    return;
  }
  check(name, condition, detail);
};
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    failures.push({ name, detail: String(detail).slice(0, 300) });
    console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`);
  }
};

const jsErrors = [];

async function connect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("ws"));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      return;
    }
    if (onEvent) onEvent(m);
  };
  return {
    ws,
    send: (method, params = {}) =>
      new Promise((r) => {
        const mid = ++id;
        pending.set(mid, r);
        ws.send(JSON.stringify({ id: mid, method, params }));
      }),
  };
}

const edge = spawn(EDGE, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(HERE, "film-discovery-profile")}`,
  "--no-first-run",
  "about:blank",
], { stdio: "ignore" });

let version = null;
for (let i = 0; i < 40; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    break;
  } catch {
    /* 等 CDP 就绪 */
  }
  await sleep(600);
}
if (!version) {
  edge.kill();
  throw new Error("CDP 未就绪");
}
const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const page = await connect(created.webSocketDebuggerUrl, (m) => {
  if (m.method === "Runtime.exceptionThrown") jsErrors.push(m.params?.exceptionDetails?.text || "?");
});
const call = page.send;
const evalJs = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
// 截图必须**滚到证据所在处**再拍。否则拍到的是页面顶部（输入框），
// 截图就无法作为「电影候选卡长什么样」的证据。
const shot = async (name) => {
  await evalJs(`(() => {
    const target = document.querySelector('.find-remote') || document.querySelector('#find-remote');
    if (target) target.scrollIntoView({ block: 'start' });
    return 1;
  })()`);
  await sleep(600);
  const r = await call("Page.captureScreenshot", { format: "png" });
  if (r.result?.data) writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, "base64"));
  await evalJs("window.scrollTo(0, 0)");
};
const setViewport = (w, h) =>
  call("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });

await setViewport(1440, 900);
await call("Page.enable");
await call("Page.navigate", { url: `${BASE}/#find` });
await sleep(2500);

// 前置检查：模块加载失败时 FIND 视图会整体为空（实测踩过一次：某个 import 路径写错
// → 动态 import 失败 → 页面渲染中断 → 后面所有「按卡片计数」的断言都会因为 0===0
// 而假通过）。所以先确认输入控件存在，否则直接判失败并退出。
const preflight = await evalJs(`(() => ({
  text: Boolean(document.querySelector('#find-text')),
  run: Boolean(document.querySelector('#find-run')),
  remoteHost: Boolean(document.querySelector('#find-remote')),
  mediaButtons: [...document.querySelectorAll('[data-find-media]')].map(b => b.dataset.findMedia),
  bodyLen: document.body.innerText.length,
}))()`);
check("FIND 视图正常挂载（模块图无加载失败）", preflight.text && preflight.run && preflight.remoteHost, JSON.stringify(preflight));

// 清掉运行时缓存再验：发现结果缓存 24h、身份核实缓存 7 天。带着上一轮的缓存跑
// 验收，等于测的是旧数据 —— 实测踩过一次（浏览器 profile 复用导致 12ms 返回旧结果）。
const cleared = await evalJs(`(() => {
  // 发现结果缓存在 localStorage（24h）、身份核实在 sessionStorage（7 天）——
  // 实测两个存储都要清，只清一个会带着上一轮的旧数据做验收。
  const localKeys = Object.keys(localStorage).filter(k => k.startsWith("va-"));
  const sessionKeys = Object.keys(sessionStorage).filter(k => k.startsWith("va-"));
  localKeys.forEach(k => localStorage.removeItem(k));
  sessionKeys.forEach(k => sessionStorage.removeItem(k));
  return { localKeys, sessionKeys };
})()`);
console.log(`  已清运行时缓存：localStorage ${cleared.localKeys.length} 项 / sessionStorage ${cleared.sessionKeys.length} 项`);
if (!preflight.text || !preflight.run) {
  console.log("\n前置检查失败：FIND 视图未挂载，后续断言会全部假通过。已中止。");
  writeFileSync(join(OUT, "film-discovery-check.json"), JSON.stringify({ base: BASE, at: new Date().toISOString(), preflight, pass, fail, skip, failures, skips }, null, 2));
  try {
    await call("Browser.close");
  } catch {
    /* 忽略 */
  }
  edge.kill();
  process.exit(1);
}

// 跑一次文字检索：切到「仅电影画面」，填查询词，执行。
const runQuery = async (query) => {
  await evalJs(`(() => {
    const media = document.querySelector('[data-find-media="film"]');
    if (media && !media.classList.contains('is-on')) media.click();
    const t = document.querySelector('#find-text');
    t.value = ${JSON.stringify(query)};
    document.querySelector('#find-run').click();
    return 1;
  })()`);
  // 远程渠道是异步的。等「加载态消失」，而不是等任意 quiet-note ——
  // 「正在检索远程渠道…」本身就是一个 .quiet-note，用它当就绪条件会在
  // 结果回来之前就判定完成（实测踩过一次：卡片 0 张，全部断言假通过）。
  for (let i = 0; i < 80; i++) {
    const ready = await evalJs(`(() => {
      const host = document.querySelector('#find-remote');
      if (!host) return false;
      const txt = host.textContent.replace(/\\s+/g, ' ');
      if (/正在检索/.test(txt)) return false;
      return Boolean(host.querySelector('.find-hit-film') || txt.trim().length > 0);
    })()`);
    if (ready) break;
    await sleep(500);
  }
  await sleep(1200);
  // 卡片图是 lazy 的：渐进滚动一次再判定解码。
  await evalJs(`(async () => {
    for (let y = 0; y <= document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 90)); }
    window.scrollTo(0, 0);
    return 1;
  })()`);
  // 等图片**落地**再量解码率。
  //
  // MEASURED：远程渠道并发取 6 张时，upload/thimedia 有几张会挂着（20 秒后仍
  // complete=false），同一批 URL 逐个取则全部 200。也就是说「还没加载完」和
  // 「加载不了」是两件事。固定 sleep 后立刻量解码率，会把前者算成后者 ——
  // 那不是解码能力的数字，只是我手快手慢的数字。所以这里轮询到全部图片完成
  // （含被回退链换档、被标记 is-broken 的情形）为止。
  //
  // 上限 120s：产品侧首档预算 25s、换档后 9s、最多两次换档，单张最坏约 43s。
  // 上限必须比它宽，否则测量窗口本身就成了失败原因。
  const settled = await evalJs(`(async () => {
    const deadline = Date.now() + 120000;
    const state = () => {
      const imgs = [...document.querySelectorAll('#find-remote .find-hit-film img')];
      const broken = document.querySelectorAll('#find-remote .find-hit-film .img-slot.is-broken').length;
      return { total: imgs.length, loading: imgs.filter(i => !i.complete).length, broken };
    };
    for (;;) {
      const s = state();
      if (Date.now() > deadline) return { ...s, settled: false };
      if (s.total > 0 && s.loading === 0) return { ...s, settled: true };
      await new Promise(r => setTimeout(r, 500));
    }
  })()`);
  console.log(
    `  图片落地：total=${settled.total} 仍在加载=${settled.loading} 已放弃=${settled.broken} settled=${settled.settled}`
  );
};

const measure = () =>
  evalJs(`(() => {
    const host = document.querySelector('#find-remote');
    const cards = [...(host ? host.querySelectorAll('.find-hit-film') : [])];
    const noteText = host ? host.textContent.replace(/\\s+/g, ' ') : '';
    const visibleUnavailable = [...document.querySelectorAll('#find-remote .img-unavailable')].filter(s => s.getClientRects().length).length;
    return {
      cards: cards.length,
      decoded: cards.filter(c => { const i = c.querySelector('img'); return i && i.naturalWidth > 0; }).length,
      broken: cards.filter(c => { const s = c.querySelector('.img-slot'); return s && s.classList.contains('is-broken'); }).length,
      visibleUnavailable,
      withImageKind: cards.filter(c => /图像性质/.test(c.textContent)).length,
      withAxes: cards.filter(c => c.querySelectorAll('.find-remote-axes li').length >= 3).length,
      withActions: cards.filter(c => c.querySelectorAll('[data-film-action]').length === 3 && c.querySelector('a[href^="https://commons"]')).length,
      saysNoVision: cards.filter(c => /未做图像分析|没有做任何图像分析|未配置模型/.test(c.textContent)).length,
      // STEP 2：视觉验证状态。pendingVision = 「待视觉核验」；visualMatched 是**不该出现**
      // 的说法，一旦页面里出现这句话，这条断言就要失败。
      pendingVision: cards.filter(c => /待视觉核验|未验证/.test(c.textContent)).length,
      visualMatched: cards.filter(c => /已视觉匹配|视觉匹配成功/.test(c.textContent)).length,
      recallBasisShown: cards.filter(c => /召回依据/.test(c.textContent)).length,
      verifiedBadges: cards.filter(c => /已核验/.test(c.textContent)).length,
      directors: cards.map(c => (c.querySelector('strong') || {}).textContent || ''),
      titles: cards.map(c => c.dataset.filmTitle + (c.dataset.filmYear ? ' · ' + c.dataset.filmYear : '')),
      sourceIds: cards.map(c => c.dataset.filmSource || ''),
      natureLabels: cards.map(c => (c.querySelector('.find-remote-nature') || {}).textContent?.replace(/\\s+/g, ' ').trim() || ''),
      wikidataLinks: cards.filter(c => c.querySelector('a[href*="wikidata.org"]')).length,
      note: noteText.slice(0, 400),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);

const report = { base: BASE, at: new Date().toISOString(), queries: {} };

// ---------------------------------------------------------------- 查询 A
console.log("\n===================== A · 已知片名「Intolerance」");
await runQuery("Intolerance");
const a = await measure();
report.queries.A = a;
console.log(`  candidates=${a.cards} decoded=${a.decoded} broken=${a.broken}`);
console.log(`  titles=${JSON.stringify(a.titles)}`);
console.log(`  directors=${JSON.stringify(a.directors)}`);
console.log(`  nature=${JSON.stringify(a.natureLabels)}`);
check("A 返回电影候选", a.cards > 0, JSON.stringify({ cards: a.cards, note: a.note.slice(0, 160) }));
// 召回数与展示数必须对得上。实测踩过：电影候选缺 artwork.key，跨渠道去重把
// 5 件压成 1 件，而摘要还在报「→5 件」—— 两处数字互相矛盾，却没有断言拦它。
const aRecalled = Number((a.note.match(/→(\d+) 件/) || [])[1] || 0);
check(
  "A 召回数与展示卡片数一致（缺去重键曾把 5 件压成 1 件）",
  aRecalled > 0 && a.cards === Math.min(aRecalled, 6),
  JSON.stringify({ recalled: aRecalled, cards: a.cards })
);
check(
  "A 卡片之间无重复来源（同一张图不重复计数）",
  a.sourceIds.length === new Set(a.sourceIds).size && a.sourceIds.every(Boolean),
  JSON.stringify(a.sourceIds)
);
// 以下每条都要求 cards > 0：0===0 的空断言等于什么都没验（实测踩过一次）。
check("A 候选图片真实解码（DOM 存在 ≠ 解码成功）", a.cards > 0 && a.decoded === a.cards, JSON.stringify({ cards: a.cards, decoded: a.decoded }));
check("A 无解码失败 / 无可见占位", a.cards > 0 && a.broken === 0 && a.visibleUnavailable === 0, JSON.stringify({ cards: a.cards, broken: a.broken, placeholders: a.visibleUnavailable }));
check("A 每张都标注图像性质", a.cards > 0 && a.withImageKind === a.cards, JSON.stringify({ withKind: a.withImageKind, cards: a.cards }));
check("A 每张都有三条核验轴（身份/性质/许可）", a.cards > 0 && a.withAxes === a.cards, JSON.stringify({ withAxes: a.withAxes, cards: a.cards }));
check("A 每张都有四个动作（选参考/核对来源/标记有误/排除）", a.cards > 0 && a.withActions === a.cards, JSON.stringify({ withActions: a.withActions, cards: a.cards }));
check("A 明示未做图像分析（不伪装视觉匹配）", a.cards > 0 && a.saysNoVision === a.cards, JSON.stringify({ saysNoVision: a.saysNoVision, cards: a.cards }));
// 身份轴的要求不是「全部核实」——那既做不到也不该假装做到。
// 要求是两件事：至少一件真被 Wikidata 具名核实（可点复核），
// 且**每一件**都明确标出自己的身份核验状态（已核验/部分核验/未核验）。
// 「全都核实过」当成通过条件，等于把运气当验收标准。
const aTransportFail = Number((a.note.match(/身份传输失败\s*(\d+)/) || [])[1] || 0);
skipIf("A 身份被具名核实（Wikidata 可点复核）", {
  condition: a.cards > 0 && a.wikidataLinks >= 1,
  skipWhen: a.cards > 0 && a.wikidataLinks < 1 && aTransportFail > 0,
  reason: `Wikidata 本次 ${aTransportFail} 次身份查询全部传输失败（429/超时），本轮无法判定核实能力；界面按「未核实」如实显示`,
  detail: JSON.stringify({ wikidata: a.wikidataLinks, cards: a.cards, transportFailed: aTransportFail }),
});
check(
  "A 每件候选都明确标出身份核验状态（核实或未核实都要写明）",
  a.cards > 0 && a.withAxes === a.cards,
  JSON.stringify({ withAxes: a.withAxes, cards: a.cards })
);
check(
  "A 导演来自核实来源而非空值（未核实的写「未知」也算诚实）",
  a.cards > 0 && a.directors.every((d) => d && d.length > 0) && a.directors.some((d) => !/未知/.test(d)),
  JSON.stringify(a.directors)
);
check("A 远程区段无横向溢出", a.overflowX === false, "");
await shot("A-intolerance");

// 纠正必须带证据
console.log("\n===================== STEP 4 纠正与排除");
const noEvidence = await evalJs(`(() => {
  const card = document.querySelector('.find-hit-film');
  card.querySelector('[data-film-action="flag"]').click();
  const form = card.querySelector('.find-remote-flag');
  form.hidden = false;
  form.querySelector('[data-film-evidence]').value = '';
  form.requestSubmit();
  const flash = card.querySelector('.find-remote-flash');
  return { text: flash ? flash.textContent : '', isError: flash ? flash.classList.contains('is-error') : false };
})()`);
check("空证据的标记被拒绝并说明原因", /证据为必填/.test(noEvidence.text) && noEvidence.isError, JSON.stringify(noEvidence));

const withEvidence = await evalJs(`(() => {
  const card = document.querySelector('.find-hit-film');
  const form = card.querySelector('.find-remote-flag');
  form.querySelector('[data-film-axis]').value = 'nature';
  form.querySelector('[data-film-evidence]').value = 'Commons 类目为 Triangle publicity photos，实为宣传照而非逐帧画面';
  form.requestSubmit();
  const stored = JSON.parse(sessionStorage.getItem('va-film-corrections-v1') || '[]');
  return { flash: card.querySelector('.find-remote-flash').textContent, stored };
})()`);
check("带证据的标记被记录（会话级，不写源码）", /已记录你的标记/.test(withEvidence.flash) && withEvidence.stored.length === 1, JSON.stringify({ flash: withEvidence.flash, stored: withEvidence.stored }));
check("纠正记录不改写事实字段（导演/年份保持来源值）", withEvidence.stored.every((s) => !("director" in s) && !("year" in s)), JSON.stringify(withEvidence.stored));
await shot("A-corrected");

const picked = await evalJs(`(() => {
  const card = document.querySelector('.find-hit-film');
  if (!card) return { ok: false };
  card.querySelector('[data-film-action="pick"]').click();
  const btn = card.querySelector('[data-film-action="pick"]');
  return { ok: true, label: btn.textContent, disabled: btn.disabled };
})()`);
check("候选可被选为参考（进入 TaskContext 引用体系）", picked.ok && picked.disabled === true, JSON.stringify(picked));

const excluded = await evalJs(`(() => {
  const before = document.querySelectorAll('.find-hit-film').length;
  const card = document.querySelector('.find-hit-film');
  if (!card) return { ok: false, before };
  const src = card.dataset.filmSource || '';
  card.querySelector('[data-film-action="exclude"]').click();
  // 轮询而不是固定等待：重渲染发生在 click 之后（同步移除 + 重新渲染），
  // 固定 700ms 属于「赌它够快」，实测就是在这里偶发失败。
  const done = (attempts) => new Promise((resolve) => {
    const after = document.querySelectorAll('.find-hit-film').length;
    const stillThere = [...document.querySelectorAll('.find-hit-film')].some((c) => c.dataset.filmSource === src);
    const summary = document.querySelector('.find-remote-summary');
    const text = summary ? summary.textContent.replace(/\\s+/g, ' ') : '';
    const settled = after === before - 1 && /已排除\\s*1\\s*件/.test(text);
    if (settled || attempts <= 0) {
      resolve({
        ok: true, before, after, excludedStillPresent: stillThere,
        summaryMentionsExcluded: /已排除\\s*1\\s*件/.test(text),
        summaryText: text.slice(-140),
        // 排除后动作必须仍可用：重渲染换了 DOM，但监听在常驻的 #find-remote 上。
        actionsStillBound: Boolean(document.querySelector('#find-remote')?.dataset.filmBound),
        stored: JSON.parse(sessionStorage.getItem('va-film-corrections-v1') || '[]').length,
        attempts,
      });
      return;
    }
    setTimeout(() => resolve(done(attempts - 1)), 200);
  });
  return done(30);
})()`);
check("无法核实的件可被排除，且**当前结果集真的变小**", excluded.ok && excluded.after === excluded.before - 1 && excluded.excludedStillPresent === false, JSON.stringify(excluded));
check("排除会计入并显示在渠道摘要里（不是只写一条记录）", excluded.summaryMentionsExcluded === true, JSON.stringify(excluded));
check("排除后重渲染，动作仍绑定在常驻容器上", excluded.actionsStillBound === true, JSON.stringify(excluded));

// ---------------------------------------------------------------- 查询 B
console.log("\n===================== B · 视觉描述「冷色 孤独 空旷街道」");
await runQuery("冷色 孤独 空旷街道");
const b = await measure();
report.queries.B = b;
console.log(`  candidates=${b.cards} note=${b.note.slice(0, 220)}`);
check("B 如实给出渠道侧的映射说明（哪些词没参与检索）", /未参与|映射为受控词/.test(b.note), b.note.slice(0, 200));
check("B 报告图像分析覆盖率且为 0（无授权即不做）", /图像分析/.test(b.note) && /0\/\d|没有任何候选完成图像分析/.test(b.note), b.note.slice(0, 200));
check("B 未把片名撞词当成视觉召回", b.cards === 0 || b.saysNoVision === b.cards, JSON.stringify({ cards: b.cards, saysNoVision: b.saysNoVision }));
check("B 无横向溢出", b.overflowX === false, "");
check("B 若有候选，全部标注「待视觉核验」而非已视觉匹配", b.cards === 0 || b.pendingVision === b.cards, JSON.stringify({ cards: b.cards, pendingVision: b.pendingVision, visualMatched: b.visualMatched }));
await shot("B-visual-description");

// ---------------------------------------------------------------- P2 STEP 2
// 英文多词查询：night city street。关键验收：不能只靠一个偶然命中的片名，
// 且片名撞词的候选必须被明确标成「待视觉核验」。
console.log("\n===================== P2 · 多概念召回（night city street）");
await runQuery("night city street");
const c = await measure();
report.queries.C = c;
console.log(`  candidates=${c.cards} decoded=${c.decoded}`);
console.log(`  summary: ${c.note.slice(0, 240)}`);
check("C 走的是多概念召回（至少两个受控词参与）", /多概念召回/.test(c.note) && /→\d+ 件/.test(c.note), c.note.slice(0, 240));
check(
  "C 逐词报告各自贡献（不是只报一个词）",
  ["night", "city", "street"].every((t) => new RegExp(`「${t}」[^；]{0,24}→\\d+ 件`).test(c.note)),
  c.note.slice(0, 240)
);
check("B 点名未参与检索的词（冷色、孤独）", /未参与检索的词：冷色、孤独/.test(b.note), b.note.slice(0, 260));
check("C 有候选或如实报零（不谎称视觉识别）", c.cards >= 0 && /图像分析/.test(c.note), c.note.slice(0, 200));
check("C 片名撞词的候选全部标注「待视觉核验」", c.cards === 0 || c.pendingVision === c.cards, JSON.stringify({ cards: c.cards, pendingVision: c.pendingVision, visualMatched: c.visualMatched }));
check("C 候选图片真实解码", c.cards === 0 || c.decoded === c.cards, JSON.stringify({ cards: c.cards, decoded: c.decoded }));
check("C 界面从未出现「已视觉匹配」这种说法", c.visualMatched === 0, JSON.stringify({ visualMatched: c.visualMatched }));
await shot("C-multi-concept");

check("全程无 JS 异常", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));

report.pass = pass;
report.fail = fail;
report.skip = skip;
report.failures = failures;
report.skips = skips;
writeFileSync(join(OUT, "film-discovery-check.json"), JSON.stringify(report, null, 2));
console.log(`\n===== film-discovery(${LABEL}): ${pass}/${pass + fail} PASS, ${fail} FAIL, ${skip} SKIP =====`);
for (const f of failures) console.log(`  FAIL ${f.name} — ${f.detail}`);
for (const s2 of skips) console.log(`  SKIP ${s2.name} — ${s2.reason}`);
console.log(`截图与报告：${OUT}`);
try {
  await call("Browser.close");
} catch {
  /* 忽略 */
}
edge.kill();
process.exit(fail > 0 ? 1 : 0);