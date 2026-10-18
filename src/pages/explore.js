import { setRouteActive } from "../app/events.js";
import { emotions } from "../data/emotions.js";
import { atmospheres } from "../data/atmospheres.js";
import { traditions } from "../data/traditions.js";
import { getLocalFeed } from "../services/artService.js";
import { feedTile, bindTileActions } from "../components/feedTile.js";
import { bindImgFallback } from "../utils/image.js";
import { traditionLabel } from "../utils/search.js";
import { escapeHtml } from "../utils/html.js";

const filterState = {
  category: "all",
  term: null,
  expanded: false,
};

function filterForService() {
  if (filterState.category === "all" || !filterState.term) return null;
  return { category: filterState.category, term: filterState.term };
}

function filterButton(category, label, term = "") {
  const isActive = filterState.category === category && (category === "all" || filterState.term === term);
  return `<button class="${isActive ? "is-on" : ""}" type="button" data-filter-category="${category}" data-filter-term="${escapeHtml(
    term
  )}">${escapeHtml(label)}</button>`;
}

function filterPanel() {
  return `
    <div class="explore-filter-panel" ${filterState.expanded ? "" : "hidden"}>
      <section>
        <h2>情绪</h2>
        <div>${emotions.map((term) => filterButton("emotion", term, term)).join("")}</div>
      </section>
      <section>
        <h2>氛围</h2>
        <div>${atmospheres.map((term) => filterButton("atmosphere", term, term)).join("")}</div>
      </section>
      <section>
        <h2>视觉传统</h2>
        <div>${traditions.map((item) => filterButton("tradition", traditionLabel(item.id), item.id)).join("")}</div>
      </section>
      <section>
        <h2>人物 / 风景</h2>
        <div>
          <button type="button" disabled>PERSON</button>
          <button type="button" disabled>PLACE</button>
        </div>
      </section>
      <section>
        <h2>色彩</h2>
        <div>
          <button type="button" disabled>LOW SATURATION</button>
          <button type="button" disabled>WARM LIGHT</button>
        </div>
      </section>
      <section>
        <h2>构图</h2>
        <div>
          <button type="button" disabled>NEGATIVE SPACE</button>
          <button type="button" disabled>CENTERED FIGURE</button>
        </div>
      </section>
    </div>
  `;
}

function renderGrid(app) {
  const grid = app.querySelector("#explore-grid");
  const count = app.querySelector("#explore-count");
  const local = getLocalFeed({ cursor: 0, batch: 80, filter: filterForService() });
  grid.innerHTML = local.items.map((item, index) => feedTile(item, index)).join("");
  count.textContent = `${String(local.items.length).padStart(2, "0")} WORKS`;
  bindTileActions(grid);
  bindImgFallback(grid);
}

export function renderExplore(app) {
  setRouteActive("explore");
  app.innerHTML = `
    <section class="explore-page">
      <header class="explore-head">
        <div class="explore-tabs" role="group" aria-label="Explore filters">
          ${filterButton("all", "ALL")}
          <button class="${filterState.category === "emotion" ? "is-on" : ""}" type="button" data-filter-jump="emotion">EMOTION</button>
          <button class="${filterState.category === "atmosphere" ? "is-on" : ""}" type="button" data-filter-jump="atmosphere">ATMOSPHERE</button>
          <button class="${filterState.category === "tradition" ? "is-on" : ""}" type="button" data-filter-jump="tradition">TRADITION</button>
          <button class="${filterState.expanded ? "is-on" : ""}" type="button" id="expand-filters" aria-expanded="${filterState.expanded}">+</button>
        </div>
        <span class="explore-count" id="explore-count"></span>
      </header>
      ${filterPanel()}
      <section class="feed-grid explore-grid" id="explore-grid" aria-label="Explore works"></section>
    </section>
  `;

  app.querySelector("#expand-filters")?.addEventListener("click", () => {
    filterState.expanded = !filterState.expanded;
    renderExplore(app);
  });

  app.querySelectorAll("[data-filter-category]").forEach((button) => {
    button.addEventListener("click", () => {
      const category = button.dataset.filterCategory;
      filterState.category = category;
      filterState.term = category === "all" ? null : button.dataset.filterTerm;
      if (category !== "all") filterState.expanded = true;
      renderExplore(app);
    });
  });

  app.querySelectorAll("[data-filter-jump]").forEach((button) => {
    button.addEventListener("click", () => {
      filterState.category = button.dataset.filterJump;
      filterState.term = null;
      filterState.expanded = true;
      renderExplore(app);
    });
  });

  renderGrid(app);
}
