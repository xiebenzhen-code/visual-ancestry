// artwork.js — the artwork is a tool node, not an endpoint.
// First screen: big image + Artist / Title · Year + three actions.
// Next layer: WHY IT WORKS, VISUAL RELATIONS (with reasons), SEEN IN CINEMA.
// Last: collapsed Artwork facts (museum, source, rights, region, evidence).

import { findByKey, findLocalById } from "../services/artService.js";
import { retrieveByArtworkChecked, relationsFor, provenanceLabel } from "../services/retrieval/retrievalService.js";
import { setRouteActive, attachSaveHandlers } from "../app/events.js";
import { renderImg, bindImgFallback, aspectRatioCss } from "../utils/image.js";
import { escapeHtml } from "../utils/html.js";
import { track } from "../utils/profile.js";
import { buildBranches } from "../services/explore/styleBranches.js";
import { MEDIA_MODES } from "../services/explore/media.js";
import { fetchExternalNeighbors } from "../services/discoveryClient.js";

function factsBlock(artwork) {
  const rows = [
    ["馆藏", artwork.museum],
    ["地区 / Culture", artwork.culture || artwork.origin],
    ["年代", artwork.year],
    ["来源", artwork.source ? artwork.source.name : ""],
    ["版权", artwork.rightsStatus],
    ["Evidence", artwork.evidenceLevel],
  ].filter(([, v]) => v);
  return `
    <details class="detail-facts">
      <summary>··· / Artwork facts</summary>
      <dl class="metadata-list">
        ${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}
      </dl>
      ${
        artwork.sourceUrl
          ? `<p class="quiet-note"><a href="${escapeHtml(artwork.sourceUrl)}" target="_blank" rel="noreferrer">在馆方查看原记录 →</a></p>`
          : ""
      }
    </details>
  `;
}

function whyItWorksSection(artwork) {
  if (!artwork.hasAnalysis) {
    return `
      <section class="analysis-section">
        <h2 class="section-title">WHY IT WORKS</h2>
        <p class="analysis-unavailable">Visual analysis unavailable</p>
        <p class="quiet-note">该作品来自馆方 API，仅有档案事实。我们不替未知作品编造视觉分析。</p>
      </section>
    `;
  }
  const fields = [
    ["Composition", artwork.composition],
    ["Lighting", artwork.lighting],
    ["Color", artwork.color],
    ["Spatial Structure", artwork.spatialStructure],
  ].filter(([, v]) => v);
  return `
    <section class="analysis-section">
      <h2 class="section-title">WHY IT WORKS</h2>
      <div class="analysis-grid">
        ${fields.map(([k, v]) => `<div class="field-block"><span>${escapeHtml(k)}</span><p>${escapeHtml(v)}</p></div>`).join("")}
      </div>
    </section>
  `;
}

