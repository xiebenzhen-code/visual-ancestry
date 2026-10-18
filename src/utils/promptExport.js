// promptExport.js — CREATE 任务结果的导出载荷（纯函数，无 DOM）。
//
// 只导出「这次真的生成出来的东西」：
//   · 实际 Prompt 正文（finalPromptText 的同一份文本）
//   · 当前 VisualIntent（任务存在时）与 KEEP / REMOVE 要求
//   · 用户在 CREATE 里真正选中的参考作品，及其名称、作者、来源链接与已知许可/权利描述
//   · 生成时间、导出时间、数据版本
//
// 明确不做的事：
//   · 不打包图片文件（只记录来源与链接，图片仍在 public/assets 里按需取用）
//   · 不填示例文本：没有生成过 Prompt 时，UI 直接禁用导出，而不是导出一份空壳
//   · 不推断缺失字段：作品的 museum / rights / source 缺了就写 null

export const PROMPT_EXPORT_FORMAT = "visual-ancestry-create-prompt";
export const PROMPT_EXPORT_VERSION = 1;

// 一份参考作品 → 导出用的一行。字段全部来自作品记录本身。
export function artworkExportRow(artwork) {
  return {
    id: artwork.id,
    key: artwork.key,
    titleZh: artwork.titleZh || null,
    title: artwork.title || artwork.titleEn || null,
    artist: artwork.artist || null,
    artistZh: artwork.artistZh || null,
    year: artwork.year || null,
    museum: artwork.museum || null,
    source: artwork.source
      ? {
          name: artwork.source.name || null,
          url: artwork.source.url || null,
          rightsStatus: artwork.source.rightsStatus || artwork.rightsStatus || null,
          evidenceLevel: artwork.source.evidenceLevel || artwork.evidenceLevel || null,
        }
      : null,
    image: {
      fileName: (artwork.image && artwork.image.fileName) || null,
      shippedTier: (artwork.image && artwork.image.tiers && artwork.image.tiers.detail) || null,
    },
  };
}

function sectionLines(section) {
  return (section || []).map((line) => ({
    label: line.label || null,
    artist: line.artist || null,
    text: line.text || "",
  }));
}

export function buildPromptExport({
  generatedAt = new Date().toISOString(),
  promptText = "",
  sections = {},
  conflicts = [],
  skipped = [],
  blocks = null,
  intent = null,
  intentFresh = false,
  principles = [],
  references = [],
  taskReferenceKeys = [],
} = {}) {
  return {
    format: PROMPT_EXPORT_FORMAT,
    version: PROMPT_EXPORT_VERSION,
    generatedAt,
    exportedAt: new Date().toISOString(),
    prompt: {
      text: promptText,
      blocks: blocks || null,
      sections: {
        referencePrinciples: sectionLines(sections.referencePrinciples),
        intentConstraints: sectionLines(sections.intentConstraints),
        keepRequirements: sectionLines(sections.keepRequirements),
        removeRequirements: sectionLines(sections.removeRequirements),
      },
      conflicts: (conflicts || []).map((c) => c.explanation || String(c)),
      skipped: (skipped || []).map((s) => ({
        field: s.field || s.block || s.kind || null,
        value: s.value || null,
        reason: s.reason ? String(s.reason) : null,
      })),
    },
    // 直接进入 CREATE（没有进行中的 FIND 任务）时 intent 为 null —— 这是事实，
    // 不补一个空意图冒充「当前意图」。
    visualIntent: intent || null,
    intentSource: intent ? (intentFresh ? "current-find-task" : "provided") : "none",
    principles: (principles || []).map((p) => ({
      field: p.field,
      value: p.value,
      action: p.action,
      sourceReferenceKey: p.sourceReferenceKey || null,
    })),
    references,
    taskReferenceKeys: taskReferenceKeys || [],
    mediaPolicy: "不含图片文件；只记录作品名称、来源链接与许可信息。",
  };
}

export function promptExportToMarkdown(payload) {
  const lines = [];
  const push = (line = "") => lines.push(line);
  push(`# CREATE Prompt 导出 · ${payload.generatedAt}`);
  push(`> ${payload.format} v${payload.version} · 导出时间 ${payload.exportedAt}`);
  push();
  push(`## Prompt`);
  push();
  push(payload.prompt.text || "（空）");
  push();

  const s = payload.prompt.sections;
  const section = (title, rows) => {
    if (!rows.length) return;
    push(`## ${title}`);
    for (const row of rows) {
      push(`- ${row.label ? `${row.label}：` : ""}${row.artist ? `${row.artist} → ` : ""}${row.text}`);
    }
    push();
  };
  section("参考派生原则", s.referencePrinciples);
  section("当前意图约束", s.intentConstraints);
  section("KEEP 要求", s.keepRequirements);
  section("REMOVE 限制", s.removeRequirements);

  if (payload.prompt.conflicts.length) {
    push(`## 冲突处理说明`);
    for (const c of payload.prompt.conflicts) push(`- ${c}`);
    push();
  }
  if (payload.prompt.skipped.length) {
    push(`## 已跳过的字段 (${payload.prompt.skipped.length})`);
    for (const x of payload.prompt.skipped) push(`- ${x.field || "?"}${x.value ? `=${x.value}` : ""} — ${x.reason || ""}`);
    push();
  }

  push(`## 当前 VisualIntent`);
  if (payload.visualIntent) {
    for (const [key, value] of Object.entries(payload.visualIntent)) {
      if (value === null || value === undefined || value === "") continue;
      // 空数组也要跳过：[] 不是 ""，会漏过上面的判断，
      // 然后 join() 出空串，导出里留下一条 "- emotion: " 的空 bullet
      //（Agent 实测发现）。空 bullet 不是信息，是让读的人以为漏了内容。
      if (Array.isArray(value) && value.length === 0) continue;
      push(`- ${key}: ${Array.isArray(value) ? value.join(" / ") : value}`);
    }
  } else {
    push(`- 无（直接进入 CREATE，本次 Prompt 走静态路径）`);
  }
  push();

  if (payload.principles.length) {
    push(`## 原则要求 (KEEP / REMOVE)`);
    for (const p of payload.principles) push(`- ${p.action.toUpperCase()} ${p.field}=${p.value}`);
    push();
  }

  push(`## 参考作品 (${payload.references.length})`);
  for (const r of payload.references) {
    push(`- ${r.titleZh || r.title} / ${r.title || ""}`);
    push(`  - 作者: ${r.artistZh || ""} ${r.artist ? `(${r.artist})` : ""} · ${r.year || "年份未记录"}`);
    if (r.museum) push(`  - 馆藏: ${r.museum}`);
    if (r.source) {
      push(`  - 来源: ${r.source.name || "未记录"}${r.source.url ? ` · ${r.source.url}` : ""}`);
      if (r.source.rightsStatus) push(`  - 权利: ${r.source.rightsStatus}`);
      if (r.source.evidenceLevel) push(`  - 证据等级: ${r.source.evidenceLevel}`);
    } else {
      push(`  - 来源: 未记录`);
    }
  }
  push();
  push(`> ${payload.mediaPolicy}`);
  return lines.join("\n");
}

export function promptExportFileName(payload, ext) {
  const stamp = String(payload.generatedAt || "").slice(0, 10) || "undated";
  return `visual-ancestry-prompt-${stamp}.${ext}`;
}
