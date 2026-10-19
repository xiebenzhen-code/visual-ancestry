// FIND: text, local image, or an existing artwork. Retrieval explains itself.
import { setRouteActive } from "../app/events.js";
import { artworks } from "../data/artworks.js";
import {
  retrieveByText,
  retrieveByImage,
  retrieveByArtwork,
  intentSummary,
  intentForArtwork,
  provenanceForArtwork,
  provenanceLabel,
  INTENT_PROVENANCE,
} from "../services/retrieval/retrievalService.js";
import { probeVisionStatus } from "../services/vision/visionService.js";
import { findRemoteReferences } from "../services/retrieval/remoteReferences.js";
import { allSignatures } from "../services/retrieval/colorIndex.js";
import { analyzeImageSignatureInBrowser, colorComparability } from "../services/retrieval/colorSignatureBrowser.js";
import { renderRemoteFilmCard, bindFilmRemoteActions } from "../components/remoteFilmCard.js";
import { beginTask, recordReference } from "../utils/taskContext.js";
import { renderImg, bindImgFallback, aspectRatioCss, PICK_SIZES } from "../utils/image.js";
import { escapeHtml } from "../utils/html.js";
import { curateHomepage } from "../services/homepageCurator.js";
import { bindWorkPanel } from "../components/workPanel.js";
import { matchNames, namePool } from "../utils/nameMatch.js";

const EXAMPLE = "一个人站在很大的空间里，感觉很远，但不是悲伤。";

// 首页 hero 搜索框 → FIND 的参数传递通道。刻意走 sessionStorage 而不是把查询
// 塞进 hash：路由形状（#find）与既有滚动记忆/深链行为保持完全不变，只多了一条
// 「首页把用户已输入的查询与媒介选择交过来」的通道。
export const FIND_HANDOFF_KEY = "fa-find-handoff";

// 一次性读取。缺失、损坏、或枚举越界一律退回默认值——FIND 的行为不依赖调用方。
function readFindHandoff() {
  const fallback = { q: "", media: "all" };
  try {
    const raw = sessionStorage.getItem(FIND_HANDOFF_KEY);
    if (!raw) return fallback;
    sessionStorage.removeItem(FIND_HANDOFF_KEY);
    const parsed = JSON.parse(raw);
    const media = ["all", "artwork", "film"].includes(parsed?.media) ? parsed.media : "all";
    return { q: typeof parsed?.q === "string" ? parsed.q.trim() : "", media };
  } catch {
    return fallback;
  }
}

// RC-2: the intent behind "find works like this one". The cache-then-rule
// lookup itself now lives in retrievalService (R5 STEP 3) so the intent and the
// provenance label shown next to it can never come from two different copies
// of the rule. No new similarity logic: retrieveByArtwork() still does the
// scoring.
function artworkIntentFor(artwork) {
  return intentForArtwork(artwork);
}

// “为什么推荐这些？” is the ONLY optional disclosure — short summary above
// results, shared reasons inside the existing disclosure. No JSON, no field-dump.
// R5 STEP 3 — medium-aware helpers. A film still must never be presented with
// painting vocabulary: the creator is a DIRECTOR, and the card links to the film
// record rather than pretending to be a painting detail page.
function isFilm(item) {
  return (item && (item.medium === "film" || item.artwork?.medium === "film")) || false;
}

function hrefFor(item) {
  return isFilm(item) ? `#film/${item.artwork.key}` : `#artwork/${item.artwork.key}`;
}

function creatorLabel(artwork) {
  return artwork.medium === "film"
    ? `导演 ${artwork.film.directorZh || artwork.film.director}`
    : artwork.artist;
}

function creditLine(item) {
  if (!isFilm(item)) return "";
  const f = item.artwork.film;
  const r = f.rights;
  return `<small class="find-film-credit">${escapeHtml(f.titleZh)}（${escapeHtml(String(f.year))}）· 导演 ${escapeHtml(
    f.directorZh || f.director
  )} · ${escapeHtml(r.licenseShortName)}</small>`;
}

// 「名称命中」区。与本地视觉结果分开展示，理由和远程区段一样是**依据不同**：
// 这里只做了名称文本比对，没有 VisualIntent 评分，也不含任何视觉相似度。
//
// 同一作品若已经出现在视觉结果里就不再重复占一张卡（同一件东西不该出现两次），
// 但会把件数如实写出来——不把重复算成「额外命中」，也不假装它没命中。
function renderNameHits(query, media, visualResults) {
  const matches = matchNames(namePool(media), query);
  if (!matches.length) return { html: "", count: 0, shown: 0, overlap: 0 };
  const visualKeys = new Set((visualResults || []).map((item) => item.artwork.key));
  const overlap = matches.filter((match) => visualKeys.has(match.artwork.key));
  const shown = matches.filter((match) => !visualKeys.has(match.artwork.key));
  const cards = shown
    .map(
      (match) => `
        <a class="find-name-hit" data-hit-key="${escapeHtml(match.artwork.key)}" data-ref-key="${escapeHtml(match.artwork.key)}" href="${escapeHtml(hrefFor(match))}">
          <span style="${aspectRatioCss(match.artwork)}">${renderImg(match.artwork)}</span>
          <div>
            <strong>${escapeHtml(match.artwork.titleZh || match.artwork.title)}</strong>
            <em>${escapeHtml(creatorLabel(match.artwork))}</em>
            ${creditLine(match)}
            <small class="find-name-tier">${match.tier === "exact" ? "完整名称" : "名称包含"} · 命中${escapeHtml(
              match.label
            )}「${escapeHtml(match.value)}」</small>
          </div>
        </a>`
    )
    .join("");
  const notes = [
    "匹配规则：完整名称优先，其次是名称包含；不做字符重叠、拼音或语义猜测。",
    overlap.length ? `另有 ${overlap.length} 件名称同样命中，已在上方视觉结果中，未重复展示。` : "",
  ]
    .filter(Boolean)
    .join("");
  return {
    html: `
      <section class="find-name-block">
        <h2 class="find-name-title">名称命中 · 非视觉相似度评分</h2>
        <p class="quiet-note">${escapeHtml(notes)}</p>
        ${shown.length ? `<div class="find-name-grid">${cards}</div>` : ""}
      </section>`,
    count: matches.length,
    shown: shown.length,
    overlap: overlap.length,
  };
}

