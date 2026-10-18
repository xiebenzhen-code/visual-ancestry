// Artwork figure — renders the artwork image at its original ratio
// (object-fit: contain, no cropping, no text burned onto the image),
// or an honest placeholder when no image is bundled. Optionally wraps it
// with the composition overlay layer.
//
// The placeholder states the RECORDED reason, never an inferred one.
// "imageUnavailable" only says we ship no file; it does not say why. Some
// records here are in copyright (Magritte d. 1967, Rothko d. 1970), but
// others are pre-1929 impressions whose public-domain status must be checked
// per impression — calling all of them "still in copyright" states as fact
// something the data only records as uncertain.

import { artworkImageUrl } from "../utils/assets.js";
import { escapeHtml } from "../utils/html.js";
import { overlaySvg } from "./compositionOverlay.js";

// One shared, honest sentence: what we know (no image bundled) and why we
// cannot say more (the reason is per-record and not always a copyright one).
export function unavailableReason(artwork) {
  const recorded = (artwork.rightsStatus || "").trim();
  return recorded
    ? `未收录图像 · ${recorded}`
    : "未收录图像 · 收录原因见作品档案";
}

export function artworkFigure(artwork, { overlay = false, overlayId = "composition-overlay" } = {}) {
  const overlayMarkup = overlay && artwork.shootTranslation.overlay ? overlaySvg(artwork.shootTranslation.overlay) : "";
  if (artwork.imageUnavailable) {
    return `
      <div class="art-figure is-unavailable">
        <div class="unavailable-note">
          <strong>${escapeHtml(artwork.titleZh)}</strong>
          <span>${escapeHtml(unavailableReason(artwork))}</span>
          <span>本页只提供画面分析，不展示作品图像</span>
        </div>
        ${overlayMarkup ? `<div class="overlay-layer" id="${overlayId}" hidden>${overlayMarkup}</div>` : ""}
      </div>
    `;
  }
  return `
    <div class="art-figure">
      <img src="${artworkImageUrl(artwork)}" alt="${escapeHtml(artwork.titleZh)} by ${escapeHtml(artwork.artist)}" />
      ${overlayMarkup ? `<div class="overlay-layer" id="${overlayId}" hidden>${overlayMarkup}</div>` : ""}
    </div>
  `;
}
