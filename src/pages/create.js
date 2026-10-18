// CREATE: references first, language second, prompt last.
import { artworks, findArtwork } from "../data/artworks.js";
import { setRouteActive, attachCopyHandlers } from "../app/events.js";
import { artworkFigure } from "../components/artworkFigure.js";
import { renderImg, bindImgFallback, aspectRatioCss, PICK_SIZES } from "../utils/image.js";
import { escapeHtml } from "../utils/html.js";
import { getStructuredPrompt } from "../services/aiService.js";
// R1.0-R1: the task context carried over from FIND (read-only consumers —
// the retrieval modules below are imported as pure functions, untouched).
import { getSnapshot, setPrinciple, clearPrinciple } from "../utils/taskContext.js";
import { intentFromArtwork, sharedReasons } from "../services/retrieval/artworkIntent.js";
import { scoreIntent } from "../services/retrieval/scoring.js";
import { intentSummary } from "../services/retrieval/visualIntentParser.js";
// R1.0-R2: deterministic prompt translation (pure, no AI call).
import {
  translatePrompt,
  finalPromptText,
  validatePrinciple,
  PRINCIPLE_FIELDS,
} from "../services/promptTranslation.js";
// STEP 4 — CREATE 导出。载荷由 promptExport.js 组装（纯函数），
// 落盘沿用 MEMORY 已经用过的 Blob + <a download> 路径。
import {
  buildPromptExport,
  promptExportToMarkdown,
  promptExportFileName,
  artworkExportRow,
} from "../utils/promptExport.js";
import { downloadText } from "../utils/download.js";
import { copyText } from "../utils/projectContext.js";

const PRINCIPLES = [
  ["spatial", "Spatial Composition", (artwork) => artwork.composition || artwork.spatialStructure],
  ["human", "Human Relation", (artwork) => (artwork.narrativeFunction || []).join(" / ")],
  ["color", "Color System", (artwork) => artwork.color],
  ["light", "Lighting", (artwork) => artwork.lighting],
  ["camera", "Camera Relation", (artwork) => artwork.creatorTranslation?.cinematic?.shotSize],
];

let selected = [];
// 参考墙是 auto-fill 的小卡（140–200px），而 imgAttrs 的默认 sizes 说的是
// 「单栏大图」（96vw / 31vw）。不改 sizes 的话手机端会按 96vw 去取 1920px 的
// detail 档（最大 2.7MB），一张缩略图等十几秒——这正是「大量图片加载不出来」
// 的第二个来源。候选宽度契约统一放在 utils/image.js 的 PICK_SIZES，三处网格共用。
// 最近一次真正生成出来的 Prompt 导出载荷。null = 还没生成过，
// 导出按钮保持禁用（绝不导出一份示例文本）。
let lastExport = null;

// 参考区可见候选的上限。以前是「有分析记录的前 12 件」，会把用户刚选中的
// 无分析作品挤出可视区 —— 于是「选择参考」这个动作在页面上像没发生。
// 现在 TaskContext 参考排前面，且不被这个上限截断。
const VISIBLE_PICKS = 12;

