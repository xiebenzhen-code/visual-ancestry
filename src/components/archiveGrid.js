import { artworks } from "../data/artworks.js";
import { state } from "../app/state.js";
import { escapeHtml } from "../utils/html.js";
import { renderImg, bindImgFallback } from "../utils/image.js";
import { unavailableReason } from "./artworkFigure.js";
import { filterArtworks, traditionLabel } from "../utils/search.js";

export function compactTerms(terms, category) {
  return terms
    .map(
      (term) =>
        `<button class="term-link" data-category="${category}" data-term="${escapeHtml(term)}" type="button">${escapeHtml(
          category === "tradition" ? traditionLabel(term) : term
        )}</button>`
    )
    .join("");
}

export function artworkTile(artwork, index) {
  const href = `#artwork/${artwork.key || artwork.id}`;
  // Do not assert a copyright term we have not verified. imageUnavailable only
  // records that no file is bundled; the reason is per-record and sometimes
  // "public domain pending per-impression check", not "in copyright".
  const figure = artwork.imageUnavailable
    ? `<figure class="is-unavailable"><span>${escapeHtml(artwork.titleZh)}<br />${escapeHtml(
        artwork.artist
      )}<br /><em>${escapeHtml(unavailableReason(artwork))}</em></span></figure>`
    : `<figure>${renderImg(artwork, { priority: index < 4 })}</figure>`;
  return `
    <a class="art-tile ${artwork.orientation}" href="${href}" aria-label="${escapeHtml(
      artwork.titleZh
    )} ${escapeHtml(artwork.artist)}">
      ${figure}
      <span class="tile-number">${String(index + 1).padStart(2, "0")}</span>
      <span class="tile-meta">
        <b>${escapeHtml(artwork.artist)}</b>
        <span>${escapeHtml(artwork.titleZh || artwork.title)} · ${escapeHtml(artwork.year)}</span>
      </span>
    </a>
  `;
}

export function renderArchiveGrid() {
  const grid = document.querySelector("#archive-grid");
  if (!grid) return;
  const results = filterArtworks(artworks, state);
  const label = document.querySelector("#result-label");
  if (label) {
    const suffix = state.activeTerm ? ` / ${state.activeTerm}` : state.query ? ` / ${state.query}` : "";
    label.textContent = `${String(results.length).padStart(2, "0")} WORKS${suffix}`;
  }
  grid.innerHTML = results.length
    ? results.map(artworkTile).join("")
    : `<div class="empty">没有找到对应作品。试试“孤独”“梦境”“baroque”“solitude”。</div>`;
  bindImgFallback(grid);
}