// SHOOT — 现实拍摄参考系统. Not text-only advice: 拍什么 / 构图线 /
// 拍人指导 / 拍景指导 / 真实地点 / 类似地点特征.
// Plain language for ordinary people; professional terms live only inside
// the collapsible pro-notes.

import { artworks, findArtwork } from "../data/artworks.js";
import { filmStills } from "../data/filmStills.js";
import { filmStillAsArtwork, filmStillPool } from "../services/retrieval/retrievalService.js";
import { findByKey } from "../services/artService.js";
import { referencesForArtwork } from "../data/filmReferences.js";
import {
  setRouteActive,
  attachCopyHandlers,
  attachContextExport,
  attachSaveHandlers,
  attachOverlayToggle,
} from "../app/events.js";
import { artworkFigure } from "../components/artworkFigure.js";
import { artworkTile } from "../components/archiveGrid.js";
import { retrieveByImage, relationsFor, provenanceLabel, INTENT_PROVENANCE } from "../services/retrieval/retrievalService.js";
import { escapeHtml } from "../utils/html.js";
import { renderImg, bindImgFallback, aspectRatioCss, PICK_SIZES } from "../utils/image.js";
import { locationLabel } from "../services/locationService.js";
import { buildProjectContext, projectContextToMarkdown } from "../utils/projectContext.js";
import { track } from "../utils/profile.js";
// R1.0-R4 (RC-5): the live task feeds deterministic shooting decisions.
// getSnapshot() is read-only here — the R1 lifecycle is untouched.
import { getSnapshot } from "../utils/taskContext.js";
import { translateShoot, GROUP_LABELS } from "../services/shootTranslation.js";

const SUBJECT_TYPE_LABEL = {
  PERSON: "拍人",
  PLACE: "拍景",
  PERSON_PLACE: "人物与环境",
};

const SUBJECT_TYPE_DESC = {
  PERSON: "肖像 / 单人 / 人物姿态",
  PLACE: "风景 / 街景 / 室内空间",
  PERSON_PLACE: "人物与环境关系",
};

let shootFlow = { subject: null, mood: null };