export function renderCreateIndex(app) {
  setRouteActive("create");
  // R1.0-R1: adopt the task context carried over from FIND (if any).
  const task = getSnapshot();
  syncTaskReferences(task);

  // TaskContext 参考优先，而且**不要求有分析记录**：它是用户刚刚亲手选的那件，
  // 藏起来等于让选择动作消失。去重靠 id，同一件不会既在前置区又出现在默认候选里。
  const seenIds = new Set();
  const taskPicks = [];
  for (const id of selected) {
    if (seenIds.has(id)) continue;
    const art = artworks.find((item) => item.id === id);
    if (!art) continue;
    seenIds.add(id);
    taskPicks.push(art);
  }
  const defaultPicks = artworks.filter(
    (artwork) => artwork.id && !seenIds.has(artwork.id) && artwork.image && !artwork.imageUnavailable
  );
  const rest = Math.max(0, VISIBLE_PICKS - taskPicks.length);
  const picks = [...taskPicks, ...defaultPicks.slice(0, rest)];

  const pickCard = (artwork) => {
    const on = selected.includes(artwork.id);
    const analysed = Boolean(artwork.hasAnalysis);
    // 无分析记录的作品照常显示真实图与来源，只明确标注它没有分析字段；
    // 绝不为它编造构图/光线/色彩 —— 视觉原则由 read() 读不到就自然缺席。
    const badge = analysed ? "" : '<small class="pick-flag">无分析记录 · 只贡献来源信息</small>';
    const thumb =
      artwork.image && !artwork.imageUnavailable
        ? `<span style="${aspectRatioCss(artwork)}">${renderImg(artwork, { sizes: PICK_SIZES })}</span>`
        : '<span class="pick-nofig" aria-hidden="true">无图</span>';
    return `
      <button type="button" data-create-pick="${escapeHtml(artwork.id)}" data-has-analysis="${analysed ? "1" : "0"}"
        class="${on ? "is-on" : ""}${taskPicks.includes(artwork) ? " is-task-ref" : ""}"
        aria-pressed="${on ? "true" : "false"}">
        ${thumb}
        <em>${escapeHtml(artwork.artistZh || artwork.artist)}</em>
        ${badge}
      </button>`;
  };

  app.innerHTML = `
    <section class="workflow">
      <p class="kicker">CREATE</p>
      <h1 class="workflow-title">先选参照，再写画面。</h1>
      <p class="quiet-note">选 2–4 幅作品。每幅只贡献它真正写过的视觉原则，缺的字段不会被补上。</p>
      <div class="create-picks" id="create-picks">
        ${picks.map(pickCard).join("")}
      </div>
      <p class="quiet-note create-picks-note" id="create-picks-note" hidden></p>
      <div id="create-language"></div>
      <div id="create-task" hidden></div>
    </section>
  `;
  // 真正解码失败的作品从参考墙移除，而不是留一张「图像暂不可用」的大卡。
  // 正在加载的只是 is-loading（呼吸光带），不算失败。
  bindImgFallback(app, {
    onBroken: (slot) => {
      const card = slot.closest("button[data-create-pick]");
      if (card) {
        card.classList.add("is-dead");
        card.setAttribute("aria-hidden", "true");
        if (card.classList.contains("is-on")) card.click();
      }
      const dropped = app.querySelectorAll("#create-picks button.is-dead").length;
      const note = app.querySelector("#create-picks-note");
      if (note && dropped) {
        note.hidden = false;
        note.textContent = `有 ${dropped} 件作品的图像在这次会话中未能解码，已从参考墙移除（不占据图片卡片）。`;
      }
    },
  });
  fillTaskContext(app, task);
  app.querySelectorAll("[data-create-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.createPick;
      selected = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id].slice(0, 4);
      const on = selected.includes(id);
      button.classList.toggle("is-on", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
      renderLanguage(app);
    });
  });
  if (selected.length) renderLanguage(app);
}

