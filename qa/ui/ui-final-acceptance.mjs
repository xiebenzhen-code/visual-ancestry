// ui-final-acceptance.mjs —— STEP 4：定向真实验收。
//
// 只跑本轮失败项与直接受影响的回归，不重跑全部套件。
//
// 防假验收（任务书明确要求）：
//   每一组断言前先 verify() 目标页面/组件确实存在，**不存在就直接判 FAIL**，
//   而不是「跳过」或「0===0 也算过」。上一轮就栽过：
//   round3 还在找旧首页类名，量到 undefined 却被当成通过。
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:5173";
const LABEL = process.argv[3] || "final";
const OUT = join(HERE, `ui-final-${LABEL}`);
const PORT = 9488;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}${detail ? ` — ${String(detail).slice(0, 110)}` : ""}`);
  } else {
    fail++;
    failures.push({ name, detail: String(detail).slice(0, 320) });
    console.log(`  FAIL ${name} — ${String(detail).slice(0, 260)}`);
  }
};

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  return (method, params = {}) => new Promise((r) => {
    const mid = ++id; pending.set(mid, r);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

const edge = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(OUT, "profile")}`, "--no-first-run", "about:blank",
], { stdio: "ignore" });

let ready = false;
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) { ready = true; break; } } catch { /* 等 CDP */ }
  await sleep(600);
}
if (!ready) { edge.kill(); throw new Error("CDP 未就绪"); }

const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const call = await connect(created.webSocketDebuggerUrl);
await call("Page.enable");
await call("Runtime.enable");

const evalJs = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
  return r.result?.result?.value;
};

// verify：目标不存在时直接判失败（防空 DOM 假通过）
const verify = async (name, sel, note = "") => {
  const ok = await evalJs(`Boolean(document.querySelector(${JSON.stringify(sel)}))`);
  check(`前置：${name} 存在`, ok === true, ok ? sel : `找不到 ${sel} ${note}`);
  return ok;
};

const waitFor = async (sel, label = sel, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(`Boolean(document.querySelector(${JSON.stringify(sel)}))`)) return true;
    await sleep(500);
  }
  return false;
};

const go = async (hash) => {
  await evalJs(`(() => { location.hash = ${JSON.stringify(hash)}; return 1; })()`);
  await sleep(700);
};

const report = { base: BASE, label: LABEL, at: new Date().toISOString(), groups: [] };
const jsErrors = [];