function relationsSection(artwork) {
  // P4.13-F — 与 FIND 选画共用同一条增强策略（档案签名）与同一套参数来源，
  // 使「同一作品 + 同一候选范围 + 同一图像证据」在两个入口得到同一排序。
  // 用 checked 区分「没有相关作品」与「这件作品不能作为检索起点」。
  const outcome = retrieveByArtworkChecked(artwork, { limit: 4 });
  if (!outcome.ok || !outcome.results.length) return "";
  const hits = outcome.results;
  return `
    <section class="analysis-section" id="visual-relations" data-retrieval-evidence="${escapeHtml(
      (outcome.enhancement && outcome.enhancement.evidence) || "none"
    )}">
      <h2 class="section-title">VISUAL RELATIONS</h2>
      ${hits
        .map(
          (item) => `
        <a class="relation-row" href="#artwork/${escapeHtml(item.artwork.key)}">
          <span class="relation-thumb" style="${aspectRatioCss(item.artwork)}">${renderImg(item.artwork)}</span>
          <span class="relation-meta">
            <strong>${escapeHtml(item.artwork.artist)} · ${escapeHtml(item.artwork.titleZh || item.artwork.title)}</strong>
            <small>Retrieval score ${item.retrievalScore} · 匹配依据取自${escapeHtml(provenanceLabel(item.intentProvenance))}</small>
            <ul>${item.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
          </span>
        </a>`
        )
        .join("")}
    </section>
  `;
}

/* ---------------- 探索分支（Phase 1） ----------------
   四条分支共用同一份生成器（services/explore/styleBranches.js）。
   这里只负责画出来：保留了什么、换掉了什么、证据来自哪里、有没有经过 Vision。
   档位（P4.15.4）不参与筛选，也不当作推荐理由。 */

function branchCard(branch) {
  const cards = branch.results
    .map(
      (r) => `
      <a class="explore-card" href="${escapeHtml(r.href)}" data-explore-result="${escapeHtml(r.id)}">
        <span class="img-slot" style="${aspectRatioCss(r)}">${renderImg(r)}</span>
        <strong>${escapeHtml(r.title)}</strong>
        <span class="explore-artist">${escapeHtml(r.artist || "")}${r.year ? ` · ${escapeHtml(String(r.year))}` : ""}</span>
        <span class="explore-change">${escapeHtml(r.changes)}</span>
        <ul class="explore-evidence">
          ${r.evidence
            .map((e) => `<li><span class="ev-kind">${escapeHtml(e.kind)}</span>${escapeHtml(e.text)}</li>`)
            .join("")}
        </ul>
        <span class="explore-badge ${r.visionVerified ? "is-verified" : ""}">${
          r.visionVerified ? "有独立画像（A 级）" : "未分析"
        }</span>
      </a>`
    )
    .join("");
  return `
    <article class="explore-branch" data-branch="${escapeHtml(branch.id)}">
      <div class="explore-branch-head">
        <h3>${escapeHtml(branch.label)}</h3>
        <span class="explore-flag">改变：${escapeHtml(branch.changeDim)}</span>
      </div>
      <p class="explore-preserve">保留：${escapeHtml(branch.preserves)}</p>
      <p class="explore-vision" data-tone="${escapeHtml(branch.vision.tone)}">Vision：${escapeHtml(branch.vision.note)}</p>
      ${branch.empty ? `<p class="explore-empty">这一栏是空的。${escapeHtml(branch.emptyReason || "")}</p>` : `<div class="explore-results">${cards}</div>`}
    </article>`;
}

/* 外部发现：服务端按同一套规则把自动采集的图片归到四条分支里。
   页面不直连外部 API，也不显示端点/模型/内部证据等级。 */
function externalCard(item) {
  return `
    <a class="explore-card explore-external" href="${escapeHtml(item.sourceUrl || "#")}" target="_blank" rel="noreferrer"
       data-ext-kind="${escapeHtml(item.imageKind || "unknown")}">
      <span class="img-slot"><img src="${escapeHtml(item.image)}" alt="" loading="lazy" decoding="async" /></span>
      <strong>${escapeHtml(item.title || "(无标题)")}</strong>
      <span class="explore-artist">${escapeHtml(item.creator || "")}${item.year ? " · " + escapeHtml(String(item.year)) : ""}</span>
      <span class="explore-change">${escapeHtml(item.branchReason || "外部候选")}</span>
      <span class="explore-badge is-external">外部发现 · ${escapeHtml(item.provider)}</span>
    </a>`;
}

async function hydrateExternal(app, artwork) {
  const status = app.querySelector("#explore-external-status");
  if (status) status.textContent = "正在从外部来源补充候选…";
  const r = await fetchExternalNeighbors(artwork.id);
  if (!r || !r.ok) {
    if (status) status.textContent = r && r.error === "vector-unavailable"
      ? "外部候选暂不可用（索引未就绪）；上面的候选仍然可用。"
      : "外部来源暂时没有返回；上面的候选仍然可用。";
    return;
  }
  let added = 0;
  for (const [key, arr] of Object.entries(r.buckets || {})) {
    if (!arr.length) continue;
    const branch = app.querySelector(`[data-branch="${key}"]`);
    if (!branch) continue;
    let list = branch.querySelector(".explore-results");
    if (!list) {
      branch.querySelector(".explore-empty")?.remove();
      list = document.createElement("div");
      list.className = "explore-results";
      branch.appendChild(list);
    }
    list.insertAdjacentHTML("beforeend", arr.map(externalCard).join(""));
    added += arr.length;
  }
  if (status) {
    status.textContent = added
      ? `已接入 ${added} 张外部自动发现图（当前索引 ${r.indexed} 张）`
      : "外部索引里暂时没有更多候选。";
  }
}

function exploreSection(artwork) {
  const branches = buildBranches(artwork);
  return `
    <section class="analysis-section explore-section" id="explore" data-media="all">
      <h2 class="section-title">EXPLORE · 同风格，换一个维度</h2>
      <p class="explore-lede">保留画派与整体气质，每次只改一个维度。每条结果都写明：保留了什么、换掉了什么、证据来自档案、像素实测还是独立画像。</p>
      <div class="explore-media" role="group" aria-label="按媒介筛选">
        <span class="explore-media-label">媒介</span>
        ${MEDIA_MODES.map(
          (m) => `<button type="button" class="${m.value === "all" ? "is-on" : ""}" data-explore-media="${m.value}">${m.label}</button>`
        ).join("")}
      </div>
      <p class="explore-external-status" id="explore-external-status" aria-live="polite"></p>
      <div class="explore-branches" id="explore-branches">
        ${branches.map(branchCard).join("")}
      </div>
      <p class="explore-media-note" id="explore-media-note"></p>
    </section>`;
}

function cinemaSection(artwork) {
  const refs = relationsFor(artwork);
  if (!refs.length) return "";
  return `
    <section class="analysis-section seen-in-cinema">
      <h2 class="section-title">SEEN IN CINEMA</h2>
      ${refs
        .map(
          (r) => `
        <div class="film-ref-row">
          <strong>${escapeHtml(r.filmTitle)}</strong>
          <span>${escapeHtml(r.director || "")} · ${escapeHtml(String(r.year || ""))}</span>
          <em>${escapeHtml(r.relationClass)} · ${escapeHtml(r.relationType)}</em>
          ${r.description ? `<p>${escapeHtml(r.description)}</p>` : ""}
        </div>`
        )
        .join("")}
    </section>
  `;
}

export function renderArtwork(app, key) {
  const artwork = findByKey(key) || findLocalById(key);
  if (!artwork) {
    app.innerHTML = `<div class="empty">未找到该作品。</div>`;
    return;
  }
  track("viewedArtwork", artwork.id || artwork.key);
  setRouteActive("");

  const isLocal = Boolean(artwork.id);
  app.innerHTML = `
    <article class="detail-page">
      <figure class="detail-figure" style="${aspectRatioCss(artwork)}">
        ${renderImg(artwork, { priority: true })}
      </figure>
      <header class="detail-head">
        <p class="d-artistline">${escapeHtml(artwork.artistZh || artwork.artist)}</p>
        <h1>${escapeHtml(artwork.titleZh || artwork.title)} · ${escapeHtml(artwork.year)}</h1>
        <div class="detail-actionsrow">
          <a href="#find" data-detail-action="similar">FIND SIMILAR</a>
          ${isLocal ? `<a href="#create/${escapeHtml(artwork.id)}" data-detail-action="create">CREATE WITH THIS</a>` : ""}
          ${isLocal ? `<a class="alt" href="#shoot/${escapeHtml(artwork.key)}" data-detail-action="shoot">SHOOT LIKE THIS</a>` : ""}
        </div>
      </header>
      <div class="detail-body">
        ${whyItWorksSection(artwork)}
        ${isLocal ? exploreSection(artwork) : ""}
        ${relationsSection(artwork)}
        ${cinemaSection(artwork)}
        ${factsBlock(artwork)}
        <div class="context-actions record-actions">
          <button class="ghost-action" type="button" data-save-artwork="${escapeHtml(artwork.id || artwork.key)}" aria-pressed="false">收藏到我的视觉档案</button>
        </div>
      </div>
    </article>
  `;
  bindImgFallback(app);
  attachSaveHandlers(app);

  // 媒介筛选：只重绘分支区，不重载页面，也不改路由。
  const explore = app.querySelector("#explore");
  if (explore) {
    hydrateExternal(app, artwork);
    const branchesHost = explore.querySelector("#explore-branches");
    const note = explore.querySelector("#explore-media-note");
    explore.querySelectorAll("[data-explore-media]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.exploreMedia;
        explore.querySelectorAll("[data-explore-media]").forEach((b) => b.classList.toggle("is-on", b === btn));
        explore.dataset.media = mode;
        const next = buildBranches(artwork, { media: mode });
        branchesHost.innerHTML = next.map(branchCard).join("");
        const excluded = next[0] && next[0].mediaState ? next[0].mediaState.excluded : { monochromeFilms: 0 };
        const emptyCount = next.filter((b) => b.empty).length;
        // 外部卡按 imageKind 过滤：动画档不显示绘画/照片，跨媒介只显示非绘画
        app.querySelectorAll(".explore-external").forEach((el) => {
          const kind = el.dataset.extKind || "unknown";
          const isArtwork = kind === "artwork";
          const hide =
            (mode === "artwork" && !isArtwork) ||
            (mode === "film" && kind !== "film-still" && kind !== "tv-episode-still") ||
            (mode === "animation" && kind !== "tv-episode-still") ||
            (mode === "cross" && isArtwork);
          el.classList.toggle("is-hidden", hide);
        });
        note.textContent = [
          excluded.monochromeFilms ? `已排除 ${excluded.monochromeFilms} 张黑白电影剧照（不作为 AIGC 视觉参考）。` : "",
          emptyCount === 4 ? (next[0].emptyReason || "") : "",
        ].filter(Boolean).join(" ");
      });
    });
  }

  // FIND SIMILAR scrolls to the relations layer instead of leaving the page.
  app.querySelector('[data-detail-action="similar"]')?.addEventListener("click", (e) => {
    e.preventDefault();
    document.querySelector("#visual-relations")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}