function renderLanguage(app) {
  const works = selected.map((id) => findArtwork(id)).filter(Boolean);
  const box = app.querySelector("#create-language");
  if (works.length < 2) {
    lastExport = null;
    box.innerHTML = `<p class="quiet-note">再选 ${2 - works.length} 幅，才能组成一种视觉语言。</p>`;
    return;
  }
  // R1.0-R1: with a live task intent, rank the references by how well
  // their derived intent matches it. No intent → original order, unchanged.
  const task = getSnapshot();
  const ranked =
    task.fresh && task.intent
      ? [...works].sort(
          (a, b) =>
            scoreIntent(task.intent, intentFromArtwork(b)).score -
            scoreIntent(task.intent, intentFromArtwork(a)).score
        )
      : works;
  const lines = PRINCIPLES.map(([key, label, read]) => {
    const parts = ranked
      .map((artwork) => ({ artwork, text: read(artwork) }))
      .filter((item) => item.text);
    return { key, label, parts };
  }).filter((line) => line.parts.length);
  box.innerHTML = `
    <section class="language-sheet">
      <h2>MY VISUAL LANGUAGE</h2>
      ${lines
        .map(
          (line) => `
        <label class="language-line">
          <input type="checkbox" data-keep="${line.key}" checked />
          <span>
            <strong>${line.label}</strong>
            ${line.parts
              .map(
                (part) =>
                  `<em>${escapeHtml(part.artwork.artist)} → ${escapeHtml(String(part.text).slice(0, 90))}</em>`
              )
              .join("")}
          </span>
        </label>`
        )
        .join("")}
      <div id="principle-editor"></div>
      <button class="primary-action" type="button" id="make-prompt">生成结构化 Prompt</button>
      <div id="made-prompt"></div>
      <section class="prompt-export" id="prompt-export">
        <h3>导出这次创作</h3>
        <div class="prompt-export-actions">
          <button class="ghost-action" type="button" data-prompt-export="copy" disabled>复制 Prompt</button>
          <button class="ghost-action" type="button" data-prompt-export="markdown" disabled>导出 Markdown</button>
          <button class="ghost-action" type="button" data-prompt-export="json" disabled>导出 JSON</button>
        </div>
        <p class="quiet-note" data-prompt-export-note>还没有生成 Prompt——先点上面的「生成结构化 Prompt」。导出只写这一次的真实任务结果，不打包图片文件。</p>
      </section>
    </section>
  `;
  renderPrinciples(box);
  bindPromptExport(box);
  // 任何会改变 Prompt 内容的开关一被改动，上一次的导出载荷立即作废——
  // 宁可让用户重新生成，也不导出一份与界面不一致的文件。
  lastExport = null;
  syncPromptExport(box);
  box.querySelectorAll("[data-keep]").forEach((input) => {
    input.addEventListener("change", () => {
      lastExport = null;
      syncPromptExport(box);
    });
  });
  box.querySelector("#make-prompt").addEventListener("click", () => {
    const kept = new Set(
      [...box.querySelectorAll("[data-keep]:checked")].map((input) => input.dataset.keep)
    );
    // R1.0-R2 STEP 3: Color System is a real toggle now — it controls the
    // Color Prompt block (curated `color` text; the curated aigc set has no
    // colour prompt field, which is why the switch used to dangle).
    const blocks = {
      spatial: kept.has("spatial"),
      light: kept.has("light"),
      camera: kept.has("camera"),
      human: kept.has("human"),
      color: kept.has("color"),
    };
    const task = getSnapshot();
    const intent = task.fresh ? task.intent : null;
    const references = ranked.map((artwork) => ({
      artwork,
      // getStructuredPrompt stays the single curated-prompt access point.
      aigc: getStructuredPrompt(artwork) || {},
      color: artwork.color,
    }));
    // R1.0-R2 STEP 4: deterministic translation — intent, explicit
    // KEEP/REMOVE and the curated reference data all shape the final body.
    const result = translatePrompt({ intent, references, principles: task.principles, blocks });

    // R1.0-R1 layer kept intact: per-reference intent notes (why it matched).
    const notes = intent
      ? references
          .map((ref) => {
            const candidate = intentFromArtwork(ref.artwork);
            return {
              artist: ref.artwork.artist,
              reasons: sharedReasons(intent, candidate, 3),
              tempConflict:
                intent.colorTemperature &&
                candidate.colorTemperature &&
                intent.colorTemperature !== candidate.colorTemperature,
            };
          })
          .filter((note) => note.reasons.length || note.tempConflict)
      : [];
    const noteHtml = notes.length
      ? `<ul class="intent-notes" data-intent-notes>${notes
          .map(
            (note) =>
              `<li class="intent-note">${escapeHtml(note.artist)}：${escapeHtml(note.reasons.join(" / "))}${
                note.tempConflict ? " · 与当前意图存在色温冲突" : ""
              }</li>`
          )
          .join("")}</ul>`
      : "";

    const section = (title, lines, kind) =>
      lines.length
        ? `<section class="prompt-section" data-prompt-section="${kind}">
            <h4>${escapeHtml(title)}</h4>
            ${lines
              .map(
                (line) => `<div class="field-block">
                  <span>${escapeHtml(line.label)}${line.artist ? ` · ${escapeHtml(line.artist)}` : ""}</span>
                  <p${line.kind === "negative" ? ' class="prompt-negative"' : ""}>${escapeHtml(line.text)}</p>
                </div>`
              )
              .join("")}
          </section>`
        : "";

    box.querySelector("#made-prompt").innerHTML = `
      ${noteHtml}
      ${section("参考派生原则", result.referencePrinciples, "reference")}
      ${section("当前意图约束", result.intentConstraints, "intent")}
      ${section("KEEP 要求", result.keepRequirements, "keep")}
      ${section("REMOVE 限制", result.removeRequirements, "remove")}
      ${
        result.conflicts.length
          ? `<section class="prompt-conflicts" data-prompt-conflicts>
              <h4>冲突处理说明</h4>
              <ul>${result.conflicts.map((c) => `<li>${escapeHtml(c.explanation)}</li>`).join("")}</ul>
            </section>`
          : ""
      }
      ${
        result.skipped.length
          ? `<details class="prompt-skipped" data-prompt-skipped>
              <summary>已跳过的字段（${result.skipped.length}）</summary>
              <ul>${result.skipped
                .map(
                  (s) =>
                    `<li>${escapeHtml(`${s.field || s.block || s.kind}${s.value ? `=${s.value}` : ""}`)} — ${escapeHtml(
                      String(s.reason)
                    )}</li>`
                )
                .join("")}</ul>
            </details>`
          : ""
      }
      <div id="final-prompt-body" class="final-prompt-body" hidden>${escapeHtml(finalPromptText(result))}</div>
      <button class="ghost-action" type="button" data-copy-target="#final-prompt-body">复制最终 Prompt</button>
    `;
    attachCopyHandlers(box);

    // STEP 4：把「这一次真的生成出来的东西」存成导出载荷，并解锁导出按钮。
    lastExport = buildPromptExport({
      generatedAt: new Date().toISOString(),
      promptText: finalPromptText(result),
      sections: {
        referencePrinciples: result.referencePrinciples,
        intentConstraints: result.intentConstraints,
        keepRequirements: result.keepRequirements,
        removeRequirements: result.removeRequirements,
      },
      conflicts: result.conflicts,
      skipped: result.skipped,
      blocks,
      intent,
      intentFresh: Boolean(task.fresh),
      principles: task.principles,
      references: ranked.map(artworkExportRow),
      taskReferenceKeys: task.referenceKeys,
    });
    syncPromptExport(box);
  });
}