// ================= STEP 2 复核：首页密度与加载 =================
console.log("\n===== STEP 2 · 首页密度与图片加载（1440×900）=====");
await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1440, screenHeight: 900 });
await call("Page.navigate", { url: `${BASE}/?final=1#index` });
await sleep(1500);
await waitFor("#find-text", "首页检索视图");
if (!(await verify("首页检索视图", "#find-text", "（等待 30s 后仍为 null）"))) {
  console.log("  首页未挂载，后续断言无意义");
  await call("Browser.close"); edge.kill(); process.exit(1);
}
const density = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) {
    const vh = window.innerHeight;
    const imgs = [...document.querySelectorAll('.album-wall img')].filter((x) => {
      if (x.offsetParent === null) return false;
      const r = x.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh;
    });
    if (imgs.length && imgs.every((x) => x.complete)) break;
    await sleep(400);
  }
  window.scrollTo(0, 0); await sleep(300);
  const vh = window.innerHeight;
  const plates = [...document.querySelectorAll('.album-wall .plate')];
  const inView = plates.filter((p) => { const r = p.getBoundingClientRect(); return r.top < vh && r.bottom > 0; });
  const keys = plates.map((p) => p.getAttribute('aria-label'));
  const slots = [...document.querySelectorAll('.album-wall .img-slot')].filter((x) => x.offsetParent !== null);
  const ph = slots.filter((s) => { const u = s.querySelector('.img-unavailable'); return u && u.getClientRects().length > 0; }).length;
  const imgs = [...document.querySelectorAll('.album-wall img')].filter((x) => x.offsetParent !== null);
  return {
    skin: document.documentElement.dataset.skin,
    columns: getComputedStyle(document.querySelector('.album-wall')).columnCount,
    firstScreen: inView.length,
    duplicates: keys.length - new Set(keys).size,
    decoded: imgs.filter((x) => x.naturalWidth > 0).length,
    images: imgs.length,
    placeholders: ph,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    searchVisible: (() => { const r = document.querySelector('.album-search input').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })(),
    imageShare: Math.round(((window.innerHeight - document.querySelector('.album-wall').getBoundingClientRect().top) / window.innerHeight) * 100),
  };
})()`);
console.log(`  皮肤 ${density.skin} | 列数 ${density.columns} | 首屏 ${density.firstScreen} 件 | 图占首屏 ${density.imageShare}% | 解码 ${density.decoded}/${density.images} | 占位 ${density.placeholders}`);
check("A 画册方案为默认皮肤", density.skin === "album", density.skin);
check("桌面 5 列", density.columns === "5", density.columns);
check("桌面首屏 12–16 件可见作品", density.firstScreen >= 12 && density.firstScreen <= 16, `${density.firstScreen} 件`);
check("图片占首屏 60% 以上（图片是主体）", density.imageShare >= 60, `${density.imageShare}%`);
check("搜索框在首屏一眼可见", density.searchVisible === true, "");
check("无重复作品", density.duplicates === 0, `${density.duplicates}`);
check("图片实际解码且无占位", density.decoded === density.images && density.placeholders === 0, `解码 ${density.decoded}/${density.images} 占位 ${density.placeholders}`);
check("桌面无横向溢出", density.overflowX === false, "");
report.groups.push({ group: "density", density });

// ================= STEP 3 复核：CREATE TaskContext =================
console.log("\n===== STEP 3 · CREATE 显示已选 TaskContext 参考 =====");
// 用《巴赫拉姆·古尔战角兽》做固定回归案例：它曾被 .slice(0,12) 挤出可见区
const bahram = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 在图片墙上找到这件并点开详情
  const { artworks } = await import('/src/data/artworks.js');
  const { recordReference, beginTask } = await import('/src/utils/taskContext.js');
  const target = artworks.find((a) => /bahram/i.test(a.id || '') || /巴赫拉姆/.test(a.titleZh || ''));
  if (!target) return { error: 'regression artwork missing from data' };
  const key = target.id;
  beginTask();
  recordReference(target.key);            // 与侧栏「使用参考」完全相同的机制
  location.hash = '#create';
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    if (location.hash === '#create' && document.querySelector('#create-picks')) break;
  }
  const pick = document.querySelector('[data-create-pick="' + key + '"]');
  return {
    workKey: key,
    hash: location.hash,
    pickExists: Boolean(pick),
    isSelected: pick ? pick.classList.contains('is-on') : false,
    ariaPressed: pick ? pick.getAttribute('aria-pressed') : null,
    isTaskRef: pick ? pick.classList.contains('is-task-ref') : false,
    positionInGrid: pick ? [...document.querySelectorAll('[data-create-pick]')].indexOf(pick) : -1,
    totalPicks: document.querySelectorAll('[data-create-pick]').length,
    dupIds: (() => {
      const ids = [...document.querySelectorAll('[data-create-pick]')].map((b) => b.dataset.createPick);
      return ids.length - new Set(ids).size;
    })(),
    noFakeAnalysis: (() => {
      // 不得给无分析作品编造分析字段：检查标注与 data-has-analysis 一致
      const flags = [...document.querySelectorAll('[data-create-pick]')];
      return flags.every((b) => {
        const has = b.dataset.hasAnalysis === '1';
        const flagged = Boolean(b.querySelector('.pick-flag'));
        return has ? !flagged : flagged;
      });
    })(),
  };
})()`);
console.log(`  案例 ${bahram.workKey} | 在参考区=${bahram.pickExists} 已选中=${bahram.isSelected} 位置=${bahram.positionInGrid}/${bahram.totalPicks} 重复=${bahram.dupIds}`);
check("CREATE 参考区存在（前置）", bahram.totalPicks > 0, `共 ${bahram.totalPicks} 件`);
check("《巴赫拉姆·古尔战角兽》出现在 CREATE 参考区", bahram.pickExists === true, bahram.error || bahram.workKey);
check("该参考被标记为已选中（is-on + aria-pressed）", bahram.isSelected === true && bahram.ariaPressed === "true", `is-on=${bahram.isSelected} aria=${bahram.ariaPressed}`);
check("该参考排在参考区前部（TaskContext 优先）", bahram.positionInGrid >= 0 && bahram.positionInGrid < 3, `位置 ${bahram.positionInGrid}`);
check("参考区无重复作品", bahram.dupIds === 0, `${bahram.dupIds}`);
check("未给无分析作品伪造分析标注", bahram.noFakeAnalysis === true, "");
report.groups.push({ group: "create", bahram });

