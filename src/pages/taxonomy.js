import { artworks } from "../data/artworks.js";
import { emotions } from "../data/emotions.js";
import { atmospheres } from "../data/atmospheres.js";
import { traditions } from "../data/traditions.js";
import { state } from "../app/state.js";
import { setRouteActive, attachSearchHandlers } from "../app/events.js";
import { renderArchiveGrid } from "../components/archiveGrid.js";
import { escapeHtml } from "../utils/html.js";
import { traditionLabel } from "../utils/search.js";

export function renderTaxonomy(app, type) {
  const config = {
    emotion: {
      nav: "mood",
      title: "MOOD / EMOTION",
      deck: "心理情绪，只记录观看画面时最直接的内在感受。梦境不在这里。",
      terms: emotions,
      category: "emotion",
    },
    atmosphere: {
      nav: "atmosphere",
      title: "ATMOSPHERE",
      deck: "画面的空气、空间气质和感知状态。梦境、朦胧、夜晚属于这里。",
      terms: atmospheres,
      category: "atmosphere",
    },
    tradition: {
      nav: "traditions",
      title: "VISUAL TRADITIONS",
      deck: "艺术史流派、地域视觉传统和绘画体系并置，不以西方艺术史作为唯一主轴。",
      terms: traditions.map((item) => item.id),
      category: "tradition",
    },
  }[type];
  setRouteActive(config.nav);
  const firstSeedTerm = config.terms.find((term) =>
    type === "tradition"
      ? artworks.some((artwork) => artwork.traditions.includes(term))
      : artworks.some((artwork) => artwork[`${type}s`]?.includes(term))
  );
  state.query = "";
  state.activeCategory = config.category;
  state.activeTerm = firstSeedTerm || config.terms[0];
  app.innerHTML = `
    <section class="taxonomy-page">
      <header class="taxonomy-head">
        <p class="kicker">${config.nav.toUpperCase()}</p>
        <h1>${config.title}</h1>
        <p>${config.deck}</p>
      </header>
      <div class="term-index">
        ${config.terms
          .map((term, index) => {
            const count = artworks.filter((artwork) =>
              type === "tradition" ? artwork.traditions.includes(term) : artwork[`${type}s`]?.includes(term)
            ).length;
            const text = type === "tradition" ? traditionLabel(term) : term;
            return `
              <button class="term-row" data-category="${config.category}" data-term="${escapeHtml(term)}" type="button">
                <span>${String(index + 1).padStart(2, "0")}</span>
                <strong>${escapeHtml(text)}</strong>
                <em>${count ? `${count} works` : "index term"}</em>
              </button>
            `;
          })
          .join("")}
      </div>
      <div class="archive-toolbar">
        <span id="result-label"></span>
        <span>SELECT A TERM TO REFINE THE ARCHIVE</span>
      </div>
      <section class="archive-grid compact-grid" id="archive-grid" aria-label="分类结果"></section>
    </section>
  `;
  attachSearchHandlers();
  renderArchiveGrid();
}