// 导出区只有两种状态：还没生成（禁用 + 说明原因）、已生成（可用 + 写清包里有什么）。
function syncPromptExport(box) {
  const host = box.querySelector("#prompt-export");
  if (!host) return;
  const note = host.querySelector("[data-prompt-export-note]");
  const buttons = [...host.querySelectorAll("[data-prompt-export]")];
  const ready = Boolean(lastExport && lastExport.prompt.text);
  buttons.forEach((button) => {
    button.disabled = !ready;
  });
  if (!note) return;
  if (!ready) {
    note.textContent = "还没有生成 Prompt——先点上面的「生成结构化 Prompt」。导出只写这一次的真实任务结果，不打包图片文件。";
    return;
  }
  const intentCount = lastExport.visualIntent ? Object.keys(lastExport.visualIntent).length : 0;
  note.textContent =
    `已就绪：Prompt 正文 · ` +
    (lastExport.visualIntent ? `当前 VisualIntent（${intentCount} 个字段）` : `VisualIntent：无（直接进入 CREATE，走静态路径）`) +
    ` · ${lastExport.references.length} 件参考作品（含名称、来源链接、许可信息）· 生成时间 ${lastExport.generatedAt} · 数据版本 v${lastExport.version}。`;
}

// 三个动作：复制 Prompt / 导出 Markdown / 导出 JSON。
// 全部基于 lastExport —— 没有它按钮是 disabled 的，所以不存在导出示例文本的路径。
function bindPromptExport(box) {
  const host = box.querySelector("#prompt-export");
  if (!host) return;
  host.querySelectorAll("[data-prompt-export]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!lastExport) return;
      const kind = button.dataset.promptExport;
      if (kind === "copy") {
        const ok = await copyText(lastExport.prompt.text);
        flashInline(button, ok ? "已复制 Prompt" : "复制失败");
        return;
      }
      const payload =
        kind === "markdown"
          ? promptExportToMarkdown(lastExport)
          : JSON.stringify(lastExport, null, 2);
      const ext = kind === "markdown" ? "md" : "json";
      const mime = kind === "markdown" ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8";
      const ok = downloadText(promptExportFileName(lastExport, ext), payload, mime);
      flashInline(button, ok ? `已导出 ${ext.toUpperCase()}` : "导出失败：浏览器不支持下载");
    });
  });
}

// 页面内的一次性反馈，不用 alert。
function flashInline(button, text) {
  const original = button.textContent;
  button.textContent = text;
  button.disabled = true;
  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1800);
}