// 取消选择 / 重新进入的状态正确性
const toggle = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = ${JSON.stringify(bahram.workKey || "")};
  const pick = document.querySelector('[data-create-pick="' + key + '"]');
  if (!pick) return { error: 'pick gone' };
  pick.click();                       // 取消
  await sleep(400);
  const afterOff = { isOn: pick.classList.contains('is-on'), aria: pick.getAttribute('aria-pressed') };
  pick.click();                       // 再选回来
  await sleep(400);
  const afterOn = { isOn: pick.classList.contains('is-on'), aria: pick.getAttribute('aria-pressed') };
  location.hash = '#index'; await sleep(600);
  location.hash = '#create'; await sleep(900);
  const again = document.querySelector('[data-create-pick="' + key + '"]');
  return {
    afterOff, afterOn,
    stillVisibleAfterReenter: Boolean(again),
    stillSelectedAfterReenter: again ? again.classList.contains('is-on') : false,
    dupAfterReenter: (() => {
      const ids = [...document.querySelectorAll('[data-create-pick]')].map((b) => b.dataset.createPick);
      return ids.length - new Set(ids).size;
    })(),
  };
})()`);
check("取消选择后状态正确回显", toggle.afterOff?.isOn === false && toggle.afterOff?.aria === "false", JSON.stringify(toggle.afterOff));
check("重新选择后状态正确回显", toggle.afterOn?.isOn === true && toggle.afterOn?.aria === "true", JSON.stringify(toggle.afterOn));
check("离开再进入：参考仍在且仍被选中", toggle.stillVisibleAfterReenter === true && toggle.stillSelectedAfterReenter === true, JSON.stringify(toggle));
check("离开再进入：仍无重复", toggle.dupAfterReenter === 0, `${toggle.dupAfterReenter}`);

// 无图作品的显示路径（本地档案里有 5 件无图作品）
const noImage = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '#create'; await sleep(900);
  const { artworks } = await import('/src/data/artworks.js');
  const noImg = artworks.find((a) => !a.image || a.imageUnavailable);
  if (!noImg) return { error: 'no such artwork' };
  const { recordReference, beginTask } = await import('/src/utils/taskContext.js');
  beginTask();
  recordReference(noImg.key);              // string key（传对象会被静默挡下）
  location.hash = '#index'; await sleep(500);
  location.hash = '#create'; await sleep(1000);
  const pick = document.querySelector('[data-create-pick="' + noImg.id + '"]');
  return {
    artwork: noImg.titleZh || noImg.title,
    id: noImg.id,
    inPicks: Boolean(pick),
    hasNoFigMark: pick ? Boolean(pick.querySelector('.pick-nofig')) : false,
    hasFakeImg: pick ? Boolean(pick.querySelector('img')) : false,
    selected: pick ? pick.classList.contains('is-on') : false,
  };
})()`);
console.log(`  无图案例《${noImage.artwork}》在参考区=${noImage.inPicks} 无图标记=${noImage.hasNoFigMark} 伪造图片=${noImage.hasFakeImg}`);
check("无图作品也能进入参考区并显示真实作品名", noImage.inPicks === true && noImage.selected === true, JSON.stringify(noImage).slice(0, 180));
check("无图作品标注「无图」而不是塞占位图", noImage.hasNoFigMark === true && noImage.hasFakeImg === false, JSON.stringify(noImage).slice(0, 140));
report.groups.push({ group: "create-noimage", noImage });

