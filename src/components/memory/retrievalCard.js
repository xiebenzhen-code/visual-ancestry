// retrievalCard — 检索结果的匹配卡片 (P5.2.2 STEP 3).
// Pure presentational: takes one retrieval evidence object
//   { id, score, matchedFields, reasons, memory }
// and renders the image + WHY it matched. Reasons are already Chinese
// (frozen sharedReasons + personalReasons list labels). matchedFields are
// field names → shown through a display-only Chinese label map.
//
// Tool language, not AI language: never renders "AI认为/模型觉得". The card
// states visual facts ("氛围 · 寂静", "纵深很深") — the same vocabulary the
// user picked when building the query. Nothing here scores/filters/ranks.
import { escapeHtml } from "../../utils/html.js";
import { sourceLabel } from "./memoryLabels.js";

// Display-only field-name → Chinese label. NEVER used for scoring/retrieval —
// it merely spells matchedFields for humans on the evidence card.
const FIELD_LABELS = {
  atmosphere: "氛围",
  emotion: "情绪",
  subject: "主体",
  subjectScale: "主体尺度",
  spatialDepth: "空间纵深",
  negativeSpace: "留白",
  environmentDominance: "环境主导",
  lightDirection: "光线方向",
  lightQuality: "光线质感",
  colorTemperature: "色温",
  saturation: "饱和度",
  contrast: "对比度",
  humanRelation: "人物关系",
  cameraDistance: "机位距离",
  cameraHeight: "机位高度",
  cameraRelation: "机位关系",
  motion: "动态",
  visualDensity: "视觉密度",
  arousal: "唤醒度",
  socialDistance: "社交距离",
  melancholy: "忧郁感",
};

function fieldLabel(field) {
  return FIELD_LABELS[field] || field;
}

export function retrievalCard(evidence) {
  const memory = evidence.memory || {};
  const meta = memory.metadata || {};
  const userData = memory.userData || {};
  const thumb = userData.thumbnail || "";
  const id = escapeHtml(evidence.id);
  const score = Number.isFinite(evidence.score) ? evidence.score : 0;

  const reasons = (evidence.reasons || []).map((r) => `<li>${escapeHtml(r)}</li>`).join("");
  const fields = (evidence.matchedFields || [])
    .map((f) => `<span class="retrieval-field">${escapeHtml(fieldLabel(f))}</span>`)
    .join("");

  return `
    <article class="retrieval-card">
      <a class="retrieval-card-media" href="#memory/${id}">
        ${
          thumb
            ? `<img src="${thumb}" alt="${escapeHtml(meta.title || "视觉素材")}" />`
            : `<div class="retrieval-card-placeholder">${escapeHtml((meta.title || "图").slice(0, 1))}</div>`
        }
      </a>
      <div class="retrieval-card-body">
        <h3><a href="#memory/${id}">${escapeHtml(meta.title || "未命名素材")}</a></h3>
        <p class="retrieval-card-meta">${escapeHtml(sourceLabel(memory.source))} · ${escapeHtml(memory.id)}</p>
        <p class="retrieval-card-why">为什么匹配</p>
        <ul class="retrieval-reasons">${reasons}</ul>
        ${
          fields
            ? `<div class="retrieval-fields">${fields}</div>`
            : ""
        }
        <p class="retrieval-score">匹配度 ${score.toFixed(1)}</p>
      </div>
    </article>
  `;
}
