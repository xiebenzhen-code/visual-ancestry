// R3 验收 — CREATE 图像 / 首页密度 / 电影参考 / CREATE 导出（真实浏览器 Edge CDP）。
//
// 用法: node qa/ui/round3-check.mjs <baseUrl> <label> [section]
//   label   : 输出目录后缀（before / after / 自定义），同时决定调试端口
//             (before → 9488，其它 → 9489)
//   section : home | create | film | regress | all（默认 all）
//
// 覆盖范围只限本轮改动可验证的部分，不重跑历史用例，不触发任何 provider 调用，
// 不写预算账本（全程静态页面 + 文字检索）。
//
//   1. CREATE 参考墙：真实解码张数、0 张「图像暂不可用」、解码失败的卡片被移除
//   2. 首页首屏图片密度（桌面 12–16）、无重复作品、无放大低清图、无横向溢出
//   3. 电影参考：每个电影画面详情页真实解码 + 元数据齐全；SHOOT 电影参考墙可见
//   4. CREATE 导出：未生成 Prompt 时禁用并解释；生成后复制 / Markdown / JSON
//      三个动作都基于真实任务结果，下载文件重新读回核对
//   5. 回归：FIND / SHOOT / MEMORY / 作品详情路由、FIND 名称命中、实例守卫
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readdirSync, readFileSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:5173";
const LABEL = process.argv[3] || "after";
const SECTION = process.argv[4] || "all";
const OUTDIR = join(HERE, "round3-shots", LABEL);
const DLDIR = join(HERE, "round3-downloads", LABEL);
const PORT = LABEL === "before" ? 9488 : 9489;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const USER_DATA = join(HERE, "round3-edge-profile", LABEL === "before" ? "before" : "after");
for (const d of [OUTDIR, DLDIR]) {
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
}

let pass = 0;
let fail = 0;
const failures = [];
const check = (n, c, d = "") => {
  if (c) {
    pass++;
    console.log(`  PASS ${n}`);
  } else {
    fail++;
    failures.push({ n, d: String(d).slice(0, 400) });
    console.log(`  FAIL ${n}${d ? ` — ${String(d).slice(0, 240)}` : ""}`);
  }
};

async function cdpConnect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (onEvent) onEvent(m);
  };
  const send = (method, params = {}) => new Promise((r) => {
    const mid = ++id;
    pending.set(mid, r);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ws, send };
}

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "tablet", width: 834, height: 1112, mobile: true },
  { name: "phone", width: 390, height: 844, mobile: true },
];

// 图片是 lazy 的：必须滚到区块再等解码，否则「还没开始加载」会被误读成「加载失败」。
// 逐段滚动，让视口之外的 lazy 图也真的发起请求。
const settleImages = async (evalJs, rootExpr, itemExpr) => {
  await evalJs(`document.querySelector(${rootExpr})?.scrollIntoView({ block: 'start' })`);
  await sleep(300);
  const doneExpr = `(() => {
    const items = [...document.querySelectorAll(${itemExpr})];
    if (!items.length) return 'empty';
    return items.every((el) => {
      const slot = el.querySelector('.img-slot');
      const img = el.querySelector('img');
      if (slot && (slot.classList.contains('is-broken') || el.classList.contains('is-dead'))) return true;
      return Boolean(img && img.naturalWidth > 0);
    }) ? true : false;
  })()`;
  for (let i = 0; i < 30; i++) {
    const ok = await evalJs(doneExpr);
    if (ok === true || ok === "empty") return ok;
    // 每两轮向下滚一屏，把下面的 lazy 图带进视野；到底后回滚到顶部继续等。
    if (i % 2 === 1) {
      await evalJs(`(() => {
        const root = document.querySelector(${rootExpr});
        if (!root) return null;
        const r = root.getBoundingClientRect();
        const atEnd = r.bottom < innerHeight + 40;
        scrollBy(0, Math.round(innerHeight * 0.85));
        if (atEnd) scrollTo(0, 0);
        return Math.round(scrollY);
      })()`);
    }
    await sleep(500);
  }
  return false;
};

const results = { base: BASE, label: LABEL, at: new Date().toISOString(), sections: {} };
let jsErrors = [];

