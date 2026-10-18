// memoryLabels — 视觉档案的展示词汇 (P5.1.5).
// Pure presentational helpers shared by pages/memory.js and memoryCard.js.
// These label the VisualMemory's storage fields for humans; they are NOT
// retrieval vocabulary and never participate in scoring.

export const SOURCE_LABELS = {
  "user-upload": "用户上传",
  "film-still": "电影剧照",
  photo: "照片",
  "ai-generated": "AI 生成",
  "artwork-reference": "绘画参考",
  example: "示例",
};

export function sourceLabel(source) {
  return SOURCE_LABELS[source] || String(source || "");
}

export function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}