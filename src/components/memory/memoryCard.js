// memoryCard — 档案索引中的一张视觉记忆卡片 (P5.1.5 → P5.1.8).
// Pure presentational: takes a VisualMemory, returns an HTML string.
//   - success: thumbnail + editorial title + Chinese visual-intent chips.
//   - failed:  error badge + user-facing message + 「重新分析」retry button
//              (P5.1.8 — failures are visible and recoverable, not erased).
// Never renders a recommendation section, never touches retrieval/scoring.

import { escapeHtml } from "../../utils/html.js";
import { sourceLabel, formatDate } from "./memoryLabels.js";

const CARD_CHIP_SOURCES = [
  ["atmosphere", "氛围 · "],
  ["emotion", "情绪 · "],
];

function summaryChips(intent) {
  const chips = [];
  for (const [field, prefix] of CARD_CHIP_SOURCES) {
    if (Array.isArray(intent[field]) && intent[field].length) {
      chips.push(`${prefix}${intent[field][0]}`);
    }
  }
  if (intent.colorTemperature) {
    chips.push({ cool: "色温 · 冷色", warm: "色温 · 暖色", neutral: "色温 · 中性" }[intent.colorTemperature] || "");
  }
  if (intent.saturation) {
    chips.push({ low: "饱和 · 低", medium: "饱和 · 中", high: "饱和 · 高" }[intent.saturation] || "");
  }
  if (intent.negativeSpace) {
    chips.push({ high: "留白 · 多", low: "留白 · 少" }[intent.negativeSpace] || "");
  }
  return chips.filter(Boolean).slice(0, 4);
}

function failedCard(memory) {
  const meta = memory.metadata || {};
  const userData = memory.userData || {};
  const thumb = userData.thumbnail || "";
  const id = escapeHtml(memory.id);
  const err = memory.error || {};

  return `
    <article class="memory-card memory-card-failed">
      <div class="memory-card-media">
        ${
          thumb
            ? `<img src="${thumb}" alt="${escapeHtml(meta.title || "视觉素材")}" />`
            : `<div class="memory-card-placeholder">${escapeHtml((meta.title || "图").slice(0, 1))}</div>`
        }
        <span class="memory-card-badge">分析失败</span>
      </div>
      <div class="memory-card-body">
        <h3>${escapeHtml(meta.title || "未命名素材")}</h3>
        <p class="memory-card-meta">${escapeHtml(sourceLabel(memory.source))} · ${escapeHtml(formatDate(meta.createdAt) || "—")}</p>
        <p class="memory-card-error">${escapeHtml(err.message || "发生未知错误，请重新尝试。")}</p>
        <div class="memory-card-actions">
          <button class="memory-retry" type="button" data-retry-memory="${id}">重新分析</button>
          <button class="memory-delete" type="button" data-memory-delete="${id}" aria-label="删除 ${id}">删除</button>
        </div>
      </div>
    </article>
  `;
}

export function memoryCard(memory) {
  if (memory.status === "failed") return failedCard(memory);

  const meta = memory.metadata || {};
  const userData = memory.userData || {};
  const intent = memory.visualIntent || {};
  const thumb = userData.thumbnail || "";
  const id = escapeHtml(memory.id);

  return `
    <article class="memory-card">
      <a class="memory-card-media" href="#memory/${id}">
        ${
          thumb
            ? `<img src="${thumb}" alt="${escapeHtml(meta.title || "视觉素材")}" />`
            : `<div class="memory-card-placeholder">${escapeHtml((meta.title || "图").slice(0, 1))}</div>`
        }
      </a>
      <div class="memory-card-body">
        <h3><a href="#memory/${id}">${escapeHtml(meta.title || "未命名素材")}</a></h3>
        <p class="memory-card-meta">
          ${escapeHtml(sourceLabel(memory.source))}
          ${meta.createdAt ? ` · ${escapeHtml(formatDate(meta.createdAt))}` : ""}
        </p>
        <div class="memory-chips memory-card-chips">
          ${summaryChips(intent).map((chip) => `<span class="memory-chip">${escapeHtml(chip)}</span>`).join("")}
        </div>
        <button class="memory-delete memory-card-delete" type="button" data-memory-delete="${id}" aria-label="删除 ${id}">删除</button>
      </div>
    </article>
  `;
}