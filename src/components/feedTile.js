// feedTile.js — Visual Feed tile. Image-first; a hover/tap action layer offers
// SEE SIMILAR / USE FOR CREATE / USE FOR SHOOT. Default state stays clean.
// Markup note: the tile is a <div> (NOT <a>) because the action layer contains
// <a> elements — nesting anchors would be auto-closed by the HTML parser.

import { renderImg, aspectRatioCss } from "../utils/image.js";
import { escapeHtml } from "../utils/html.js";

export function feedTile(artwork, index) {
  const priority = index < 8;
  const href = `#artwork/${escapeHtml(artwork.key)}`;
  const metaLine = artwork.hasAnalysis
    ? escapeHtml(artwork.emotion.slice(0, 2).join(" / "))
    : escapeHtml(artwork.artist);
  return `
    <div class="feed-tile" data-tile-key="${escapeHtml(artwork.key)}" aria-label="${escapeHtml(
      artwork.titleZh || artwork.title
    )} · ${escapeHtml(artwork.artist)}">
      <a class="tile-link" href="${href}">
        <span class="img-wrap" style="${aspectRatioCss(artwork)}">
          ${renderImg(artwork, { priority })}
          <span class="tile-no">${String(index + 1).padStart(2, "0")}</span>
        </span>
      </a>
      <span class="tile-actions">
        <button type="button" data-tile-action="similar" data-href="${href}">SEE SIMILAR</button>
        <button type="button" data-tile-action="create" data-href="#create/${escapeHtml(artwork.key)}">USE FOR CREATE</button>
        <button type="button" data-tile-action="shoot" data-href="#shoot/${escapeHtml(artwork.key)}">USE FOR SHOOT</button>
      </span>
      <span class="feed-meta">
        <b>${escapeHtml(artwork.artist)}</b>
        <span>${escapeHtml(artwork.titleZh || artwork.title)} · ${escapeHtml(artwork.year)}</span>
        <em>${metaLine}</em>
      </span>
    </div>
  `;
}

export function skeletonTile() {
  return `
    <div class="feed-tile is-skeleton">
      <div class="img-wrap" style="aspect-ratio: 4 / 3"></div>
      <span class="feed-meta"><b>&nbsp;</b><span>&nbsp;</span></span>
    </div>
  `;
}

// Action layer interaction (touch-first):
//   - tap an action link -> navigate to its target
//   - touch: first tap opens actions; second tap (on the link) navigates
//   - desktop: CSS :hover reveals actions; plain click navigates
export function bindTileActions(container) {
  container.querySelectorAll(".feed-tile").forEach((tile) => {
    if (tile.dataset.actionsBound === "1") return;
    tile.dataset.actionsBound = "1";

    tile.addEventListener("click", (event) => {
      const action = event.target.closest("[data-tile-action]");
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        const href = action.dataset.href || action.getAttribute("href");
        if (href) window.location.hash = href.replace(/^#/, "");
        return;
      }
      if (window.matchMedia("(hover: none)").matches) {
        event.preventDefault();
        const link = tile.querySelector(".tile-link");
        if (tile.classList.contains("tile-open")) {
          tile.classList.remove("tile-open");
          if (link) window.location.hash = link.getAttribute("href").replace(/^#/, "");
        } else if (event.target.closest(".img-wrap, .feed-meta")) {
          tile.classList.add("tile-open");
        }
      }
    });
    tile.addEventListener("mouseleave", () => tile.classList.remove("tile-open"));
  });
}

export function renderFeedTiles(container, items, startIndex) {
  container.insertAdjacentHTML("beforeend", items.map((a, i) => feedTile(a, startIndex + i)).join(""));
  bindTileActions(container);
}