export function renderShootIndex(app) {
  setRouteActive("shoot");
  const refs = artworks.filter((artwork) => artwork.image && artwork.shootTranslation && !artwork.imageUnavailable).slice(0, 8);
  // 电影画面墙：全部通过许可与画面身份核验的帧，按年份排序（1916→1936）。
  // 之前这里是两个一模一样的文字块（重复渲染的缺陷），且只有片名、没有画面 ——
  // 现在它是一面真的图像墙：与绘画参考卡同一个网格、同一条 tiered-image 管线。
  // P4.12 — 电影墙必须查过滤后的池，不能查原始 filmStills。
  // MEASURED 缺陷（独立审阅发现）：原先直接读 filmStills，于是 SHOOT 首屏
  // 铺出 14 张黑白/sepia 剧照；用户点进去却因按 id 解析已改为查过滤池，
  // 落到「暂无可用的 SHOOT 指导」——看得见、点不进，比漏过滤更难解释。
  const filmPool = filmStillPool();
  const filmRefs = filmPool
    .filter((item) => item.shootTranslation && item.image)
    .slice()
    .sort((a, b) => (a.film?.year ?? 0) - (b.film?.year ?? 0));
  app.innerHTML = `
    <section class="workflow">
      <p class="kicker">SHOOT</p>
      <h2 class="workflow-title">先有一张参照，再决定怎么拍。</h2>
      <label class="drop-zone">
        拖入一张本地照片，马上预览。不会上传。
        <input id="shoot-file" type="file" accept="image/*" hidden />
      </label>
      <img id="shoot-local-preview" alt="" hidden />
      <div id="shoot-image-note" class="find-image-error" hidden></div>
      <button class="ghost-action" type="button" id="shoot-image-find" hidden>用这张图找参考作品</button>
      <div class="create-picks">
        ${refs
          .map(
            (artwork) => `
          <a href="#shoot/${escapeHtml(artwork.key)}">
            <em>${escapeHtml(artwork.titleZh)}</em>
          </a>`
          )
          .join("")}
      </div>
      <p class="quiet-note">选完参照后，再选拍人、拍景，或人与环境。</p>
      <div class="shoot-film-refs">
        <p class="workflow-step-label">
          也可以用电影画面作参考 · ${filmRefs.length} 张（${filmRefs[0] ? filmRefs[0].year : ""}–${
            filmRefs.length ? filmRefs[filmRefs.length - 1].year : ""
          }）；每张的导演、许可与来源都在它的详情页里
        </p>
        <div class="create-picks film-picks">
          ${filmRefs
            .map(
              (still) => `
          <a class="film-ref-card" href="#shoot/${escapeHtml(still.id)}">
            <span style="${aspectRatioCss({ image: still.image })}">${renderImg(
                { ...still, titleZh: still.film?.titleZh || still.title },
                { sizes: PICK_SIZES }
              )}</span>
            <em>${escapeHtml(still.film?.titleZh || still.title)} · ${escapeHtml(String(still.film?.year ?? ""))}</em>
            <small>导演 ${escapeHtml(still.film?.directorZh || "")}</small>
          </a>`
            )
            .join("")}
        </div>
      </div>

      <div class="workflow-section" id="shoot-step-subject">
        <p class="workflow-step-label">STEP 1 · 拍摄对象</p>
        <div class="subject-picker">
          ${Object.entries(SUBJECT_TYPE_LABEL)
            .map(
              ([key, label]) => `
              <button class="subject-card ${shootFlow.subject === key ? "is-on" : ""}" type="button" data-subject="${key}">
                <span>${label}</span>
                <small>${SUBJECT_TYPE_DESC[key]}</small>
              </button>`
            )
            .join("")}
        </div>
      </div>

      <div class="workflow-section" id="shoot-step-mood" ${shootFlow.subject ? "" : "hidden"}>
        <p class="workflow-step-label">STEP 2 · 想要什么感觉</p>
        <div class="mood-chips" id="shoot-mood-chips"></div>
      </div>

      <div class="workflow-section" id="shoot-step-works" ${shootFlow.subject && shootFlow.mood ? "" : "hidden"}>
        <p class="workflow-step-label">STEP 3 · 参考作品</p>
        <a class="workspace-back" href="#shoot" id="shoot-restart">重新开始</a>
        <div class="workflow-grid" id="shoot-works-grid"></div>
      </div>
    </section>
  `;

  // 电影画面墙是本页第一次出现的图片：接入与 CREATE / FIND 同一套降级绑定，
  // 加载失败时按 .img-slot 契约收掉这张卡，而不是留一个破图。
  bindImgFallback(app);

  const stepSubject = app.querySelector("#shoot-step-subject");
  const stepMood = app.querySelector("#shoot-step-mood");
  const stepWorks = app.querySelector("#shoot-step-works");
  const moodChips = app.querySelector("#shoot-mood-chips");
  const worksGrid = app.querySelector("#shoot-works-grid");

  // Local photo: instant preview, then "use this photo to FIND references" —
  // same vision → VisualIntent → retrieval pipeline as FIND.
  const shootFile = app.querySelector("#shoot-file");
  const shootPreview = app.querySelector("#shoot-local-preview");
  const shootFindBtn = app.querySelector("#shoot-image-find");
  const shootNote = app.querySelector("#shoot-image-note");
  let shootPending = null;
  shootFile?.addEventListener("change", () => {
    const file = shootFile.files[0];
    if (!file) return;
    shootPending = file;
    if (shootPreview.src?.startsWith("blob:")) URL.revokeObjectURL(shootPreview.src);
    shootPreview.src = URL.createObjectURL(file);
    shootPreview.hidden = false;
    shootNote.hidden = true;
    shootNote.innerHTML = "";
    shootFindBtn.hidden = false;
  });
  shootFindBtn?.addEventListener("click", () => {
    if (!shootPending) return;
    shootFindBtn.hidden = true;
    shootNote.textContent = "正在理解画面…";
    shootNote.classList.remove("is-error");
    shootNote.hidden = false;
    retrieveByImage(shootPending, { limit: 6 })
      .then((outcome) => {
        if (!outcome.ok) {
          shootNote.textContent =
            outcome.error === "unsupported-format"
              ? "不支持的图片格式。请换成 JPG / PNG / WEBP。"
              : outcome.error === "too-large"
                ? "图片太大了（超过 12MB）。"
                : "画面理解暂时不可用（本地演示未接入识图模型）。";
          shootNote.classList.add("is-error");
          shootNote.hidden = false;
          return;
        }
        shootNote.classList.remove("is-error");
        const liveLabel = provenanceLabel(INTENT_PROVENANCE.LIVE);
        shootNote.textContent = outcome.summary
          ? `看到的画面：${outcome.summary}（${liveLabel}）`
          : `仅识别出少量结构信息（${liveLabel}）。`;
        shootNote.hidden = false;
        if (outcome.results.length) {
          // Hand the FIND page a one-line reading (it re-runs the pipeline
          // from the stored file if the user asks to browse results there).
          sessionStorage.setItem("fa-vision-summary", outcome.summary || "");
          window.location.hash = "#find";
        }
      })
      .catch(() => {
        shootNote.textContent = "画面理解暂时不可用（本地演示未接入识图模型）。";
        shootNote.classList.add("is-error");
        shootNote.hidden = false;
      });
  });

  const baseWorks = () =>
    artworks.filter((a) => !a.imageUnavailable && a.shootTranslation?.subjectType === shootFlow.subject);

  function renderMoodChips() {
    const emotions = [...new Set(baseWorks().flatMap((a) => a.emotion || []))];
    moodChips.innerHTML = `
      <button type="button" data-mood="" class="${shootFlow.mood === null ? "is-on" : ""}">任意</button>
      ${emotions
        .slice(0, 12)
        .map(
          (e) =>
            `<button type="button" data-mood="${escapeHtml(e)}" class="${shootFlow.mood === e ? "is-on" : ""}">${escapeHtml(e)}</button>`
        )
        .join("")}
    `;
  }

  function renderWorks() {
    const list = baseWorks().filter(
      (a) => !shootFlow.mood || (a.emotion || []).includes(shootFlow.mood)
    );
    worksGrid.innerHTML = list
      .map((artwork, index) =>
        artworkTile(artwork, index).replace(
          `href="#artwork/${artwork.key}"`,
          `href="#shoot/${artwork.key}"`
        )
      )
      .join("");
  }

  stepSubject.querySelectorAll("[data-subject]").forEach((button) => {
    button.addEventListener("click", () => {
      shootFlow.subject = button.dataset.subject;
      shootFlow.mood = null;
      stepSubject.querySelectorAll("[data-subject]").forEach((b) => b.classList.toggle("is-on", b === button));
      stepMood.hidden = false;
      stepWorks.hidden = true;
      renderMoodChips();
      track("shootSubject", shootFlow.subject);
    });
  });

  moodChips.addEventListener("click", (e) => {
    const button = e.target.closest("[data-mood]");
    if (!button) return;
    shootFlow.mood = button.dataset.mood || null;
    moodChips.querySelectorAll("[data-mood]").forEach((b) => b.classList.toggle("is-on", b === button));
    stepWorks.hidden = false;
    renderWorks();
    track("shootMood", shootFlow.mood || "any");
  });

  app.querySelector("#shoot-restart").addEventListener("click", () => {
    shootFlow = { subject: null, mood: null };
    renderShootIndex(app);
  });

  if (shootFlow.subject) {
    stepMood.hidden = false;
    renderMoodChips();
  }
}