// FIND 页面实例序列。**必须在模块作用域**：renderFind() 每次被 router 调用
// 都重建整个页面 DOM，只有跨挂载保持的自增序列才能区分「这是第几次进入」。
// 放在函数体内会每次重置，实例号恒为 1，守卫失效。
let FIND_ACTIVE_INSTANCE = 0;

// 首页媒介四档。动画是真实筛选值：MEDIA.ANIMATION 会在本地档案里筛出 0 件，
// 因此结果区必须给出「这一档还没有素材」的说明，而不是空白。
const ALBUM_MEDIA = [
  { value: "all", label: "全部" },
  { value: "artwork", label: "绘画" },
  { value: "film", label: "电影" },
  { value: "animation", label: "动画" },
];

// 图片墙。图像占主要视觉面积，图注在图下方而不是压在图上；
// href 保留深链（#artwork/<key>），点击被 workPanel 拦截后才改成侧栏。
function albumWallHtml(count) {
  const works = curateHomepage(count);
  return `
    <div class="album-wall">
      ${works
        .map(
          (artwork, index) => `
        <a class="plate" href="#artwork/${escapeHtml(artwork.key)}"
           data-plate-key="${escapeHtml(artwork.key)}"
           aria-label="${escapeHtml(artwork.titleZh || artwork.title)}">
          <figure>
            ${renderImg(artwork, { priority: index < 4 })}
            <figcaption class="plate-info">
              <strong>${escapeHtml(artwork.artistZh || artwork.artist || "")}</strong>
              <span>${escapeHtml(artwork.titleZh || artwork.title)}</span>
              <em>${escapeHtml(String(artwork.year || ""))}</em>
            </figcaption>
          </figure>
        </a>`
        )
        .join("")}
    </div>`;
}

