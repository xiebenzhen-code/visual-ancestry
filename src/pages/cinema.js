// CINEMA — painting ↔ film reference ledger. Every relation carries a
// relationType from the closed enum and an evidence level. Visual
// similarity is never written as "the director explicitly referenced".

import { filmReferences } from "../data/filmReferences.js";
import { findArtwork } from "../data/artworks.js";
import { setRouteActive } from "../app/events.js";
import { artworkImageUrl } from "../utils/assets.js";
import { escapeHtml } from "../utils/html.js";
import { locationLabel } from "../services/locationService.js";

const RELATION_LABEL = {
  DOCUMENTED_REFERENCE: "有据可查的参考",
  DIRECT_RECREATION: "直接复现",
  COMPOSITIONAL_PARALLEL: "构图平行",
  LIGHTING_PARALLEL: "光线平行",
  COLOR_PARALLEL: "色彩平行",
  SPATIAL_PARALLEL: "空间平行",
  THEMATIC_PARALLEL: "主题平行",
};

export function renderCinema(app) {
  setRouteActive("cinema");
  const rows = filmReferences
    .map((reference) => {
      const artwork = findArtwork(reference.artworkId);
      if (!artwork) return "";
      const image = artwork.imageUnavailable
        ? `<div class="cinema-thumb is-unavailable"><span>仅分析</span></div>`
        : `<img src="${artworkImageUrl(artwork)}" alt="${escapeHtml(artwork.titleZh)}" loading="lazy" />`;
      return `
        <a class="cinema-row" href="#create/${artwork.id}">
          ${image}
          <div>
            <span>${escapeHtml(artwork.artistZh)} · ${escapeHtml(artwork.year)} → ${escapeHtml(reference.director)} · ${reference.year}</span>
            <strong>${escapeHtml(artwork.titleZh)} × ${escapeHtml(reference.filmTitleZh)}</strong>
            <p>${escapeHtml(reference.description)}</p>
            <div class="film-ref-tags">
              <em>${escapeHtml(RELATION_LABEL[reference.relationType] || reference.relationType)}</em>
              <em>${escapeHtml(reference.evidenceLevel)}</em>
              ${reference.location ? `<em>${escapeHtml(locationLabel(reference.location))}</em>` : ""}
            </div>
          </div>
        </a>
      `;
    })
    .join("");

  app.innerHTML = `
    <section class="cinema-page">
      <header class="taxonomy-head">
        <p class="kicker">CINEMA</p>
        <h1>PAINTING / FRAME</h1>
        <p>绘画与电影的对照档案。每条关系都标注关系类型与证据等级：没有文献记载时只写“平行”，不声称导演明确参考。电影画面版权归原权利方，本页不内置电影截图。</p>
      </header>
      <div class="cinema-list">
        ${rows}
      </div>
    </section>
  `;
}