function guideRows(definitions) {
  return definitions
    .filter(([, value]) => value)
    .map(
      ([label, value], index) => `
        <div>
          <span>${String(index + 1).padStart(2, "0")}</span>
          <strong>${escapeHtml(label)}</strong>
          <p>${escapeHtml(value)}</p>
        </div>
      `
    )
    .join("");
}

function personGuideBlock(guide) {
  return `
    <section class="analysis-section">
      <h2 class="section-title">拍人 <small>普通人可直接执行</small></h2>
      <div class="camera-guide">
        ${guideRows([
          ["人站哪里", guide.stance],
          ["人物占画面比例", guide.frameRatio],
          ["摄影师 / 手机站哪里", guide.photographer],
          ["人物看哪里", guide.gaze],
          ["身体朝向", guide.bodyDirection],
          ["头顶留多少空间", guide.headRoom],
          ["视线方向留多少空间", guide.eyeRoom],
          ["背景线条避让", guide.backgroundLines],
          ["横拍还是竖拍", guide.framing],
          ["手机镜头", guide.phoneLens],
          ["推荐距离", guide.distance],
          ["推荐时间", guide.time],
          ["光线方向", guide.light],
        ])}
      </div>
    </section>
  `;
}

function placeGuideBlock(guide) {
  return `
    <section class="analysis-section">
      <h2 class="section-title">拍景 <small>普通人可直接执行</small></h2>
      <div class="camera-guide">
        ${guideRows([
          ["地平线放在哪里", guide.horizon],
          ["主体放在哪里", guide.mainSubject],
          ["前景锚点", guide.foregroundAnchor],
          ["视觉引导线", guide.leadingLines],
          ["消失点", guide.vanishingPoint],
          ["景深层级", guide.depthLayers],
          ["推荐机位高度", guide.cameraHeight],
          ["横拍还是竖拍", guide.framing],
          ["手机镜头", guide.phoneLens],
          ["推荐时间", guide.time],
          ["推荐天气", guide.weather],
          ["光线方向", guide.light],
        ])}
      </div>
    </section>
  `;
}

