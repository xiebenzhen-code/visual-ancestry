(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { errors: [] };
  window.addEventListener("error", (e) => out.errors.push(String(e.message).slice(0, 120)));
  await sleep(1200);

  out.title = document.title;
  out.hash = location.hash;
  out.navLabels = [...document.querySelectorAll(".main-nav a")].map((a) => a.textContent.trim());
  out.skin = document.documentElement.dataset.skin;
  out.hasLegacyHero = /你在找什么样的画面/.test(document.body.textContent);
  out.hasFiveEntryNav = [...document.querySelectorAll(".main-nav a")].length === 5;
  out.placeholder = document.querySelector("#find-text")?.getAttribute("placeholder") || null;
  out.mediaLabels = [...document.querySelectorAll("[data-find-media]")].map((b) => b.textContent.trim());
  out.plates = document.querySelectorAll(".plate").length;
  out.searchAboveWall = (() => {
    const s = document.querySelector(".album-search");
    const w = document.querySelector(".album-wall");
    if (!s || !w) return "missing";
    return s.getBoundingClientRect().top < w.getBoundingClientRect().top ? "yes" : "no";
  })();

  for (let i = 0; i < 60; i++) {
    const im = [...document.querySelectorAll('.album-wall img')];
    if (im.length && im.every((x) => x.complete)) break;
    await sleep(500);
  }
  // 图片真的解码了吗（不是「DOM 里有 img」）
  const imgs = [...document.querySelectorAll(".album-wall img")];
  out.wallImages = imgs.length;
  out.wallDecoded = imgs.filter((i) => i.naturalWidth > 0).length;
  out.wallBroken = [...document.querySelectorAll(".album-wall .img-slot")].filter((s) => s.classList.contains("is-broken")).length;

  // 搜索原位出结果（不换路由）
  const input = document.querySelector("#find-text");
  input.value = "孤独 夜晚";
  document.querySelector("#album-search").dispatchEvent(new Event("submit", { cancelable: true }));
  const beforeHash = location.hash;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (document.querySelector("#album-results") && !document.querySelector("#album-results").hidden) break;
  }
  out.hashAfterSearch = location.hash;
  out.noRouteChange = beforeHash === location.hash;
  out.wallHidden = document.querySelector("#album-wall-wrap")?.hidden === true;
  out.resultsVisible = document.querySelector("#album-results")?.hidden === false;
  out.hits = document.querySelectorAll("#find-results .find-hit").length;
  out.nameHits = document.querySelectorAll("#find-name-hits .find-name-hit").length;
  out.remoteText = (document.querySelector("#find-remote")?.textContent || "").replace(/\s+/g, " ").slice(0, 120);

  // 点击第一件作品 → 详情侧栏
  const hit = document.querySelector("#find-results .find-hit[data-hit-key]") || document.querySelector(".plate[data-plate-key]");
  out.detailTriggerFound = Boolean(hit);
  if (hit) {
    const scrollBefore = window.scrollY;
    hit.click();
    await sleep(700);
    const panel = document.querySelector(".work-panel");
    out.panelOpen = Boolean(panel && !panel.hidden);
    out.panelHasImage = Boolean(panel?.querySelector(".work-panel-figure img"));
    out.panelImageDecoded = (panel?.querySelector(".work-panel-figure img")?.naturalWidth || 0) > 0;
    out.panelActions = [...(panel?.querySelectorAll(".work-panel-actions a, .work-panel-actions button") || [])].map((b) => b.textContent.trim());
    out.panelFacts = (panel?.querySelector(".work-panel-body")?.textContent || "").replace(/\s+/g, " ").slice(0, 90);
    out.deepLinkStillPresent = Boolean(hit.getAttribute("href")?.startsWith("#artwork/"));
    // 关闭后回原位
    panel?.querySelector("[data-panel-close]")?.click();
    await sleep(400);
    out.panelClosed = panel?.hidden === true;
    out.scrollRestored = window.scrollY === scrollBefore;
    out.resultsStillVisible = document.querySelector("#album-results")?.hidden === false;
    out.inputKeptQuery = document.querySelector("#find-text")?.value;
  }
  out.errors = out.errors.slice(0, 5);
  return out;
})()