// R1.0-R2: explicit KEEP / REMOVE per (field, value) — three states:
// KEEP, REMOVE, UNSET. Clicking an active choice clears it back to UNSET,
// which is deliberately NOT a removal. Without a live task (expired or
// direct entry) the whole editor stays disabled — R1's static path.
function renderPrinciples(box) {
  const host = box.querySelector("#principle-editor");
  if (!host) return;
  const task = getSnapshot();
  const active = new Map(task.principles.map((p) => [`${p.field}=${p.value}`, p.action]));
  const disabled = !task.fresh;
  host.innerHTML = `
    <section class="principle-editor" data-principle-editor>
      <h3>原则要求 · KEEP / REMOVE</h3>
      ${
        disabled
          ? `<p class="quiet-note" data-principle-disabled>当前没有进行中的任务（直接进入或已过期）——原则要求不可设置，Prompt 保持静态路径。</p>`
          : ""
      }
      ${Object.entries(PRINCIPLE_FIELDS)
        .map(
          ([field, spec]) => `
        <div class="principle-row" data-principle-row="${escapeHtml(field)}">
          <span class="principle-label">${escapeHtml(spec.label)}</span>
          <div class="principle-choices">
            ${spec.values
              .map(
                (value) => ["keep", "remove"]
                  .map((action) => {
                    const on = active.get(`${field}=${value}`) === action;
                    return `<button type="button" class="principle-choice${on ? " is-on" : ""}" data-principle-field="${escapeHtml(field)}" data-principle-value="${escapeHtml(value)}" data-principle-action="${action}" data-principle-active="${on}"${disabled ? " disabled" : ""}>${action === "keep" ? "KEEP" : "REMOVE"} ${escapeHtml(value)}</button>`;
                  })
                  .join("")
              )
              .join("")}
          </div>
        </div>`
        )
        .join("")}
      <p class="quiet-note">取消已选中的项 = 回到未设置（UNSET），不等于 REMOVE。取值均来自既有 VisualIntent 枚举，不做额外推断。</p>
    </section>
  `;
  host.querySelectorAll("[data-principle-field]").forEach((button) => {
    button.addEventListener("click", () => {
      const field = button.dataset.principleField;
      const value = button.dataset.principleValue;
      const action = button.dataset.principleAction;
      if (active.get(`${field}=${value}`) === action) {
        clearPrinciple(field, value); // back to UNSET — not a removal
      } else {
        const check = validatePrinciple({ field, value, action });
        if (!check.ok) return; // vocabulary gate: illegal field/value never stored
        setPrinciple({ field, value, action, sourceReferenceKey: task.referenceKeys[0] || null });
      }
      renderPrinciples(box);
      // 原则要求变了 → 上一次生成的导动作废（见 renderLanguage 顶部注释）。
      lastExport = null;
      syncPromptExport(box);
    });
  });
}

// R1.0-R1: references the user actually picked in FIND join the CREATE
// selection (local artworks only — remote archive entries have no id and
// never enter the selection).
function syncTaskReferences(task) {
  if (!task.fresh) return;
  for (const key of task.referenceKeys) {
    const art = artworks.find((item) => item.key === key);
    if (!art || !art.id) continue;
    if (!selected.includes(art.id)) selected = [...selected, art.id].slice(0, 4);
  }
}

// R1.0-R1: surface the carried-over task so the user can see why prompt
// generation differs from the static one. No live intent → nothing shown,
// which keeps the original static page intact.
function fillTaskContext(app, task) {
  const box = app.querySelector("#create-task");
  if (!box) return;
  if (!task.fresh || !task.intent) {
    box.innerHTML = "";
    box.hidden = true;
    return;
  }
  const fields = intentSummary(task.intent);
  const refs = task.referenceKeys.map((key) => artworks.find((item) => item.key === key)).filter(Boolean);
  box.hidden = false;
  box.innerHTML = `
    <section class="task-context-card">
      <p class="kicker">当前任务 · 来自 FIND</p>
      <h2>跨页延续的视觉意图</h2>
      <ul>${fields.map((line) => `<li>${escapeHtml(line)}</li>`).join("") || "<li>没有足够规则可解析</li>"}</ul>
      ${
        refs.length
          ? `<p class="quiet-note">FIND 中选择的参考：${refs.map((r) => escapeHtml(r.titleZh || r.title)).join(" / ")}</p>`
          : `<p class="quiet-note">还没有在 FIND 中选择具体参考——点击结果卡即可把它带入这里。</p>`
      }
      <p class="quiet-note">该意图将参与下方 Prompt 生成（匹配理由 / 色温冲突标注）；开始新的 FIND 搜索会重置任务。</p>
    </section>
  `;
}

export function renderCreate(app, id) {
  const artwork = findArtwork(String(id || "").replace(/^local:/, ""));
  if (artwork && !selected.includes(artwork.id)) selected = [...selected, artwork.id].slice(0, 4);
  renderCreateIndex(app);
}