function proNotesBlock(proNotes) {
  if (!proNotes) return "";
  const rows = Array.isArray(proNotes) ? proNotes : [proNotes];
  return `
    <details class="pro-notes">
      <summary>专业术语展开（可选读）</summary>
      <ul>
        ${rows.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}
      </ul>
    </details>
  `;
}

// R1.0-R4 (RC-5): live-task shooting decisions. Returns "" whenever the
// translation has nothing reliable to say — the curated static guides then
// render exactly as before.
function shootDecisionsBlock(result) {
  const groups = result.decisions || {};
  if (!Object.keys(groups).length) return "";
  const provenance = result.provenance || [];
  const skipped = result.skipped || [];
  const conflicts = result.conflicts || [];
  const relationRow = (p) => {
    if (p.kind === "documented") {
      return `<li data-relation-kind="documented">明确引用：电影《${escapeHtml(p.film)}》${escapeHtml(p.evidence ? `（证据 ${escapeHtml(String(p.evidence))}）` : "")}</li>`;
    }
    if (p.kind === "visual-parallel") {
      return `<li data-relation-kind="visual-parallel">视觉平行：电影《${escapeHtml(p.film)}》· ${escapeHtml(p.note)}</li>`;
    }
    return `<li data-relation-kind="thematic">解释性关联：电影《${escapeHtml(p.film)}》· ${escapeHtml(p.note)}</li>`;
  };
  return `
    <section class="analysis-section" data-shoot-decisions="1">
      <p class="kicker">当前任务 · 摄影决策</p>
      <h2 class="section-title">
        依据你的视觉意图生成
        <small>${result.directReference ? "当前作品就是你选中的参考" : "当前作品是你选择的拍摄参照"}</small>
      </h2>
      <div class="analysis-grid">
      ${Object.entries(groups)
        .map(
          ([group, lines]) => `
        <div class="field-block" data-decision-group="${escapeHtml(group)}">
          <span>${escapeHtml(GROUP_LABELS[group] || group)}</span>
          <ul>
            ${lines
              .map(
                (line) => `<li data-decision-source="${escapeHtml(line.source)}">${escapeHtml(line.text)}</li>`
              )
              .join("")}
          </ul>
        </div>`
        )
        .join("")}
      </div>
      ${
        conflicts.length
          ? `<div class="analysis-section" data-shoot-conflicts>
              <h3 class="section-title">冲突处理</h3>
              <ul>${conflicts.map((c) => `<li>${escapeHtml(c.note || "")}</li>`).join("")}</ul>
            </div>`
          : ""
      }
      ${
        provenance.length
          ? `<div class="analysis-section" data-shoot-relations>
              <h3 class="section-title">已确认的视觉关系</h3>
              <ul>${provenance.map(relationRow).join("")}</ul>
            </div>`
          : ""
      }
      ${
        skipped.length
          ? `<details class="pro-notes" data-shoot-skipped>
              <summary>未采用的字段（${skipped.length}）</summary>
              <ul>${skipped
                .map(
                  (s) =>
                    `<li>${escapeHtml(`${s.field || s.kind}${s.value ? `=${s.value}` : ""}`)} — ${escapeHtml(String(s.reason))}</li>`
                )
                .join("")}</ul>
            </details>`
          : ""
      }
      <p class="quiet-note">以上决策只依据你当前的视觉意图、明确的 KEEP / REMOVE 与已确认的视觉关系；策展静态指南保留在下方作为补充，不覆盖你的显式约束。</p>
    </section>
  `;
}