// ================= 生成方案 / 复制 / 导出 =================
console.log("\n===== CREATE · 生成创作方案、复制与导出 =====");
const generate = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '#create'; await sleep(900);
  const { artworks } = await import('/src/data/artworks.js');
  // 选两件有分析记录的作品，凑出「视觉语言」才可能生成方案
  const picks = [...document.querySelectorAll('[data-create-pick][data-has-analysis="1"]')].slice(0, 2);
  if (picks.length < 2) return { error: 'not enough analysable picks', picks: picks.length };
  for (const p of picks) { if (!p.classList.contains('is-on')) { p.click(); await sleep(300); } }
  await sleep(600);
  const sheet = document.querySelector('#create-language');
  const genBtn = document.querySelector('[data-prompt-generate], #create-generate, [data-create-generate]');
  if (genBtn) { genBtn.click(); await sleep(700); }
  const copyBtn = document.querySelector('[data-prompt-export="copy"]');
  const mdBtn = document.querySelector('[data-prompt-export="markdown"]');
  return {
    picksUsed: picks.map((p) => p.dataset.createPick),
    hasLanguageSheet: Boolean(sheet && sheet.querySelector('.language-sheet')),
    principleCount: document.querySelectorAll('[data-keep]').length,
    hasGenerateButton: Boolean(genBtn),
    copyExists: Boolean(copyBtn),
    mdExists: Boolean(mdBtn),
    copyEnabled: copyBtn ? !copyBtn.disabled : false,
    mdEnabled: mdBtn ? !mdBtn.disabled : false,
    outputHead: (document.querySelector('#create-output, .prompt-output, #prompt-out')?.textContent || '').replace(/\\s+/g,' ').slice(0, 120),
  };
})()`);
console.log(`  语言表=${generate.hasLanguageSheet} 原则勾选=${generate.principleCount} 复制可用=${generate.copyEnabled} 导出可用=${generate.mdEnabled}`);
check("CREATE 参考区有足够可分析作品（前置）", generate.picksUsed?.length >= 2, JSON.stringify(generate.picksUsed));
check("生成视觉语言表（MY VISUAL LANGUAGE）", generate.hasLanguageSheet === true, generate.error || "");
check("复制 Prompt 控件存在", generate.copyExists === true, "");
check("导出 Markdown 控件存在", generate.mdExists === true, "");
check("方案未生成前导出按钮保持禁用（不导示例文本）", generate.copyEnabled === false || generate.hasGenerateButton === true, `copy=${generate.copyEnabled} 有生成按钮=${generate.hasGenerateButton}`);
report.groups.push({ group: "generate", generate });

// ================= STEP 4 其余项 =================
console.log("\n===== 其余定向项 =====");
const homeFlow = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '#index';
  for (let i = 0; i < 60; i++) { await sleep(400); if (document.querySelector('#find-text')) break; }
  const hashBefore = location.hash;
  document.querySelector('#find-text').value = '孤独 夜晚';
  document.querySelector('#album-search').dispatchEvent(new Event('submit', { cancelable: true }));
  for (let i = 0; i < 80; i++) { await sleep(400); if (document.querySelectorAll('#find-results .find-hit').length) break; }
  // 切媒介筛选
  const film = [...document.querySelectorAll('[data-find-media]')].find((b) => b.textContent.trim() === '电影');
  film.click();
  await sleep(3000);
  return {
    hashUnchanged: location.hash === hashBefore,
    hits: document.querySelectorAll('#find-results .find-hit').length,
    filmActive: film.classList.contains('is-on'),
    remoteNote: (document.querySelector('#find-remote')?.textContent || '').replace(/\\s+/g,' ').slice(0, 90),
  };
})()`);
check("首页搜索路由不变", homeFlow.hashUnchanged === true, `hits=${homeFlow.hits}`);
check("媒介筛选可切换并生效", homeFlow.filmActive === true, homeFlow.remoteNote);