export function renderFind(app, { asHome = false } = {}) {
  setRouteActive(asHome ? "index" : "find");
  // 首页交过来的查询与媒介选择。只影响「初始值」：输入框内容、哪个媒介按钮
  // 处于选中态、以及接线完成后是否立刻检索一次。检索路径仍然是 runSearch。
  const handoff = readFindHandoff();
  const picks = artworks.filter((artwork) => artwork.image && !artwork.imageUnavailable).slice(0, 8);
  const wallHtml = albumWallHtml(20);
  // 与 CREATE 同一个参考墙网格：候选宽度契约统一放在 utils/image.js 的
  // PICK_SIZES，避免手机端按 96vw 去取 1920px 的 detail 档。
  app.innerHTML = `
    <section class="find-page">
      ${asHome
        ? `<header class="album-head">
            <h1 class="album-title">参考</h1>
            <p class="album-sub">搜索作品与电影画面，或描述你要找的视觉感觉：色彩、氛围、构图、光线。</p>
          </header>
          <form class="album-search" id="album-search" role="search" autocomplete="off">
            <input id="find-text" class="album-input" type="search" name="q"
              placeholder="搜索作品、电影、色彩、氛围…"
              aria-label="搜索作品、电影、色彩、氛围" />
            <button class="album-run" type="submit" id="find-run">搜索</button>
          </form>
          <div class="album-search-row">
            <span class="album-field-label">媒介</span>
            ${ALBUM_MEDIA.map(
              (choice) => `<button type="button" class="${handoff.media === choice.value ? "is-on" : ""}"
                data-find-media="${choice.value}">${choice.label}</button>`
            ).join("")}
          </div>
          <div class="album-search-row">
            <span class="album-field-label">方式</span>
            <button type="button" class="is-on" data-find-mode="text">文字描述</button>
            <button type="button" data-find-mode="image">上传图片</button>
            <button type="button" data-find-mode="artwork">选已有作品</button>
          </div>
          <div data-find-panel="text" hidden></div>
          <div data-find-panel="image" hidden>
            <label class="drop-zone" id="find-drop">
              把图片拖到这里，或点击选择。图片只在本地预览。
              <input id="find-file" type="file" accept="image/*" hidden />
            </label>
            <img id="find-preview" alt="" hidden />
            <div id="find-image-progress" class="find-image-progress" hidden><span>正在理解画面…</span></div>
            <div id="find-image-error" class="find-image-error" hidden></div>
            <button class="album-run" type="button" id="find-image-run" hidden>分析这张图并找参考</button>
            <button class="ghost-action" type="button" id="find-image-to-text" hidden>改用文字描述</button>
          </div>
          <div data-find-panel="artwork" hidden>
            <div class="find-picks">
              ${picks
                .map(
                  (artwork) => `<button type="button" data-find-art="${escapeHtml(artwork.key)}">
                    <span style="${aspectRatioCss(artwork)}">${renderImg(artwork, { sizes: PICK_SIZES })}</span>
                    <em>${escapeHtml(artwork.titleZh || artwork.title)}</em></button>`
                )
                .join("")}
            </div>
          </div>
          <div class="album-wall-wrap" id="album-wall-wrap">${wallHtml}</div>
          <div class="album-results" id="album-results" hidden>
            <p class="album-results-note quiet-note" id="album-results-note"></p>
            <button class="ghost-action" type="button" id="album-clear">回到图片墙</button>
          </div>`
        : `<p class="kicker">FIND</p>
          <h1>你在找什么样的画面？</h1>`}


      ${asHome
        ? ""
        : `<div data-find-panel="text">
          <textarea id="find-text" class="workflow-input" placeholder="${escapeHtml(EXAMPLE)}">${escapeHtml(handoff.q || EXAMPLE)}</textarea>
          <button class="primary-action" type="button" id="find-run">查找视觉关系</button>
        </div>`}


      <div id="find-intent"></div>
      <!-- 名称命中独立成区：依据是名称文本比对，不是视觉相似度评分。默认隐藏，
           没有名称命中时不占任何空间、也不留空白说明。 -->
      <div id="find-name-hits" class="find-name-hits" hidden></div>
      <div id="find-results" class="find-results"></div>
      <div id="find-remote" class="find-remote-host"></div>
    </section>
  `;
  bindImgFallback(app);

  // SHOOT may hand over a one-line reading of a local photo it already analyzed.
  const bridged = sessionStorage.getItem("fa-vision-summary");
  if (bridged) {
    sessionStorage.removeItem("fa-vision-summary");
    const imageMode = [...app.querySelectorAll("[data-find-mode]")].find((b) => b.dataset.findMode === "image");
    if (imageMode) imageMode.click();
    app.querySelector("#find-intent").innerHTML = `
      <section class="intent-card intent-card-image">
        <h2>看到的画面</h2>
        <p class="vision-summary">${escapeHtml(bridged)}</p>
        <p class="quiet-note">这一段来自${escapeHtml(provenanceLabel(INTENT_PROVENANCE.LIVE))}：SHOOT 刚刚用真实识图服务解析过同一张本地图片；重新选择图片可再次分析。</p>
      </section>
    `;
  }

  const panels = [...app.querySelectorAll("[data-find-panel]")];
  app.querySelectorAll("[data-find-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      app.querySelectorAll("[data-find-mode]").forEach((item) => item.classList.toggle("is-on", item === button));
      panels.forEach((panel) => {
        panel.hidden = panel.dataset.findPanel !== button.dataset.findMode;
      });
      // 切换输入模式即作废所有在途远程响应：远程渠道只服务于文字描述模式，
      // 图片/作品模式下其结果既不该出现也不该稍后补写。
      activeMode = button.dataset.findMode;
      searchToken++;
      clearRemote();
    });
  });

  // R5 STEP 3 — medium filter. Films are few (3) and paintings many (46), so a
  // pure score sort can leave every film out of a top-6. The filter is the
  // honest control: it narrows the POOL, then the same unmodified scorer ranks
  // what is left. Ranking is never bent to guarantee a film appears.
  let activeMedia = handoff.media;

  // 本地检索同步、远程渠道异步，两者分开跑：本地结果立即上屏，不被远程
  // 网络延迟阻塞。远程完成后只补写 #find-remote 区段，不重绘本地列表、
  // 不再调用 beginTask()。
  //
  // ============ 异步生命周期三重守卫 ============
  // router 每次进 #find 都调用一次 renderFind(app)，会重建整个页面 DOM。
  // 旧实例的 in-flight 请求返回时，其闭包仍持有旧 DOM 引用——若只看
  // `app.isConnected` 会漏判：旧 app 节点被 innerHTML 覆盖后可能仍在文档中
  // （被替换而非移除），isConnected 为 true，于是旧响应就写进了新页面。
  //
  // 因此响应合法性必须同时满足四条，缺一不可：
  //   1. 查询令牌仍有效（本实例内没有更新的检索）
  //   2. 当前模式仍是文字检索
  //   3. 页面实例号仍有效（没有重新进入 FIND）
  //   4. 当前 .find-page 根节点仍是发起请求时的那个节点
  // 四条合起来见下方 instanceAlive()。
  let searchToken = 0;
  let activeMode = "text";

  // ============ 页面实例守卫 ============
  //
  // MEASURED 缺陷（本轮修掉）：`FIND_ACTIVE_INSTANCE` 原先声明在
  // renderFind() **函数体内**，每次挂载都重置为 0，于是 instanceId 恒为 1、
  // instanceAlive() 恒为 true —— 实例守卫形同虚设，旧实例的远程响应照样
  // 写进新页面。移到模块作用域后序列跨挂载保持，才能真正区分两次进入。
  //
  // 本页 DOM 根节点：renderFind 由 router 调用时会整体重建 app.innerHTML，
  // 这里抓到的 root 就是本次挂载独有的节点引用。重新进入 FIND 会得到一个新
  // 节点，即使实例号因某种原因没变，根节点比对也能兜住。
  const pageRoot = app.querySelector(".find-page");
  const instanceId = ++FIND_ACTIVE_INSTANCE;
  // 把本次实例号写到根节点上，便于对抗测试与调试时直接观测。
  if (pageRoot) pageRoot.dataset.findInstance = String(instanceId);

  // 实例有效性：只回答「这次挂载是否还是当前页面」。**刻意不含模式判断**。
  // MEASURED（回归教训）：曾把 activeMode==="text" 折进这里，结果切到图片
  // 模式时 clearRemote() 被自己挡掉，旧查询的「正在检索」留在图片模式页面上
  // ——与上轮 B2 失败同源，只是换了入口。实例有效性与模式有效性是两件事，
  // 必须分开表达，否则「清空」这类操作会被模式守卫误伤。
  const instanceAlive = () =>
    FIND_ACTIVE_INSTANCE === instanceId &&
    Boolean(pageRoot) &&
    pageRoot.isConnected === true &&
    app.querySelector(".find-page") === pageRoot;

  // 清空远程区段。只校验实例（不校验模式）：切模式时 activeMode 已被改成
  // image/artwork，此时正需要清空，若再判模式就会把自己挡掉。
  const clearRemote = () => {
    if (!instanceAlive()) return;
    const host = app.querySelector("#find-remote");
    if (host) host.innerHTML = "";
  };

  // 写入远程区段。在实例有效之上再要求文字模式：远程渠道只服务文字描述，
  // 图片/作品模式下其结果既不该出现也不该稍后补写。
  // 最近一次远程渠道结果。排除操作要真正改变**当前**结果集，就不能只把卡片