// R1.0-R4: mark the curated guides as supplementary while a live task drives
// the page. With no task the headings stay byte-identical to before.
function staticGuideNote(hasTask) {
  return hasTask ? `<p class="quiet-note" data-static-guide-note>以下为该作品的策展静态指南，作为补充参考。</p>` : "";
}

function locationBlock(artwork, filmRefs) {
  const sections = [];
  if (artwork.location) {
    const loc = artwork.location;
    sections.push(`
      <div class="location-card">
        <span class="location-source">画作地点${loc.verified ? "" : " · 未确认"}</span>
        <strong>${escapeHtml(locationLabel(loc))}</strong>
        <p>${escapeHtml(loc.locationType || "")}${loc.coordinates ? ` · ${loc.coordinates.lat}, ${loc.coordinates.lng}` : ""}</p>
        <p class="quiet-note">${escapeHtml(loc.source || "")}</p>
      </div>
    `);
  }
  for (const reference of filmRefs) {
    if (!reference.location) continue;
    const loc = reference.location;
    sections.push(`
      <div class="location-card">
        <span class="location-source">电影《${escapeHtml(reference.filmTitleZh)}》拍摄地${loc.verified ? "" : " · 未确认"}</span>
        <strong>${escapeHtml(locationLabel(loc))}</strong>
        <p>${escapeHtml(loc.locationType || "")}${loc.coordinates ? ` · ${loc.coordinates.lat}, ${loc.coordinates.lng}` : ""}</p>
        <p class="quiet-note">${escapeHtml(loc.source || "")}</p>
      </div>
    `);
  }
  const patterns = [
    ...(artwork.locationPattern || []),
    ...filmRefs.flatMap((reference) => reference.locationPattern || []),
  ];
  const uniquePatterns = [...new Set(patterns)];

  if (!sections.length && !uniquePatterns.length) {
    return `
      <section class="analysis-section">
        <h2 class="section-title">真实地点</h2>
        <p class="quiet-note">未确认具体拍摄点。我们不会猜测地点——可以参考下方构图与光线建议，在你自己的城市寻找类似画面。</p>
      </section>
    `;
  }
  return `
    <section class="analysis-section">
      <h2 class="section-title">真实地点 <small>静态数据，未接地图</small></h2>
      ${sections.join("")}
      ${
        uniquePatterns.length
          ? `
        <div class="location-pattern">
          <strong>去不了原地点？你也可以寻找：</strong>
          <ul>
            ${uniquePatterns.map((pattern) => `<li>${escapeHtml(pattern)}</li>`).join("")}
          </ul>
        </div>
      `
          : ""
      }
    </section>
  `;
}