const panelFlow = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '#index';
  for (let i = 0; i < 60; i++) { await sleep(400); if (document.querySelector('#find-text')) break; }
  document.querySelector('#album-clear')?.click();
  await sleep(400);
  const plate = document.querySelector('.plate[data-plate-key]');
  plate.click();
  for (let i = 0; i < 40; i++) { if (document.querySelector('.work-panel:not([hidden])')) break; await sleep(250); }
  const opened = Boolean(document.querySelector('.work-panel:not([hidden])'));
  const href = plate.getAttribute('href');
  const scrollBefore = window.scrollY;
  document.querySelector('.work-panel [data-panel-close]')?.click();
  await sleep(400);
  // 路由切换后是否还有旧侧栏
  location.hash = '#memory';
  await sleep(1200);
  const panelAfterRoute = Boolean(document.querySelector('.work-panel:not([hidden])'));
  location.hash = '#index';
  return { opened, deepLink: href, scrollBefore, scrollBack: window.scrollY, panelAfterRoute };
})()`);
check("点击作品打开详情侧栏", panelFlow.opened === true, "");
check("深链 href 保留", String(panelFlow.deepLink || "").startsWith("#artwork/"), panelFlow.deepLink);
check("路由切换后无旧侧栏覆盖", panelFlow.panelAfterRoute === false, `panel=${panelFlow.panelAfterRoute}`);
report.groups.push({ group: "panel", panelFlow });

// 390px
await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844 });
await call("Page.navigate", { url: `${BASE}/?final2=1#index` });
await sleep(1200);
await waitFor("#find-text", "390px 首页");
if (await verify("390px 首页", "#find-text", "（等待 30s 后仍为 null）")) {
  const mob = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 50; i++) {
      const imgs = [...document.querySelectorAll('.album-wall img')].filter((x) => {
        if (x.offsetParent === null) return false;
        const r = x.getBoundingClientRect();
        return r.bottom > 0 && r.top < window.innerHeight;
      });
      if (imgs.length && imgs.every((x) => x.complete)) break;
      await sleep(400);
    }
    const imgs = [...document.querySelectorAll('.album-wall img')].filter((x) => x.offsetParent !== null);
    const slots = [...document.querySelectorAll('.album-wall .img-slot')].filter((x) => x.offsetParent !== null);
    return {
      columns: getComputedStyle(document.querySelector('.album-wall')).columnCount,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      decoded: imgs.filter((x) => x.naturalWidth > 0).length,
      images: imgs.length,
      placeholders: slots.filter((s) => { const u = s.querySelector('.img-unavailable'); return u && u.getClientRects().length > 0; }).length,
      widest: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      searchTop: Math.round(document.querySelector('.album-search input').getBoundingClientRect().top),
    };
  })()`);
  console.log(`  390px: 列数 ${mob.columns} 溢出=${mob.overflowX} 解码 ${mob.decoded}/${mob.images} 占位 ${mob.placeholders}`);
  check("390px 双列", mob.columns === "2", mob.columns);
  check("390px 无横向溢出", mob.overflowX === false, `超宽 ${mob.widest}px`);
  check("390px 图片真实解码且无占位", mob.decoded === mob.images && mob.placeholders === 0, `解码 ${mob.decoded}/${mob.images}`);
  check("390px 搜索框在首屏", mob.searchTop >= 0 && mob.searchTop < 400, `top=${mob.searchTop}`);
  report.groups.push({ group: "mobile", mob });
}

const errors = await evalJs(`(window.__finalErrors || []).slice(0, 5)`);
check("全程无未捕获 JS 异常", errors.length === 0, errors.join(" | "));

report.pass = pass;
report.fail = fail;
report.failures = failures;
writeFileSync(join(OUT, "ui-final-acceptance.json"), JSON.stringify(report, null, 2));
console.log(`\n===== 定向验收(${LABEL}): ${pass}/${pass + fail} PASS, ${fail} FAIL =====`);
for (const f of failures) console.log(`  FAIL ${f.name} — ${f.detail}`);
console.log(`报告：${join(OUT, "ui-final-acceptance.json")}`);
try { await call("Browser.close"); } catch { /* ignore */ }
edge.kill();
process.exit(fail ? 1 : 0);