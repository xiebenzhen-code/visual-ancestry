// Composition overlay — SVG analysis layer for SHOOT mode.
// Default is OFF: the artwork is shown clean. The overlay only appears
// after the user explicitly asks for 构图分析, and can be hidden again.
//
// Supported marks (all optional, driven by artwork.shootTranslation.overlay):
//   thirds, center, horizon, diagonal, vanishingPoint, subjectArea,
//   negativeSpace, zones { foreground, midground }, eyeDirection { x,y,dx,dy }

import { escapeHtml } from "../utils/html.js";

const STROKE = "#a93228";
const FILL = "rgba(169, 50, 40, 0.12)";

function line(x1, y1, x2, y2, dashed = true) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${STROKE}" stroke-width="0.35" ${
    dashed ? 'stroke-dasharray="1.6 1.2"' : ""
  } vector-effect="non-scaling-stroke" />`;
}

function rect(x, y, w, h, filled = false) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${filled ? FILL : "none"}" stroke="${STROKE}" stroke-width="0.35" stroke-dasharray="1.6 1.2" vector-effect="non-scaling-stroke" />`;
}

function label(x, y, text) {
  return `<text x="${x}" y="${y}" fill="${STROKE}" font-size="3.1" font-family="sans-serif">${escapeHtml(text)}</text>`;
}

export function overlaySvg(overlay) {
  if (!overlay) return "";
  const parts = [];

  if (overlay.thirds) {
    parts.push(line(33.33, 0, 33.33, 100), line(66.66, 0, 66.66, 100));
    parts.push(line(0, 33.33, 100, 33.33), line(0, 66.66, 100, 66.66));
    parts.push(label(1.5, 4, "三分线"));
  }
  if (overlay.center) {
    parts.push(line(50, 0, 50, 100));
    parts.push(label(51, 4, "中轴线"));
  }
  if (typeof overlay.horizon === "number") {
    const y = overlay.horizon * 100;
    parts.push(line(0, y, 100, y, false));
    parts.push(label(1.5, y - 1.2, "地平线"));
  }
  if (overlay.diagonal) {
    if (overlay.diagonal === "main" || overlay.diagonal === "both") parts.push(line(0, 100, 100, 0));
    if (overlay.diagonal === "anti" || overlay.diagonal === "both") parts.push(line(0, 0, 100, 100));
    parts.push(label(70, 30, "对角线"));
  }
  if (overlay.vanishingPoint) {
    const { x, y } = overlay.vanishingPoint;
    parts.push(`<circle cx="${x * 100}" cy="${y * 100}" r="1.4" fill="none" stroke="${STROKE}" stroke-width="0.4" vector-effect="non-scaling-stroke" />`);
    parts.push(line(x * 100, 0, x * 100, y * 100), line(0, y * 100, x * 100, y * 100));
    parts.push(label(x * 100 + 2, y * 100 - 1.5, "消失点"));
  }
  if (overlay.zones) {
    if (typeof overlay.zones.foreground === "number") {
      const y = overlay.zones.foreground * 100;
      parts.push(line(0, y, 100, y));
      parts.push(label(88, y - 1.2, "前景"));
    }
    if (typeof overlay.zones.midground === "number") {
      const y = overlay.zones.midground * 100;
      parts.push(line(0, y, 100, y));
      parts.push(label(88, y - 1.2, "中景"));
    }
  }
  if (overlay.negativeSpace) {
    const { x, y, w, h } = overlay.negativeSpace;
    parts.push(rect(x * 100, y * 100, w * 100, h * 100, true));
    parts.push(label(x * 100 + 1.5, y * 100 + 4, "留白"));
  }
  if (overlay.subjectArea) {
    const { x, y, w, h } = overlay.subjectArea;
    parts.push(rect(x * 100, y * 100, w * 100, h * 100));
    parts.push(label(x * 100 + 1.5, y * 100 - 1.2, "主体"));
  }
  if (overlay.eyeDirection) {
    const { x, y, dx, dy } = overlay.eyeDirection;
    const x2 = x * 100 + dx * 26;
    const y2 = y * 100 + dy * 26;
    parts.push(
      `<line x1="${x * 100}" y1="${y * 100}" x2="${x2}" y2="${y2}" stroke="${STROKE}" stroke-width="0.45" marker-end="url(#ov-arrow)" vector-effect="non-scaling-stroke" />`
    );
    parts.push(label(x2 + 1, y2 + 1, "视线"));
  }

  return `
    <svg class="overlay-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <marker id="ov-arrow" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="${STROKE}" />
        </marker>
      </defs>
      ${parts.join("")}
    </svg>
  `;
}