export function renderShoot(app, id) {
  // id may be a local key ("local:wanderer"), a plain local id ("wanderer"),
  // or a remote key ("aic:1234") — resolve in that order.
  const bare = String(id || "").replace(/^local:/, "");
  // R5 STEP 3 — a film still is a legitimate SHOOT reference. It is resolved
  // through the same artwork-shaped view the retrieval layer uses, so SHOOT
  // needs no second code path; only the LABELS differ (导演, not 画家).
  // P4.12 — 黑白电影影像不得通过直连 id 进入 SHOOT。
  // 这里原来直接查 filmStills（未过滤的原始数据），因此 #shoot/film-the-general
  // 仍能打开一张黑白片。改为查过滤后的电影池：被排除的影片解析不到，
  // 落到下面的「暂无可用的 SHOOT 指导」分支。
  const filmStill = filmStillPool().find((f) => f.id === bare || f.id === id) || null;
  const artwork = filmStill
    ? filmStillAsArtwork(filmStill)
    : findArtwork(bare) || findByKey(bare) || findByKey(id);
  if (!artwork || !artwork.shootTranslation) {
    app.innerHTML = `<div class="empty">该参考暂无可用的 SHOOT 指导（仅限有策展分析的本地作品与已核验的电影画面）。</div>`;
    return;
  }
  const isFilm = Boolean(filmStill);
  track("shootUsage", artwork.id);
  setRouteActive("shoot");

  const shoot = artwork.shootTranslation;
  const filmRefs = referencesForArtwork(artwork.id);
  const context = buildProjectContext(artwork);
  const hasOverlay = Boolean(shoot.overlay);
  // R1.0-R4 (RC-5): the live task drives deterministic shooting decisions.
  // getSnapshot() is read-only — the R1 lifecycle and the R2 principle
  // contract are not modified here. With no fresh task (direct entry, expired
  // task, or a new FIND reset) the translation returns nothing and the
  // curated static guides render exactly as before.
  const task = getSnapshot();
  const directReference = Boolean(
    task.fresh &&
      (task.referenceKeys.includes(artwork.key) || task.referenceKeys.includes(artwork.id))
  );
  const shootDecision = translateShoot({
    intent: task.fresh ? task.intent : null,
    principles: task.fresh ? task.principles : [],
    artwork,
    relations: relationsFor(artwork),
    taskFresh: Boolean(task.fresh),
    directReference,
  });
  const hasLiveDecisions = Object.keys(shootDecision.decisions).length > 0;

  app.innerHTML = `
    <article class="mode-page shoot-detail">
      <aside class="mode-art">
        ${artworkFigure(artwork, { overlay: true })}
        <a href="${isFilm ? `#film/${artwork.id}` : `#artwork/${artwork.id}`}">${escapeHtml(artwork.titleZh)} / ${escapeHtml(
          isFilm ? `导演 ${artwork.film.directorZh || artwork.film.director}` : artwork.artist
        )} · 查看档案记录</a>
      </aside>
      <section class="mode-content">
        <p class="kicker">SHOOT / 现实拍摄参考</p>
        <div class="shoot-head">
          <h1>${escapeHtml(artwork.titleZh)}</h1>
          <span class="subject-badge">${escapeHtml(SUBJECT_TYPE_LABEL[shoot.subjectType] || shoot.subjectType)}</span>
        </div>

        <div class="overlay-controls">
          ${
            hasOverlay
              ? `<button class="primary-action" type="button" data-overlay-toggle="#composition-overlay" aria-pressed="false">构图分析</button>
                 <span class="quiet-note">默认干净展示作品，点击后才叠加构图线。</span>`
              : `<span class="quiet-note">该作品暂未标注构图线。</span>`
          }
        </div>

        ${shootDecisionsBlock(shootDecision)}
        ${staticGuideNote(hasLiveDecisions)}
        ${shoot.personGuide ? personGuideBlock(shoot.personGuide) : ""}
        ${shoot.placeGuide ? placeGuideBlock(shoot.placeGuide) : ""}
        ${proNotesBlock(shoot.proNotes)}
        ${locationBlock(artwork, filmRefs)}

        <section class="context-export">
          <h2 class="section-title">Project Context</h2>
          <div class="context-actions">
            <button class="primary-action" type="button" data-context-export="markdown">复制项目上下文 (Markdown)</button>
            <button class="ghost-action" type="button" data-context-export="json">复制 JSON</button>
            <button class="ghost-action" type="button" data-save-artwork="${escapeHtml(artwork.id)}">收藏到 YOUR EYE</button>
          </div>
        </section>
      </section>
    </article>
  `;

  attachOverlayToggle(app);
  attachCopyHandlers(app);
  attachSaveHandlers(app);
  attachContextExport(app, (format) =>
    format === "json" ? JSON.stringify(context, null, 2) : projectContextToMarkdown(context)
  );
}