async function main() {
  const edge = spawn(EDGE, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA}`,
    "--no-first-run",
    "--disable-features=Translate",
    "about:blank",
  ], { stdio: "ignore" });

  let version = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch {}
    await sleep(700);
  }
  if (!version) throw new Error("Edge CDP 未就绪");

  const browserConn = await cdpConnect(version.webSocketDebuggerUrl);
  await browserConn.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DLDIR,
    eventsEnabled: true,
  }).catch(() => null);

  const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const page = await cdpConnect(created.webSocketDebuggerUrl, (m) => {
    if (m.method === "Runtime.exceptionThrown") jsErrors.push("EXC: " + (m.params?.exceptionDetails?.text || "?"));
    if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
      jsErrors.push("ERR: " + (m.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 160));
    }
  });
  const call = page.send;
  const evalJs = async (expr) => {
    const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    const ex = r.result?.exceptionDetails;
    if (ex) return { __err: ex.text + " " + (ex.exception?.description || "") };
    return r.result?.result?.value;
  };
  const waitFor = async (expr, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evalJs(expr)) return true;
      await sleep(120);
    }
    return false;
  };
  const setViewport = async ({ width, height, mobile }) => {
    await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    await call("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  };
  const shot = async (name) => {
    const r = await call("Page.captureScreenshot", { format: "png" });
    if (r.result?.data) writeFileSync(join(OUTDIR, `${name}.png`), Buffer.from(r.result.data, "base64"));
    return Boolean(r.result?.data);
  };
  // 硬导航：先回 about:blank，避免同文档跳转读到上一步的 DOM。
  const goto = async (hash, readyExpr = null, ms = 15000) => {
    await call("Page.enable");
    await call("Page.navigate", { url: "about:blank" });
    await sleep(180);
    await call("Page.navigate", { url: `${BASE}/${hash}` });
    await sleep(350);
    await waitFor("document.readyState === 'complete'", 10000);
    // 返回 readyExpr 的实际等待结果：路由检查要靠它判断「页面真的挂上了」，
    // 不返回的话 mounted 恒为 undefined，18 条路由用例会假失败。
    if (readyExpr) {
      const ok = await waitFor(readyExpr, ms);
      await sleep(500);
      return ok;
    }
    await sleep(500);
    return true;
  };

  // ======================= 2. 首页密度 =======================
  if (SECTION === "all" || SECTION === "home") {
    console.log("\n======================= 首页图片墙密度 =======================");
    const HOME_M = `(() => {
      const plates = [...document.querySelectorAll('.album-wall .plate')];
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; };
      const first = plates.filter(vis);
      const imgs = (list) => list.map((p) => p.querySelector('img')).filter(Boolean);
      const upscaled = first.filter((p) => {
        const i = p.querySelector('img'); const s = p.querySelector('.img-slot');
        if (!i || !s || !i.naturalWidth) return false;
        return i.naturalWidth + 1 < Math.round(s.getBoundingClientRect().width);
      }).map((p) => p.getAttribute('href'));
      const hrefs = plates.map((p) => p.getAttribute('href'));
      const cap = document.querySelector('.plate-info');
      const cs = cap ? getComputedStyle(cap) : null;
      return {
        viewport: innerWidth + 'x' + innerHeight,
        plates: plates.length,
        firstScreen: first.length,
        firstScreenDecoded: imgs(first).filter((i) => i.naturalWidth > 0).length,
        firstScreenBroken: imgs(first).filter((i) => i.complete && i.naturalWidth === 0).length,
        firstScreenLoading: first.filter((p) => { const s = p.querySelector('.img-slot'); return s && s.classList.contains('is-loading'); }).length,
        duplicates: hrefs.length - new Set(hrefs).size,
        upscaled,
        columns: getComputedStyle(document.querySelector('.album-wall')).columnCount,
        captionVisible: cs ? (cs.display !== 'none' && parseFloat(cs.opacity) > 0.01) : null,
        captionOverImage: (() => {
          if (!cap || cs.position !== 'absolute') return false;
          const s = cap.closest('figure').querySelector('.img-slot').getBoundingClientRect();
          return cap.getBoundingClientRect().top < s.bottom - 1;
        })(),
        searchVisible: (() => { const f = document.querySelector('.album-search'); if (!f) return false; const r = f.getBoundingClientRect(); return r.top < innerHeight; })(),
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        wide: [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 3).map((el) => (el.className || el.tagName) + '').map((s) => s.slice(0, 40)),
      };
    })()`;
    const home = {};
    for (const vp of VIEWPORTS) {
      await setViewport(vp);
      await goto("#index", "!!document.querySelector('.album-wall .plate')");
      await settleImages(evalJs, "'.album-wall'", "'.album-wall .plate'");
      // 「首屏」必须在页面顶部量：settle 过程会滚动页面。
      await evalJs("scrollTo(0, 0)");
      await sleep(250);
      const m = await evalJs(HOME_M);
      home[vp.name] = m;
      check(`${vp.name} 首页无横向溢出`, m.overflowX === false, JSON.stringify(m.wide));
      check(`${vp.name} 首屏图片全部解码（无 broken / 无卡在 loading）`, m.firstScreenDecoded === m.firstScreen && m.firstScreenBroken === 0 && m.firstScreenLoading === 0, JSON.stringify({ first: m.firstScreen, decoded: m.firstScreenDecoded, broken: m.firstScreenBroken, loading: m.firstScreenLoading }));
      check(`${vp.name} 首页无重复作品`, m.duplicates === 0, `duplicates=${m.duplicates}`);
      check(`${vp.name} 未放大低清图充当大图`, m.upscaled.length === 0, JSON.stringify(m.upscaled));
      if (vp.name === "phone") {
        check(`${vp.name} 手机双列`, m.columns === "2", `columns=${m.columns}`);
        check(`${vp.name} 文字不覆盖图片（说明在图片下方）`, m.captionOverImage === false, JSON.stringify({ pos: m.captionVisible, over: m.captionOverImage }));
      } else if (vp.mobile) {
        // 平板（834）保持多列，不塌成单列；两列是手机的要求，不套用到平板上。
        check(`${vp.name} 平板保持 3–4 列`, ["3", "4"].includes(m.columns), `columns=${m.columns}`);
        check(`${vp.name} 文字不覆盖图片（说明在图片下方）`, m.captionOverImage === false, JSON.stringify({ pos: m.captionVisible, over: m.captionOverImage }));
      } else if (vp.name === "desktop") {
        check(`桌面首屏可见作品 12–16 件（实测 ${m.firstScreen}）`, m.firstScreen >= 12 && m.firstScreen <= 16, JSON.stringify({ first: m.firstScreen, columns: m.columns }));
        check(`桌面说明默认隐藏（hover 才出现）`, m.captionVisible === false, JSON.stringify({ visible: m.captionVisible }));
        check(`桌面搜索入口仍在首屏`, m.searchVisible === true, "");
      }
      await shot(`home-${vp.name}`);
    }
    results.sections.home = home;
  }

  // ======================= 1 + 4. CREATE =======================
  if (SECTION === "all" || SECTION === "create") {
    console.log("\n======================= CREATE 图像 / 选择 / 生成 / 导出 =======================");
    const CREATE_M = `(() => {
      const cards = [...document.querySelectorAll('#create-picks button[data-create-pick]')];
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; };
      const rows = cards.map((c) => {
        const slot = c.querySelector('.img-slot');
        const img = c.querySelector('img');
        return {
          id: c.dataset.createPick,
          dead: c.classList.contains('is-dead'),
          broken: Boolean(slot && slot.classList.contains('is-broken')),
          loading: Boolean(slot && slot.classList.contains('is-loading')),
          naturalWidth: img ? img.naturalWidth : 0,
          currentSrc: img ? img.currentSrc : null,
          placeholderVisible: (() => {
            const s = c.querySelector('.img-unavailable');
            if (!s) return false;
            const cs = getComputedStyle(s);
            return cs.display !== 'none' && parseFloat(cs.opacity) > 0.01;
          })(),
          inFirst: vis(c),
        };
      });
      return {
        viewport: innerWidth + 'x' + innerHeight,
        rendered: cards.length,
        dead: rows.filter((r) => r.dead).length,
        broken: rows.filter((r) => r.broken).length,
        decoded: rows.filter((r) => r.naturalWidth > 0).length,
        loading: rows.filter((r) => r.loading).length,
        placeholderVisible: rows.filter((r) => r.placeholderVisible).length,
        firstScreenDecoded: rows.filter((r) => r.inFirst && r.naturalWidth > 0).length,
        // 真正要判的是「有没有可见的失败占位」：renderImg 永远会在 DOM 里带一个
        // 隐藏的 .img-unavailable，所以不能拿 textContent 当可见性证据。
        unavailableVisible: [...document.querySelectorAll('#create-picks .img-unavailable')]
          .filter((s) => s.getClientRects().length > 0).length,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        note: document.querySelector('#create-picks-note')?.textContent?.trim() || null,
      };
    })()`;

    const create = {};
    for (const vp of VIEWPORTS) {
      await setViewport(vp);
      await goto("#create", "!!document.querySelector('#create-picks button[data-create-pick] img')");
      await settleImages(evalJs, "'#create-picks'", "'#create-picks button[data-create-pick]'");
      // 「首屏」必须在页面顶部量：settle 过程会滚动页面。
      await evalJs("scrollTo(0, 0)");
      await sleep(250);
      const m = await evalJs(CREATE_M);
      create[vp.name] = m;
      check(`${vp.name} CREATE 参考墙无可见「图像暂不可用」占位`, m.placeholderVisible === 0 && m.unavailableVisible === 0, JSON.stringify({ placeholder: m.placeholderVisible, visible: m.unavailableVisible }));
      check(`${vp.name} CREATE 参考图真实解码（≥10 张）`, m.decoded >= 10, JSON.stringify({ rendered: m.rendered, decoded: m.decoded, broken: m.broken }));
      check(`${vp.name} CREATE 无解码失败卡片残留`, m.dead === 0 && m.broken === 0, JSON.stringify({ dead: m.dead, broken: m.broken, note: m.note }));
      const firstBar = vp.mobile ? 4 : 6;
      check(`${vp.name} CREATE 首屏可见参考图已解码（≥${firstBar}）`, m.firstScreenDecoded >= firstBar, JSON.stringify({ first: m.firstScreenDecoded, viewport: m.viewport }));
      check(`${vp.name} CREATE 无横向溢出`, m.overflowX === false, "");
      await shot(`create-${vp.name}`);
    }

    // ---- 未生成 Prompt 时导出必须禁用并解释原因 ----
    await setViewport(VIEWPORTS[0]);
    await goto("#create", "!!document.querySelector('#create-picks button[data-create-pick]')");
    await evalJs("(() => { [...document.querySelectorAll('#create-picks button[data-create-pick]')].slice(0, 3).forEach((b) => b.click()); return 1; })()");
    await waitFor("!!document.querySelector('.language-sheet')");
    await sleep(300);
    const beforeGen = await evalJs(`(() => {
      const host = document.querySelector('#prompt-export');
      if (!host) return null;
      return {
        buttons: [...host.querySelectorAll('[data-prompt-export]')].map((b) => ({ kind: b.dataset.promptExport, disabled: b.disabled })),
        note: host.querySelector('[data-prompt-export-note]')?.textContent?.trim() || '',
      };
    })()`);
    check("未生成 Prompt 时三个导出动作全部禁用", beforeGen && beforeGen.buttons.length === 3 && beforeGen.buttons.every((b) => b.disabled === true), JSON.stringify(beforeGen));
    check("未生成 Prompt 时给出禁用原因", beforeGen && /还没有生成\s*Prompt/.test(beforeGen.note), beforeGen && beforeGen.note);

    // ---- 生成 Prompt → 导出可用 ----
    await evalJs("document.querySelector('#make-prompt')?.click()");
    await waitFor("!!document.querySelector('#made-prompt .field-block')", 12000);
    await sleep(400);
    const afterGen = await evalJs(`(() => {
      const host = document.querySelector('#prompt-export');
      const body = document.querySelector('#final-prompt-body');
      return {
        buttons: [...host.querySelectorAll('[data-prompt-export]')].map((b) => ({ kind: b.dataset.promptExport, disabled: b.disabled })),
        note: host.querySelector('[data-prompt-export-note]')?.textContent?.trim() || '',
        promptChars: body ? body.textContent.trim().length : 0,
        blocks: document.querySelectorAll('#made-prompt .field-block').length,
        selected: document.querySelectorAll('#create-picks button.is-on').length,
      };
    })()`);
    create.prompt = afterGen;
    check("生成后三个导出动作全部可用", afterGen && afterGen.buttons.every((b) => b.disabled === false), JSON.stringify(afterGen && afterGen.buttons));
    check("生成后说明写清包里有什么（Prompt / VisualIntent / 参考作品 / 版本）", afterGen && /Prompt 正文/.test(afterGen.note) && /数据版本/.test(afterGen.note) && /参考作品/.test(afterGen.note), afterGen && afterGen.note);
    check("Prompt 正文非空", afterGen && afterGen.promptChars > 100, JSON.stringify({ chars: afterGen && afterGen.promptChars, blocks: afterGen && afterGen.blocks }));
    await shot("create-prompt-export");

    // ---- 真实下载：JSON / Markdown 重新读回核对 ----
    const waitFile = async (re, ms = 12000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const f = existsSync(DLDIR) ? readdirSync(DLDIR).find((n) => re.test(n) && !n.endsWith(".crdownload")) : null;
        if (f) { await sleep(250); return join(DLDIR, f); }
        await sleep(250);
      }
      return null;
    };
    const clickExport = async (kind) => {
      await evalJs(`(() => { const b = document.querySelector('[data-prompt-export="${kind}"]'); if (b) b.click(); return !!b; })()`);
    };

    await clickExport("json");
    const jsonPath = await waitFile(/\.json$/);
    check("导出 JSON 触发真实下载", Boolean(jsonPath), JSON.stringify(readdirSync(DLDIR)));
    if (jsonPath) {
      let j = null;
      try { j = JSON.parse(readFileSync(jsonPath, "utf8")); } catch (e) { j = { __parseError: String(e.message) }; }
      const refs = j && Array.isArray(j.references) ? j.references : [];
      create.json = {
        file: jsonPath.split("\\").pop(),
        format: j && j.format,
        version: j && j.version,
        hasGeneratedAt: Boolean(j && j.generatedAt),
        hasExportedAt: Boolean(j && j.exportedAt),
        promptChars: j && j.prompt ? String(j.prompt.text || "").length : 0,
        references: refs.length,
        refsWithSource: refs.filter((r) => r.source && r.source.url).length,
        refsWithRights: refs.filter((r) => r.source && r.source.rightsStatus).length,
        intentFields: j && j.visualIntent ? Object.keys(j.visualIntent).length : 0,
        intentSource: j && j.intentSource,
        blocks: j && j.prompt ? j.prompt.blocks : null,
        sample: refs[0] ? { titleZh: refs[0].titleZh, sourceName: refs[0].source && refs[0].source.name, rights: refs[0].source && refs[0].source.rightsStatus } : null,
      };
      check("JSON 载荷版本与格式标头正确", j && j.format === "visual-ancestry-create-prompt" && j.version === 1, JSON.stringify({ format: j && j.format, version: j && j.version }));
      check("JSON 含生成时间与导出时间", Boolean(j && j.generatedAt && j.exportedAt), JSON.stringify({ g: j && j.generatedAt, e: j && j.exportedAt }));
      check("JSON 的 Prompt 正文与实际生成一致（非空且长度匹配）", j && String(j.prompt.text || "").length === afterGen.promptChars, JSON.stringify({ file: j && String(j.prompt.text || "").length, ui: afterGen.promptChars }));
      check("JSON 参考作品数与界面选择一致", refs.length === afterGen.selected && refs.length >= 2, JSON.stringify({ file: refs.length, ui: afterGen.selected }));
      check("JSON 每件参考都带来源链接", refs.length > 0 && create.json.refsWithSource === refs.length, JSON.stringify({ withSource: create.json.refsWithSource, total: refs.length }));
      check("JSON 每件参考都带已知权利状态", refs.length > 0 && create.json.refsWithRights === refs.length, JSON.stringify({ withRights: create.json.refsWithRights, total: refs.length }));
      check("JSON 声明的 KEEP/REMOVE 开关与界面一致", j && j.prompt.blocks && JSON.stringify(Object.keys(j.prompt.blocks).sort()) === JSON.stringify(["camera", "color", "human", "light", "spatial"]), JSON.stringify(j && j.prompt.blocks));
    }

    await clickExport("markdown");
    const mdPath = await waitFile(/\.md$/);
    check("导出 Markdown 触发真实下载", Boolean(mdPath), JSON.stringify(readdirSync(DLDIR)));
    if (mdPath) {
      const md = readFileSync(mdPath, "utf8");
      create.markdown = { file: mdPath.split("\\").pop(), chars: md.length, head: md.slice(0, 120).replace(/\n/g, " | ") };
      check("Markdown 含 Prompt 正文区", /## Prompt/.test(md) && md.length > 200, JSON.stringify({ chars: md.length }));
      check("Markdown 含参考作品与来源", /## 参考作品/.test(md) && /来源:/.test(md), "");
      check("Markdown 注明不含图片文件", /不含图片文件/.test(md), "");
      // 下面 line ~427 会清空下载目录做第二组导出，所以把核对过的原件留一份到证据目录。
      copyFileSync(mdPath, join(OUTDIR, create.markdown.file));
    }
    if (jsonPath) copyFileSync(jsonPath, join(OUTDIR, create.json.file));

    // ---- 从 FIND 带入任务意图：导出里的 VisualIntent 必须是真实任务 ----
    await goto("#find", "!!document.querySelector('#find-text')");
    await evalJs("(() => { const t = document.querySelector('#find-text'); t.value = '夜晚 冷色调'; document.querySelector('#find-run').click(); return 1; })()");
    await waitFor("!!document.querySelector('#find-results .find-hit')", 12000);
    await sleep(400);
    const picked = await evalJs("(() => { const h = document.querySelector('#find-results .find-hit[data-ref-key]'); if (!h) return null; h.click(); return h.dataset.refKey; })()");
    await goto("#create", "!!document.querySelector('#create-picks button[data-create-pick]')");
    await sleep(400);
    const taskCtx = await evalJs("(() => ({ taskShown: !document.querySelector('#create-task')?.hidden, text: document.querySelector('#create-task')?.innerText?.replace(/\\s+/g,' ').slice(0,160) || '' }))()");
    create.taskFromFind = { picked, ...taskCtx };
    check("FIND 选中的参考被带入 CREATE（任务上下文出现）", Boolean(picked) && taskCtx.taskShown === true, JSON.stringify(create.taskFromFind));
    await evalJs("(() => { [...document.querySelectorAll('#create-picks button[data-create-pick]')].slice(0, 2).forEach((b) => { if (!b.classList.contains('is-on')) b.click(); }); return 1; })()");
    await waitFor("!!document.querySelector('.language-sheet')");
    await evalJs("document.querySelector('#make-prompt')?.click()");
    await waitFor("!!document.querySelector('#made-prompt .field-block')", 12000);
    await sleep(300);
    rmSync(DLDIR, { recursive: true, force: true });
    mkdirSync(DLDIR, { recursive: true });
    await clickExport("json");
    const jsonPath2 = await waitFile(/\.json$/);
    if (jsonPath2) {
      const j2 = JSON.parse(readFileSync(jsonPath2, "utf8"));
      const n = j2.visualIntent ? Object.keys(j2.visualIntent).length : 0;
      create.jsonWithIntent = { intentFields: n, intentSource: j2.intentSource, refs: j2.references.length, hasIntentInMd: true };
      check("带任务进入 CREATE 时，导出含真实 VisualIntent", j2.visualIntent && n > 0 && j2.intentSource === "current-find-task", JSON.stringify({ fields: n, source: j2.intentSource }));
      const md2 = promptExportMd(j2);
      check("带任务时 Markdown 同样写入 VisualIntent", /## 当前 VisualIntent/.test(md2) && !/无（直接进入 CREATE/.test(md2), "");
    } else {
      check("带任务进入 CREATE 时，导出含真实 VisualIntent", false, "没有下载到 JSON");
    }
    results.sections.create = create;
  }

  // ======================= 3. 电影参考 =======================
  if (SECTION === "all" || SECTION === "film") {
    console.log("\n======================= 电影画面参考 =======================");
    await setViewport(VIEWPORTS[0]);
    await goto("#shoot", "!!document.querySelector('.shoot-film-refs')");
    await settleImages(evalJs, "'.shoot-film-refs'", "'.shoot-film-refs .film-ref-card'");
    const wall = await evalJs(`(() => {
      const blocks = [...document.querySelectorAll('.shoot-film-refs')];
      const cards = [...document.querySelectorAll('.shoot-film-refs .film-ref-card')];
      return {
        blocks: blocks.length,
        cards: cards.length,
        decoded: cards.filter((c) => { const i = c.querySelector('img'); return i && i.naturalWidth > 0; }).length,
        broken: cards.filter((c) => { const s = c.querySelector('.img-slot'); return s && s.classList.contains('is-broken'); }).length,
        sample: cards.slice(0, 3).map((c) => c.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60)),
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    })()`);
    results.sections.filmWall = wall;
    check("SHOOT 电影参考墙只有一块（不再重复渲染两遍）", wall.blocks === 1, JSON.stringify({ blocks: wall.blocks }));
    check("SHOOT 电影参考以画面呈现且真实解码", wall.cards >= 12 && wall.decoded === wall.cards && wall.broken === 0, JSON.stringify({ cards: wall.cards, decoded: wall.decoded, broken: wall.broken }));
    check("SHOOT 电影参考卡带导演与年份说明", wall.cards > 0 && wall.sample.some((s) => /导演/.test(s)), JSON.stringify(wall.sample));
    await shot("shoot-film-refs-desktop");

    const stills = await evalJs(`(async () => {
      const m = await import('/src/data/filmStills.js');
      return m.filmStills.map((f) => ({ id: f.id, titleZh: f.titleZh, year: f.year, director: f.director, file: f.image.fileName, credit: f.source.credit || null, license: f.source.licenseShortName, rights: f.source.rightsCategory || null, url: f.source.url }));
    })()`);
    check("电影画面记录数达到 12–24 张目标区间", Array.isArray(stills) && stills.length >= 12 && stills.length <= 24, JSON.stringify({ n: Array.isArray(stills) ? stills.length : stills }));
    const badRights = (stills || []).filter((s) => !s.url || !/commons\.wikimedia\.org/.test(s.url) || !s.license || !s.director || !s.year || !s.file);
    check("每一帧都有片名/年份/导演/文件/来源链接/许可", badRights.length === 0, JSON.stringify(badRights.slice(0, 3)));
    const noPublishStill = (stills || []).filter((s) => !/Public domain/.test(s.license || ""));
    check("每一帧的许可都是公共领域（无 CC/授权宣传物料混入）", noPublishStill.length === 0, JSON.stringify(noPublishStill.map((s) => `${s.id}:${s.license}`).slice(0, 4)));

    // 本轮审计的硬约束：图像性质必须标注、来源描述必须存在、VisualIntent 只允许
    // 使用统一词表里的枚举值（旧记录里的 elevated / close / PERSON_ONLY 就是反例）。
    const kinds = await evalJs(`(async () => {
      const m = await import('/src/data/filmStills.js');
      return m.filmStills.map((f) => ({ id: f.id, kind: f.imageKind || null, desc: Boolean(f.source && f.source.description), intended: Boolean(f.visualIntent && f.visualIntent.emotion && f.visualIntent.atmosphere) }));
    })()`);
    const KIND_OK = ["frame", "scene-still", "publicity-still", "publicity-photo"];
    const badKind = (kinds || []).filter((r) => !KIND_OK.includes(r.kind));
    check("每一帧都标注了图像性质（frame / scene-still / publicity-*）", (kinds || []).length > 0 && badKind.length === 0, JSON.stringify(badKind.slice(0, 4)));
    const badDesc = (kinds || []).filter((r) => !r.desc || !r.intended);
    check("每一帧都带来源描述原文与独立 VisualIntent", badDesc.length === 0, JSON.stringify(badDesc.slice(0, 4)));
    const vocabBad = await evalJs(`(async () => {
      const { SHOOT_FIELDS } = await import('/src/services/shootTranslation.js');
      const m = await import('/src/data/filmStills.js');
      const bad = [];
      for (const f of m.filmStills) {
        for (const [k, v] of Object.entries(f.visualIntent || {})) {
          if (!SHOOT_FIELDS[k] || !Array.isArray(SHOOT_FIELDS[k])) continue;
          if (!SHOOT_FIELDS[k].includes(v)) bad.push(f.id + '.' + k + '=' + v);
        }
      }
      return bad;
    })()`);
    check("所有帧的 VisualIntent 只用统一词表枚举值", Array.isArray(vocabBad) && vocabBad.length === 0, JSON.stringify((vocabBad || []).slice(0, 6)));
    check("明星明信片 film-s07-brunhilde 已移除（不再冒充电影画面）", (stills || []).every((s) => s.id !== "film-s07-brunhilde"), "");
    await goto("#shoot/film-toll-of-the-sea", "!!document.querySelector('.shoot-detail')");
    const shootRef = await evalJs(`(() => { const t = document.querySelector('.mode-content')?.innerText?.replace(/\\s+/g, ' ') || ''; const i = document.querySelector('.shoot-detail img'); return { guide: /拍人|拍景|人物与环境/.test(t), imgOk: Boolean(i && i.naturalWidth > 0), head: t.slice(0, 120) }; })()`);
    check("电影画面可进入 SHOOT 参考页并给出拍摄指导", shootRef.guide && shootRef.imgOk, JSON.stringify(shootRef));
    await shot("shoot-ref-film-desktop");

    // 每张画面详情页：图片真实解码 + 元数据齐全
    let detailOk = 0;
    const detailBad = [];
    for (const s of stills || []) {
      await goto(`#film/${s.id}`, "!!document.querySelector('.film-still-page img')", 12000);
      await evalJs("document.querySelector('.film-still-page')?.scrollIntoView({ block: 'start' })");
      let decoded = false;
      for (let i = 0; i < 16; i++) {
        decoded = await evalJs("(() => { const i = document.querySelector('.film-still-page img'); return Boolean(i && i.naturalWidth > 0); })()");
        if (decoded === true) break;
        await sleep(400);
      }
      const meta = await evalJs("(() => { const page = document.querySelector('.film-still-page'); const img = page ? page.querySelector('img') : null; const dts = [...(page ? page.querySelectorAll('dt') : [])].map((d) => d.textContent.trim()); const dds = [...(page ? page.querySelectorAll('dd') : [])].map((d) => d.textContent.trim()); const rows = {}; dts.forEach((k, i) => { rows[k] = dds[i] || ''; }); const a = page ? page.querySelector('dd a') : null; return { decoded: Boolean(img && img.naturalWidth > 0), rows, sourceHref: a ? a.getAttribute('href') || '' : '' }; })()");
      const rows = meta.rows || {};
      const okMeta = Boolean(
        rows["导演"] &&
          rows["年份"] &&
          rows["许可"] &&
          rows["来源"] &&
          rows["图像性质"] &&
          /commons\.wikimedia\.org/.test(meta.sourceHref || "") &&
          rows["年份"].includes(String(s.year))
      );
      if (meta.decoded && okMeta) detailOk++;
      else detailBad.push({ id: s.id, decoded: meta.decoded, meta: okMeta, href: meta.sourceHref || "", rows: Object.keys(rows).length });
    }
    check(`每个电影画面详情页都能真实解码且元数据齐全（${detailOk}/${(stills || []).length}）`, detailOk === (stills || []).length && (stills || []).length > 0, JSON.stringify(detailBad.slice(0, 4)));
    await shot("film-detail-sample");

    // FIND 里电影画面能被检索到（视觉检索池包含新帧）
    await goto("#find", "!!document.querySelector('#find-text')");
    await evalJs("(() => { document.querySelector('[data-find-media=\"film\"]')?.click(); const t = document.querySelector('#find-text'); t.value = '夜晚 冷色调'; document.querySelector('#find-run').click(); return 1; })()");
    await waitFor("!!document.querySelector('#find-results .find-hit')", 15000);
    await settleImages(evalJs, "'#find-results'", "'#find-results .find-hit'");
    const filmFind = await evalJs(`(() => {
      const hits = [...document.querySelectorAll('#find-results .find-hit')];
      const films = hits.filter((h) => /#film\\//.test(h.innerHTML) || /电影画面/.test(h.textContent));
      return { hits: hits.length, films: films.length, firstFilmDecoded: films.slice(0, 1).map((h) => { const i = h.querySelector('img'); return i ? i.naturalWidth : -1; })[0] ?? null, overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);
    results.sections.filmFind = filmFind;
    check("「仅电影画面」检索能返回电影结果", filmFind.hits > 0 && filmFind.films > 0, JSON.stringify(filmFind));
    await shot("find-film-mode");
  }

  // ======================= 5. 回归 =======================
  if (SECTION === "all" || SECTION === "regress") {
    console.log("\n======================= 回归 =======================");
    for (const vp of VIEWPORTS) {
      await setViewport(vp);
      // 注意每条都是 `!!`：单 `!` 表达的是「元素不存在时为真」，waitFor 会一直等
      // 元素消失，18 条路由用例会假失败。
      for (const [hash, sel] of [["#index", "!!document.querySelector('.album-wall .plate')"], ["#find", "!!document.querySelector('#find-text')"], ["#create", "!!document.querySelector('#create-picks button')"], ["#shoot", "!!document.querySelector('.drop-zone, .primary-action')"], ["#memory", "!!document.querySelector('.memory-page')"], ["#artwork/local:pearl", "!!document.querySelector('.artwork-page, .art-page, main')"]]) {
        const mounted = await goto(hash, sel, 12000);
        const over = await evalJs("document.documentElement.scrollWidth > document.documentElement.clientWidth");
        check(`${vp.name} ${hash} 正常渲染且无横向溢出`, mounted === true && over === false, JSON.stringify({ mounted, over }));
      }
    }
    // FIND 名称命中（上一轮的成果）不能被本轮改动破坏
    await setViewport(VIEWPORTS[0]);
    await goto("#find", "!!document.querySelector('#find-text')");
    await evalJs("(() => { const t = document.querySelector('#find-text'); t.value = '戴珍珠耳环的少女'; document.querySelector('#find-run').click(); return 1; })()");
    await waitFor("!!document.querySelector('#find-name-hits .find-name-hit')", 12000);
    await settleImages(evalJs, "'#find-name-hits'", "'#find-name-hits .find-name-hit'");
    // 命中卡是 lazy 图片：settle 之后再轮询一小段，避免把「刚开始下载」读成解码失败。
    for (let i = 0; i < 12; i++) {
      const w = await evalJs("(() => { const i = document.querySelector('#find-name-hits .find-name-hit img'); return i ? i.naturalWidth : 0; })()");
      if (typeof w === "number" && w > 0) break;
      await sleep(300);
    }
    const nameHits = await evalJs(`(() => {
      const block = document.querySelector('#find-name-hits');
      const card = block?.querySelector('.find-name-hit');
      const img = card?.querySelector('img');
      return {
        hidden: block ? block.hidden : null,
        title: block?.querySelector('.find-name-block-title')?.textContent?.trim() || block?.querySelector('h3')?.textContent?.trim() || null,
        cards: block ? block.querySelectorAll('.find-name-hit').length : 0,
        firstDecoded: img ? img.naturalWidth : 0,
        firstHref: card?.getAttribute('href') || null,
        visualHits: document.querySelectorAll('#find-results .find-hit').length,
      };
    })()`);
    results.sections.nameHits = nameHits;
    check("名称命中区仍在且命中唯一一件", nameHits.hidden === false && nameHits.cards === 1 && nameHits.firstHref === "#artwork/local:pearl", JSON.stringify(nameHits));
    check("名称命中卡图片真实解码", nameHits.firstDecoded > 0, JSON.stringify({ naturalWidth: nameHits.firstDecoded }));
    await shot("find-name-hit-after-round3");
    check("全程无 JS 异常", jsErrors.length === 0, jsErrors.slice(0, 4).join(" | "));
  }

  writeFileSync(join(OUTDIR, `round3-${SECTION}.json`), JSON.stringify({ results, failures, pass, fail }, null, 2));
  console.log(`\n===== R3(${SECTION}) ${LABEL}: ${pass}/${pass + fail} PASS, ${fail} FAIL =====`);
  if (failures.length) for (const f of failures) console.log(`  FAIL ${f.n} — ${f.d}`);
  try { await browserConn.send("Browser.close"); } catch {}
  edge.kill();
}

// 只用于本地核对 Markdown 内容（不引入 src 模块，保持脚本独立）
function promptExportMd(payload) {
  const lines = ["# CREATE Prompt 导出"];
  lines.push("## Prompt", payload.prompt.text);
  lines.push("## 当前 VisualIntent");
  if (payload.visualIntent) for (const [k, v] of Object.entries(payload.visualIntent)) lines.push(`- ${k}: ${Array.isArray(v) ? v.join(" / ") : v}`);
  else lines.push("- 无（直接进入 CREATE，本次 Prompt 走静态路径）");
  return lines.join("\n");
}

main().catch((e) => {
  console.log("FATAL", e.message);
  process.exit(1);
});