// display:none 或只写一条记录 —— 必须拿这份数据重新渲染。
let lastRemote = null;
  const paintRemote = (html) => {
    if (!instanceAlive() || activeMode !== "text") return;
    const host = app.querySelector("#find-remote");
    if (!host) return;
    host.innerHTML = html;
    // 远程候选的图来自外站，必须挂上回退/超时处理。
    // MEASURED：这条路径（paintRemote）原先没调 bindImgFallback，于是远程电影卡
    // 加载失败时既不换档也不标记 —— 卡片上留着 naturalWidth=0 的空图位，
    // 界面却什么都不显示，看起来像「还在加载」。实测 6 张里有 3 张是这种状态。
    bindImgFallback(app);
    // STEP 4：电影候选的四个动作。排除必须真正改变**当前**结果集（重新渲染），
    // 而不是只写一条记录、把卡片 display:none 了事。
    bindFilmRemoteActions(app, {
      onExcluded: (sourceId) => {
        if (!lastRemote) return;
        // 排除列表以 corrections.excluded 为准（那是渠道返回的真实字段名）。
        // 实测踩过：这里原先读的是不存在的 excludedIds，于是第二次排除时计数
        // 又从 1 开始 —— 连续排除两件，界面却说「已排除 1 件」。
        const filmData = lastRemote.film || {};
        const corr = filmData.corrections || {};
        const prev = Array.isArray(corr.excluded) ? corr.excluded : [];
        const excluded = prev.includes(sourceId) ? prev : [...prev, sourceId];
        const next = {
          ...lastRemote,
          results: lastRemote.results.filter(
            (item) => item.medium !== "film" || item.artwork.remote?.sourceId !== sourceId
          ),
          film: { ...filmData, corrections: { ...corr, excluded, excludedCount: excluded.length } },
        };
        lastRemote = next;
        paintRemote(renderRemoteSection(next));
      },
    });
  };

  // 名称命中区的唯一写入口。沿用与远程区段同一条实例守卫：旧实例不得写入新页面。
  // 只校验实例、不校验模式，理由同 clearRemote()——切模式时正需要把它清掉。
  // 空查询 = 清空：名称区只在「这次查询真的撞上了名称」时出现，不留空壳。
  const paintNameHits = (query, media, visualResults) => {
    if (!instanceAlive()) return null;
    const host = app.querySelector("#find-name-hits");
    if (!host) return null;
    const outcome = query ? renderNameHits(query, media, visualResults) : { html: "", count: 0, shown: 0, overlap: 0 };
    host.innerHTML = outcome.html;
    host.hidden = !outcome.html;
    if (outcome.html) {
      bindImgFallback(app);
      bindReferencePicks(app);
    }
    return outcome;
  };

  const runSearch = async (query, media, extraNote = "") => {
    if (!query) return;
    const token = ++searchToken;
    // P4.4 — 启用缺失值感知排序 + 色彩/多样性重排。
    // querySig 为 null（文本查询没有自己的像素），色彩项不参与，其余增强生效。
    const { intent, results, resultBasis, emptyReason, queryAnalysis } = retrieveByText(query, {
      limit: 6,
      media,
      enhanced: { signatures: allSignatures(), querySig: null },
    });
    // 本地先出结果：这一步是新任务，必须 beginTask。
    // P4.4 — 结果依据与空结果原因一并交给渲染，避免「空且无解释」。
    const basisNote = !results.length && emptyReason ? emptyReason
      : resultBasis === "text-metadata" ? "以下为馆藏元数据的文本匹配，不是视觉相似" : extraNote;
    renderOutcome(app, intent, results, basisNote);
    // 名称命中与视觉结果同时上屏（都来自本地数据，没有额外网络等待），
    // 但依据完全不同，所以分区展示。远程区段不受影响，照旧异步补写。
    paintNameHits(query, media, results);
    // 四态之一：加载中。空白且无解释是最差的表现。
    paintRemote(`<section class="find-remote"><p class="quiet-note">正在检索远程渠道…</p></section>`);
    try {
      const remote = await findRemoteReferences(query, { media });
      // 令牌过期 = 本实例内已有更新的检索；实例号过期 = 已重新进入 FIND。
      if (token !== searchToken || !instanceAlive()) return;
  // 留住这次结果：排除操作基于它重渲染，才能真正改变当前结果集。
  lastRemote = remote;
      paintRemote(renderRemoteSection(remote));
    } catch (e) {
      if (token !== searchToken || !instanceAlive()) return;
      // findRemoteReferences 内部已兜底多数渠道错误；到这里是意外。
      // 仍要给出可读状态，不能留空白。
      paintRemote(
        `<section class="find-remote"><p class="quiet-note">远程渠道出错：${escapeHtml(
          String(e?.message || e).slice(0, 80)
        )}。本地检索结果不受影响。</p></section>`
      );
    }
  };

  app.querySelectorAll("[data-find-media]").forEach((button) => {
    button.addEventListener("click", () => {
      activeMedia = button.dataset.findMedia;
      app.querySelectorAll("[data-find-media]").forEach((b) => b.classList.toggle("is-on", b === button));
      runForMedia(app.querySelector("#find-text")?.value.trim());
    });
  });

  // 首页：提交后原位出结果，图片墙让位；关闭结果后回到图片墙。
  // 关键：这里不跳转路由 —— 「减少跳转」的第一条就是搜索不换页面。
  const wallWrap = app.querySelector("#album-wall-wrap");
  const resultsWrap = app.querySelector("#album-results");
  const resultsNote = app.querySelector("#album-results-note");
  const showResults = (note) => {
    if (wallWrap) wallWrap.hidden = true;
    if (resultsWrap) resultsWrap.hidden = false;
    if (resultsNote) resultsNote.textContent = note || "";
  };
  const showWall = () => {
    if (wallWrap) wallWrap.hidden = false;
    if (resultsWrap) resultsWrap.hidden = true;
  };

  const submitSearch = () => {
    const q = app.querySelector("#find-text")?.value.trim();
    if (!q) {
      app.querySelector("#find-text")?.focus();
      return;
    }
    showResults(`正在检索「${escapeHtml(q)}」`);
    runForMedia(q);
  };

  // 「动画」是真筛选值，不是装饰。retrieveByText 对未知 media 会原样返回全部结果，
  // 所以必须在这里挡掉，否则绘画/电影会被当成动画结果展示。
  const runForMedia = (query) => {
    if (activeMedia !== "animation") {
      runSearch(query, activeMedia);
      return;
    }
    showResults("");
    if (resultsNote) {
      resultsNote.innerHTML =
        `<strong>动画这一档还没有素材。</strong>` +
        `<span>本地档案里动画作品 0 件；远程渠道目前只接了绘画与电影画面检索，没有接动画检索。` +
        `与其拿别的东西冒充动画，不如把这句话放在这里。</span>`;
    }
    const results = app.querySelector("#find-results");
    if (results) results.innerHTML = "";
    const nameHits = app.querySelector("#find-name-hits");
    if (nameHits) nameHits.hidden = true;
    const remote = app.querySelector("#find-remote");
    if (remote) remote.innerHTML = "";
  };

  app.querySelector("#album-search")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitSearch();
  });
  app.querySelector("#album-clear")?.addEventListener("click", () => {
    showWall();
    app.querySelector("#find-text")?.focus();
  });

  app.querySelector("#find-run")?.addEventListener("click", () => {
    const input = app.querySelector("#find-text");
    if (asHome && input && !input.closest("#album-search")) submitSearch();
    else runSearch(input?.value.trim(), activeMedia);
  });

  // 图片墙与结果里的作品点击 → 桌面侧栏 / 手机详情层（深链 href 保留不变）。
  bindWorkPanel(app, { root: pageRoot });

  // 首页交过来的查询：接线（含媒介按钮）完成后立刻执行一次，用户不必再点一次。
  // 走的是同一个 runSearch，因此令牌、实例守卫、远程区段行为完全一致。
  if (handoff.q) runSearch(handoff.q, activeMedia);

  // RC-2: the artwork panel used to be a dead control — its buttons carried no
  // handler and the retrieveByArtwork import was never called. A real pick is
  // a new task whose intent is that artwork's own visual intent, so the ranking
  // (done by retrieveByArtwork, unchanged) and any later CREATE step stay
  // consistent with the chosen reference.
  app.querySelectorAll("[data-find-art]").forEach((button) => {
    button.addEventListener("click", () => {
      const artwork = artworks.find((item) => item.key === button.dataset.findArt);
      if (!artwork) return;
      // 选作品是一次新的检索：推进令牌，使仍在途的远程响应失效，
      // 否则先前的远程结果会在用户选完作品后才姗姗来迟地覆盖它。
      searchToken++;
      // 远程区段清空——当前展示的是本地作品关系，不附带渠道发现结果。
      clearRemote();
      const intent = artworkIntentFor(artwork);
      // retrieveByArtwork returns the ranked array itself (unlike
      // retrieveByText, which returns { intent, results }).
      const results = retrieveByArtwork(artwork, { limit: 6 });
      // renderOutcome opens the new task itself: the intent when the search
      // produced results, an intent-less reset when it did not.
      renderOutcome(
        app,
        intent,
        results,
        `以《${artwork.titleZh || artwork.title}》为起点的视觉关系；起点意图取自${provenanceLabel(provenanceForArtwork(artwork))}。`
      );
      // 这是「以作品为起点」的检索，输入框里的文字没有参与，名称区随之清空，
      // 免得把一个不相干的名称命中留在页面上。
      paintNameHits("", activeMedia, []);
      app.querySelector("#find-results")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  // ---------- local image: instant preview, then the same pipeline ----------
  const fileInput = app.querySelector("#find-file");
  const preview = app.querySelector("#find-preview");
  const drop = app.querySelector("#find-drop");
  const runBtn = app.querySelector("#find-image-run");
  const toTextBtn = app.querySelector("#find-image-to-text");
  const progress = app.querySelector("#find-image-progress");
  const errorBox = app.querySelector("#find-image-error");

  let pendingFile = null;

  const showFile = (file) => {
    if (!file) return;
    pendingFile = file;
    if (preview.src?.startsWith("blob:")) URL.revokeObjectURL(preview.src);
    preview.src = URL.createObjectURL(file);
    preview.hidden = false;
    errorBox.hidden = true;
    errorBox.innerHTML = "";
    runBtn.hidden = false;
    toTextBtn.hidden = true;
  };
  fileInput.addEventListener("change", () => showFile(fileInput.files[0]));
  drop.addEventListener("dragover", (event) => event.preventDefault());
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    showFile(event.dataTransfer.files[0]);
  });
  drop.addEventListener("click", () => fileInput.click());

  const findImage = async () => {
    if (!pendingFile) return;
    runBtn.hidden = true;
    toTextBtn.hidden = true;
    errorBox.hidden = true;
    errorBox.innerHTML = "";
    // R1.0 — real availability probe: the image mode is enabled only when the
    // server-side bridge reports a configured provider. When it is not, we
    // fail fast with an accurate unavailable state — never spin on
    // "正在理解画面…" against a bridge that cannot answer.
    const available = await probeVisionStatus();
    if (!available) {
      renderImageFailure(app, "vision-unavailable", errorBox, toTextBtn, "not-configured");
      return;
    }
    progress.hidden = false;
    app.querySelector("#find-intent").innerHTML = "";
    app.querySelector("#find-results").innerHTML = "";
    // 图片检索是另一条路径（真实识图），文字输入没有参与，名称区一并清空。
    paintNameHits("", activeMedia, []);
    // P4.4 — 先从**上传图自己的像素**算色彩签名（浏览器 canvas，非本地资产索引），
    // 再把它作为 querySig 传入检索，使色彩证据真正来自这张新图。
    // 计算失败时 querySig 为 null：色彩项不参与，但检索仍继续，不伪造颜色。
    const querySig = await analyzeImageSignatureInBrowser(pendingFile).catch(() => ({ ok: false }));
    const sigForSearch = querySig && querySig.ok
      ? { ...querySig, origin: "computed-from-uploaded-pixels" }
      : null;

    retrieveByImage(pendingFile, {
      limit: 6,
      enhanced: { signatures: allSignatures(), querySig: sigForSearch },
    })
      .then((outcome) => {
        progress.hidden = true;
        if (!outcome.ok) {
          renderImageFailure(app, outcome.error, errorBox, toTextBtn, outcome.reason);
          return;
        }
        renderImageOutcome(app, pendingFile, outcome);
      })
      .catch(() => {
        progress.hidden = true;
        renderImageFailure(app, "vision-failed", errorBox, toTextBtn, "network");
      });
  };
  runBtn.addEventListener("click", findImage);
  toTextBtn.addEventListener("click", () => {
    const modeButtons = [...app.querySelectorAll("[data-find-mode]")];
    const textMode = modeButtons.find((b) => b.dataset.findMode === "text");
    if (textMode) textMode.click();
    app.querySelector("#find-text").focus();
  });
}

// R5 STEP 5 — one sentence per actual cause.
// The bridge classifies every answer (see visionProvider): auth, rate-limited,
// not-configured, server, timeout, network, invalid-json… Collapsing them into
// one message told a user whose quota was exhausted that "no provider is
// configured", which is both wrong and unactionable. Each branch below names the
// real problem and, where one exists, the real remedy.
const IMAGE_FAILURE_MESSAGES = {
  "unsupported-format": "不支持的图片格式。请换成 JPG / PNG / WEBP。",
  "too-large": "图片太大了（超过 12MB）。",
  "vision-unavailable": "识图服务未启用：这台服务器没有配置识图模型。请改用文字描述继续查找。",
  "not-configured": "识图服务未启用：这台服务器没有配置识图模型。请改用文字描述继续查找。",
  "rate-limited": "识图请求过于频繁，或今日额度已用尽。请稍后再试，或改用文字描述。",
  "budget-exhausted-daily": "今日识图额度已用尽。请明天再试，或改用文字描述。",
  "budget-exhausted-total": "识图总额度已用尽。请改用文字描述。",
  "too-many-in-flight": "当前识图请求过多，请稍后再试。",
  auth: "识图服务拒绝了本次访问（未授权或访问码已失效）。请重新输入访问码。",
  "session-expired": "识图访问会话已过期。请重新输入访问码。",
  "payload-too-large": "图片太大了（服务端上限 6MB）。请换一张小一些的图。",
  timeout: "识图服务响应超时。请稍后再试。",
  network: "无法连接识图服务。请检查网络，或改用文字描述。",
  server: "识图服务暂时不可用。请稍后再试，或改用文字描述。",
};

function renderImageFailure(app, error, errorBox, toTextBtn, reason) {
  const key = reason && IMAGE_FAILURE_MESSAGES[reason] ? reason : error;
  const message =
    IMAGE_FAILURE_MESSAGES[key] ||
    IMAGE_FAILURE_MESSAGES[error] ||
    "识图服务暂不可用。请稍后再试，或改用文字描述。";
  errorBox.textContent = message;
  errorBox.hidden = false;
  toTextBtn.hidden = false;
  app.querySelector("#find-intent").innerHTML = "";
  app.querySelector("#find-results").innerHTML = "";
}

function renderImageOutcome(app, file, outcome) {
  // R1.0-R1: a completed search is a new task — record the intent when the
  // search actually produced results, reset (intent-less) otherwise.
  beginTask(outcome.results.length ? outcome.intent : null);
  // One very short reading line, then results. Optional disclosure holds reasons.
  const summaryLabel = outcome.summary || "";
  app.querySelector("#find-intent").innerHTML = `
    <section class="intent-card intent-card-image">
      <h2>看到的画面</h2>
      ${summaryLabel ? `<p class="vision-summary">${escapeHtml(summaryLabel)}</p>` : `<p class="quiet-note">仅识别出少量结构信息。</p>`}
      <p class="quiet-note">这一段来自${escapeHtml(provenanceLabel(outcome.queryProvenance))}：本次上传的图片刚刚经真实识图服务解析，不是历史缓存，也不是规则推测。</p>
      ${outcome.querySignature ? `<p class="quiet-note find-query-color">本次上传图的色彩：明度 ${outcome.querySignature.colorSignature.meanLightness} · 饱和 ${outcome.querySignature.colorSignature.meanSaturation} · 暖 ${(outcome.querySignature.colorSignature.warmShare * 100).toFixed(0)}% / 冷 ${(outcome.querySignature.colorSignature.coolShare * 100).toFixed(0)}%（来源：${escapeHtml(outcome.querySignatureOrigin)}）</p>` : `<p class="quiet-note">本次上传图未能计算色彩特征，色彩证据不参与本次排序。</p>`}
      <details class="finder-why">
        <summary>为什么推荐这些？</summary>
        <div class="finder-why-body"></div>
      </details>
    </section>
  `;
  const body = app.querySelector(".finder-why-body");
  body.innerHTML = outcome.results.length
    ? outcome.results
        .map(
          (item) => `
        <div class="finder-reason-line">
          <strong>${escapeHtml(creatorLabel(item.artwork))} · ${escapeHtml(item.artwork.titleZh || item.artwork.title)}</strong>
          <small>Retrieval score ${item.retrievalScore} · 匹配依据取自${escapeHtml(provenanceLabel(item.intentProvenance))}</small>
          <ul>${item.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
        </div>`
        )
        .join("")
    : `<p class="quiet-note">没有足够重叠的视觉关系。</p>`;

  app.querySelector("#find-results").innerHTML = outcome.results.length
    ? outcome.results
        .map(
          (item) => `
        <a class="find-hit" data-hit-key="${escapeHtml(item.artwork.key)}" data-ref-key="${escapeHtml(item.artwork.key)}" href="${escapeHtml(hrefFor(item))}">
          <span style="${aspectRatioCss(item.artwork)}">${renderImg(item.artwork)}</span>
          <div>
            <strong>${escapeHtml(creatorLabel(item.artwork))}</strong>
            <em>${escapeHtml(item.artwork.titleZh || item.artwork.title)}</em>
            ${creditLine(item)}
            <small>Retrieval score ${item.retrievalScore} · 依据${escapeHtml(provenanceLabel(item.intentProvenance))}</small>
            ${item.colorEvidence ? `<small class="find-color-evidence">色彩距离 ${item.colorEvidence.distance}（明度 ${item.colorEvidence.components.lightness} / 饱和 ${item.colorEvidence.components.saturation} / 冷暖 ${item.colorEvidence.components.warmcool}）· 加分 ${item.colorEvidence.bonus}</small>` : ""}
            ${item.crossTradition ? `<small class="find-cross-tradition">跨传统灵感：核心结构相近，光线/色彩组织不同，非高相似</small>` : ""}
          </div>
        </a>`
        )
        .join("")
    : `<p class="quiet-note">没有足够重叠的视觉关系。</p>`;
  bindImgFallback(app);
  bindReferencePicks(app);
}

// R1.0-R1: clicking a result card is a REAL reference pick — the only way
// selectedReferenceKeys grows. The hash navigation itself is untouched.
function bindReferencePicks(app) {
  // 名称命中卡与视觉结果卡走**同一个**参考选择 / TaskContext 记录入口：
  // 两类命中都会进 selectedReferenceKeys，区别只在展示依据，不在记录方式。
  app.querySelectorAll(".find-hit[data-ref-key], .find-name-hit[data-ref-key]").forEach((link) => {
    link.addEventListener("click", () => {
      recordReference(link.dataset.refKey);
    });
  });
}

// 远程渠道参考区。远程件与本地件严格分开展示，理由有两个：
//   · 依据不同。本地件走VisualIntent 评分，远程件只有馆方分类字段的文本匹配。
//     混在一张列表里、贴同样的「依据」标签，等于宣称「模型看过这张画」。
//   · 可点性不同。本地件有站内详情页，远程件只能跳到馆方页面。
function renderRemoteSection(remote) {
  if (!remote) return "";
  const { results = [], degraded = false, note = "", metadataOnlyCount = 0, unsupported = false, unrelatedCount = 0 } = remote;
  const film = remote.film || {};
  const vision = film.vision || null;
  // STEP 2/3/4 的可解释摘要。缺失的量一律显示「未知」而不是省略。
  const filmSummary = `
    <p class="quiet-note find-remote-summary">
      电影渠道：本次扫描 ${film.skippedCount ?? "未知"} 条、排除 ${film.skippedCount ?? "未知"} 条未通过判据${
        film.queryMapping && film.queryMapping.reason ? `；${film.queryMapping.reason}` : ""
      }。${
        film.concepts && film.concepts.terms && film.concepts.terms.length
          ? `各检索词实际贡献：${film.concepts.terms
              .map((t) => `「${t.term}」(${t.source.replace("受控词表·", "")})→${film.concepts.termTally?.[t.term] ?? 0} 件`)
              .join("，")}。`
          : ""
      }${
        film.concepts && film.concepts.locationTally
          ? `命中位置：${Object.entries(film.concepts.locationTally)
              .map(([k, v]) => `${k}×${v}`)
              .join("、")}；仅片名撞词的候选画面未被验证，一律标注「待视觉核验」。`
          : ""
      }${
        film.natureKinds
          ? `图像性质分布：${Object.entries(film.natureKinds)
              .map(([k, v]) => `${k}×${v}`)
              .join("、")}。`
          : ""
      }${
        film.verificationTally && film.verificationTally.identityTransportFailed
          ? `身份传输失败 ${film.verificationTally.identityTransportFailed} 次（Wikidata 限流/超时，本次「未核实」是**查不成**的结果，不是「查过没有」）。`
          : ""
      }${
        vision
          ? `图像分析：${vision.analyzed}/${vision.attempted} 件（原因 ${escapeHtml(vision.reason || "未知")}）。`
          : ""
      }${film.corrections && film.corrections.excludedCount ? `你已排除 ${film.corrections.excludedCount} 件。` : ""}
    </p>`;

  if (degraded && !results.length) {
    return `
      <section class="find-remote">
        <h2 class="find-remote-title">远程渠道参考</h2>
        <p class="quiet-note">${escapeHtml(note || "远程渠道暂时不可用。")}本地检索结果不受影响。</p>
        ${filmSummary}
      </section>`;
  }
  // 渠道不支持该查询语义（不是故障）：即使有绘画结果，也必须把这条说明
  // 显示出来。否则用户看到一堆结果，会以为电影渠道也一起检索过了。
  // 同时要交代**另一个渠道**的结论——只讲「电影渠道不支持」会让用户以为
  // 博物馆渠道也没查，而事实是查了但没找到相关的。
  if (unsupported && !results.length) {
    const museumNote =
      unrelatedCount || metadataOnlyCount
        ? `博物馆渠道已检索，但未找到与本次查询相关的可展示参考${
            unrelatedCount ? `（${unrelatedCount} 件与查询无关联` : ""
          }${metadataOnlyCount ? `${unrelatedCount ? "、" : ""}${metadataOnlyCount} 件无可展示图片或版权未确认` : ""}${
            unrelatedCount ? "，均未列入）" : "）"
          }`
        : `博物馆渠道已检索，未找到相关参考。`;
    return `
      <section class="find-remote">
        <h2 class="find-remote-title">远程渠道参考</h2>
        <p class="quiet-note">${escapeHtml(note || "远程渠道不支持该查询语义。")}</p>
        <p class="quiet-note">${escapeHtml(museumNote)}本地检索结果不受影响。</p>
        ${filmSummary}
      </section>`;
  }
  // ★ 渠道可用、也支持该语义，但所有候选都与查询无关联。
  // MEASURED 缺陷（相关性过滤引入）：此分支缺失时函数返回空字符串，
  // 远程区段完全空白且不解释——用户以为远程没工作。必须给一句明确说明，
  // 并如实报告被过滤的件数，不把「没有相关结果」伪装成「没有内容」。
  if (!results.length) {
    return `
      <section class="find-remote">
        <h2 class="find-remote-title">远程渠道参考</h2>
        <p class="quiet-note">博物馆与 Commons 渠道已检索，但没有找到与「这次查询」相关的可展示参考。${
          unrelatedCount ? `另有 ${unrelatedCount} 件馆藏与查询无关联，未列入。` : ""
        }${metadataOnlyCount ? `另有 ${metadataOnlyCount} 件无可展示图片或版权状态未确认，未列入。` : ""}本地检索结果不受影响。</p>
        ${filmSummary}
      </section>`;
  }

  return `
    <section class="find-remote">
      <h2 class="find-remote-title">远程渠道参考</h2>
      <p class="quiet-note">以下来自博物馆与Commons 渠道，<strong>依据仅为馆方分类字段的文本匹配</strong>，不是模型对图像的视觉分析。${
        metadataOnlyCount ? `另有 ${metadataOnlyCount} 件无可展示图片或版权状态未确认，未列入。` : ""
      }${unrelatedCount ? `另有 ${unrelatedCount} 件与本次查询无关联，未列入。` : ""}</p>
      ${note ? `<p class="quiet-note">${escapeHtml(note)}</p>` : ""}
      ${filmSummary}
      ${results.map((item) =>
        item.medium === "film" ? renderRemoteFilmCard(item, remote.film) : `
        <a class="find-hit find-hit-remote" href="${escapeHtml(item.artwork.remote?.sourceUrl || "#")}" target="_blank" rel="noopener noreferrer">
          <span style="${aspectRatioCss(item.artwork)}">${renderImg(item.artwork)}</span>
          <div>
            <strong>${escapeHtml(item.artwork.artist || item.artwork.remote?.channelName || "作者未知")}</strong>
            <em>${escapeHtml(item.artwork.titleZh || item.artwork.title)}</em>
            ${creditLine(item)}
            <small>${escapeHtml(item.artwork.remote?.channelName || "远程渠道")} · 匹配分 ${item.retrievalScore} · 依据：馆方分类字段</small>
            <ul>${(item.reasons || []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
          </div>
        </a>`
      ).join("")}
    </section>`;
}

// renderOutcome 保持本地行为完全不变；remote 是可选附加参数，
// renderOutcome 保持本地行为完全不变；remote 是可选附加参数，
// 不传时行为与接入远程渠道之前逐字节一致。
//
// `beginTask()` 由调用方显式决定是否执行（见 `newTask` 参数）。原因：远程
// 渠道返回时会二次调用本函数，若把 beginTask 留在函数内部，一次查询就会
// 重置两次 TaskContext——用户在远程等待期间选中的参考会被清掉。
function renderOutcome(app, intent, results, note = "", queryProvenance = INTENT_PROVENANCE.TEXT, remote = null, newTask = true) {
  // R1.0-R1: a completed search is a new task — record the intent when the
  // search actually produced results, reset (intent-less) otherwise.
  if (newTask) beginTask(results.length ? intent : null);
  const fields = intentSummary(intent);
  app.querySelector("#find-intent").innerHTML = `
    <section class="intent-card">
      <h2>Visual Intent</h2>
      ${note ? `<p class="quiet-note">${escapeHtml(note)}</p>` : ""}
      <p class="quiet-note">这一段来自${escapeHtml(provenanceLabel(queryProvenance))}。</p>
      <ul>${fields.map((line) => `<li>${escapeHtml(line)}</li>`).join("") || "<li>没有足够规则可解析</li>"}</ul>
    </section>
  `;
  app.querySelector("#find-results").innerHTML = results.length
    ? results
        .map(
          (item) => `
        <a class="find-hit" data-hit-key="${escapeHtml(item.artwork.key)}" data-ref-key="${escapeHtml(item.artwork.key)}" href="${escapeHtml(hrefFor(item))}">
          <span style="${aspectRatioCss(item.artwork)}">${renderImg(item.artwork)}</span>
          <div>
            <strong>${escapeHtml(creatorLabel(item.artwork))}</strong>
            <em>${escapeHtml(item.artwork.titleZh || item.artwork.title)}</em>
            ${creditLine(item)}
            <small>Retrieval score ${item.retrievalScore} · 依据${escapeHtml(provenanceLabel(item.intentProvenance))}</small>
            <ul>${item.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
          </div>
        </a>`
        )
        .join("")
    : `<p class="quiet-note">没有足够重叠的视觉关系。</p>`;
  // 远程区段由 runSearch 通过 paintRemote() 单独写入（它持有令牌与卸载
  // 守卫）。renderOutcome 只负责本地部分；显式传入 remote 时才渲染一次，
  // 用于非 runSearch 的调用场景。
  if (remote) {
    const host = app.querySelector("#find-remote");
    if (host) host.innerHTML = renderRemoteSection(remote);
  }
  bindImgFallback(app);
  bindReferencePicks(app);
}