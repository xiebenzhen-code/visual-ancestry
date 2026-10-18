// artwork.js — the artwork is a tool node, not an endpoint.
// First screen: big image + Artist / Title · Year + three actions.
// Next layer: WHY IT WORKS, VISUAL RELATIONS (with reasons), SEEN IN CINEMA.
// Last: collapsed Artwork facts (museum, source, rights, region, evidence).

import { findByKey, findLocalById } from "../services/artService.js";
import { retrieveByArtwork, relationsFor, provenanceLabel } from "../services/retrieval/retrievalService.js";
import { setRouteActive, attachSaveHandlers } from "../app/events.js";
import { renderImg, bindImgFallback, aspectRatioCss } from "../utils/image.js";
import { escapeHtml } from "../utils/html.js";
import { track } from "../utils/profile.js";

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
  const hits = retrieveByArtwork(artwork, { limit: 4 });
  if (!hits.length) return "";
  return `
    <section class="analysis-section" id="visual-relations">
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

  // FIND SIMILAR scrolls to the relations layer instead of leaving the page.
  app.querySelector('[data-detail-action="similar"]')?.addEventListener("click", (e) => {
    e.preventDefault();
    document.querySelector("#visual-relations")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}