// filmDetail.js — 电影画面详情页（路由 #film/<id>）。
//
// R5 STEP 3。一张电影画面必须有自己独立的记录页，而不是被塞进艺术作品详情页：
// 片名、导演、年份、画面标识、许可、以及画面视觉特征都属于电影这一媒介。
// 把帧当单幅绘画展示会让"导演"变成"画家"，所以这里单列。

import { filmStills, FILM_STILL_RIGHTS } from "../data/filmStills.js";
// P4.12 — 黑白电影影像的详情页也必须关死：只查过滤后的池。
// filmStills 仍保留给「这条记录是否存在」的判断，但能否展示要看池子。
import { filmStillPool, excludedFilmCandidates } from "../services/retrieval/retrievalService.js";
import { escapeHtml } from "../utils/html.js";
import { renderImg, bindImgFallback, aspectRatioCss } from "../utils/image.js";
import { setRouteActive } from "../app/events.js";
import { recordReference } from "../utils/taskContext.js";

// 这张图「是什么」必须写清楚 —— 本轮审计修的就是三类东西被混成一个词：
//   frame           影片画面（从影片拷贝逐帧截下来的图）
//   scene-still     影片剧照（当年发行或档案部门拍的场景照，画面即影片场景）
//   publicity-*     宣传照（宣传物料，画面取自影片场景，但性质是宣传照片）
// 电影海报、演员肖像、明星明信片、lobby card 一律不进这个产品（见 filmStillsExpansion.js 头部）。
const IMAGE_KIND_LABEL = {
  frame: "影片画面（逐帧截图）",
  "scene-still": "影片剧照（当年发行／档案的场景照）",
  "publicity-still": "宣传剧照（宣传物料，画面即影片场景）",
  "publicity-photo": "宣传照（宣传物料，画面即影片场景）",
};

export function renderFilmStill(app, id) {
  setRouteActive("find");
  // P4.12 — 被黑白规则排除的影片，详情页如实说明原因，而不是"未找到"。
  // MEASURED：原先直查 filmStills，于是 #film/film-the-general 仍能打开完整详情，
  // 等于给已排除的黑白片留了一个可直连的落地页。
  const excludedEntry = excludedFilmCandidates().find((e) => e.id === id);
  if (excludedEntry) {
    app.innerHTML = `<section class="artwork-page"><p class="quiet-note">这张电影画面未纳入 AIGC 参考：${escapeHtml(excludedEntry.reason)}。</p>
      <p class="quiet-note">当前规则不使用黑白电影影像作为创作参考。</p>
      <p><a href="#find">回到 FIND</a></p></section>`;
    return;
  }
  const poolItem = filmStillPool().find((c) => c.id === id);
  const still = filmStills.find((s) => s.id === id);
  if (!still || !poolItem) {
    app.innerHTML = `<section class="artwork-page"><p class="quiet-note">未找到该电影画面记录。</p>
      <p><a href="#find">回到 FIND</a></p></section>`;
    return;
  }
  const i = still.visualIntent;
  const src = still.source;
  const r = src;

  app.innerHTML = `
    <section class="artwork-page film-still-page">
      <p class="kicker">电影画面</p>
      <h1>${escapeHtml(still.titleZh)}</h1>
      <p class="artwork-sub">${escapeHtml(still.title)} · ${escapeHtml(String(still.year))}</p>

      <div class="art-figure">
        <span style="${aspectRatioCss({ image: still.image })}">${renderImg({ ...still, titleZh: still.titleZh })}</span>
      </div>

      <dl class="film-meta">
        <dt>导演</dt><dd>${escapeHtml(still.directorZh)}（${escapeHtml(still.director)}）</dd>
        <dt>年份</dt><dd>${escapeHtml(String(still.year))}</dd>
        <dt>画面标识</dt><dd>${escapeHtml(still.frameIdentifier)}</dd>
        <dt>图像性质</dt><dd>${escapeHtml(IMAGE_KIND_LABEL[still.imageKind] || still.imageKind || "影片画面（性质未标注）")}</dd>
        <dt>时间码</dt><dd>${escapeHtml(still.timestamp ? String(still.timestamp) : still.timestampNote || "未记录")}</dd>
        <dt>来源</dt><dd><a href="${escapeHtml(src.url)}" rel="noreferrer noopener" target="_blank">${escapeHtml(src.name)} · ${escapeHtml(src.file)}</a></dd>
        ${src.description ? `<dt>来源描述</dt><dd class="film-source-desc">${escapeHtml(src.description)}</dd>` : ""}
        <dt>许可</dt><dd>${escapeHtml(r.licenseShortName)}（模板 <code>${escapeHtml(r.license)}</code>${r.rightsCategory ? ` · ${escapeHtml(r.rightsCategory)}` : ""}）</dd>
        ${r.credit ? `<dt>署名</dt><dd>${escapeHtml(r.credit)}</dd>` : ""}
        <dt>许可核验</dt><dd>${escapeHtml(r.rightsCategory || "Commons")} · 已于 ${escapeHtml(
          FILM_STILL_RIGHTS.verifiedAt
        )} 逐张核验</dd>
        <dt>核验方式</dt><dd><code>${escapeHtml(FILM_STILL_RIGHTS.verificationMethod)}</code></dd>
      </dl>

      <section class="film-visual">
        <h2>画面视觉特征</h2>
        ${still.visualNote ? `<p>${escapeHtml(still.visualNote)}</p>` : ""}
        <ul class="film-traits">
          <li><b>构图</b> ${escapeHtml(i.subject)} / ${escapeHtml(i.subjectScale)} / ${escapeHtml(i.subjectPosition)}</li>
          <li><b>空间</b> ${escapeHtml(i.spatialDepth)} / 纵深${escapeHtml(i.environmentDominance)}</li>
          <li><b>光线</b> ${escapeHtml(i.lightDirection)} / ${escapeHtml(i.lightQuality)} / ${escapeHtml(i.colorTemperature)}</li>
          <li><b>主体</b> ${escapeHtml(i.humanRelation)} / ${escapeHtml(i.motion)}</li>
          <li><b>氛围</b> ${escapeHtml((i.atmosphere || []).join("、"))}</li>
          <li><b>情绪</b> ${escapeHtml((i.emotion || []).join("、"))}</li>
        </ul>
      </section>

      <p class="film-actions">
        <button type="button" class="primary-action" data-film-ref="${escapeHtml(still.id)}">用作拍摄参考</button>
        <a class="quiet-link" href="#find">回到 FIND 继续检索</a>
      </p>
    </section>
  `;

  bindImgFallback(app);
  app.querySelector("[data-film-ref]")?.addEventListener("click", (e) => {
    recordReference(e.currentTarget.dataset.filmRef);
    window.location.hash = `#shoot/${e.currentTarget.dataset.filmRef}`;
  });
}