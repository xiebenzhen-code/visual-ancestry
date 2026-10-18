// MEMORY — Personal Visual Archive prototype (P5.1.5 → P5.1.8).
//   #memory          — 档案索引：成功卡片 + 失败卡片（可重新分析）
//   #memory/upload   — 上传：批量选图 → 服务端识别 → 实时进度 → 失败可重试
//   #memory/:id      — 详情：完整的中文视觉意图解读
//
// Product rules kept here:
//   - ONLY the memory layer is used: listMemories/getMemory/deleteMemory +
//     uploadMemory. No retrieval, no scoring, no recommendation section.
//   - visualIntent display labels are all Chinese; metadata (title/origin/
//     note/…) is shown as editorial context and never appears in any
//     retrieval path.
//   - Failures are honest AND recoverable (P5.1.8): a failed upload persists
//     as a `failed` VisualMemory with a user-facing error and a 「重新分析」
//     button. Nothing is invented when the bridge fails.

import { setRouteActive } from "../app/events.js";
import { escapeHtml } from "../utils/html.js";
import { listMemories, getMemory, deleteMemory, clearPersonalMemory } from "../services/memory/memoryRepository.js";
import { exportPersonalArchive, importPersonalArchive } from "../services/memory/archivePortability.js";
import { uploadMemory } from "../services/memory/uploadService.js";
import { createReadableId } from "../services/memory/types.js";
import { memoryCard } from "../components/memory/memoryCard.js";
import { sourceLabel, formatDate } from "../components/memory/memoryLabels.js";

// ---- Chinese display vocabulary (visual intent only) ----------------------

// Scalar fields → [中文字段名, 取值 → 中文]
const INTENT_FIELDS = [
  ["subject", "主体", { "single-figure": "单人", figure: "人物", portrait: "肖像", group: "群体", place: "场景", none: "无" }],
  ["subjectScale", "主体尺度", { small: "小", medium: "中", large: "大" }],
  ["subjectPosition", "主体位置", { low: "下方", center: "居中", high: "上方", edge: "边缘" }],
  ["spatialDepth", "空间纵深", { deep: "深远", shallow: "浅近" }],
  ["negativeSpace", "负空间", { high: "大量留白", low: "紧凑" }],
  ["environmentDominance", "环境主导", { high: "环境主导", low: "主体主导" }],
  ["lightDirection", "光线方向", { side: "侧光", back: "逆光", front: "顺光", top: "顶光" }],
  ["lightQuality", "光线质感", { diffuse: "柔光", directional: "硬光", rim: "轮廓光" }],
  ["colorTemperature", "色温", { cool: "冷色", warm: "暖色", neutral: "中性" }],
  ["saturation", "饱和度", { low: "低饱和", medium: "中饱和", high: "高饱和" }],
  ["contrast", "对比度", { low: "低对比", medium: "中对比", high: "高对比" }],
  ["humanRelation", "人物关系", { isolated: "孤立", together: "相伴", crowd: "人群" }],
  ["cameraDistance", "机位距离", { far: "远景", medium: "中景", near: "近景" }],
  ["cameraHeight", "机位高度", { low: "低机位", eye: "平视", high: "高机位" }],
  ["cameraRelation", "机位关系", { observational: "旁观", immersive: "沉浸", confrontational: "对峙" }],
  ["motion", "动态", { still: "静止", moving: "运动" }],
  ["visualDensity", "视觉密度", { sparse: "疏朗", dense: "密集" }],
  ["arousal", "唤醒度", { low: "平静", medium: "中等", high: "强烈" }],
  ["socialDistance", "社交距离", { low: "亲近", medium: "适中", high: "疏远" }],
  ["melancholy", "忧郁感", { low: "淡", medium: "中", high: "浓" }],
];

const LIST_FIELDS = [
  ["emotion", "情绪"],
  ["atmosphere", "氛围"],
];

function tokenLabel(field, value) {
  const entry = INTENT_FIELDS.find(([key]) => key === field);
  return entry && entry[2][value] ? entry[2][value] : String(value ?? "");
}

function scalarChips(intent) {
  const chips = [];
  for (const [field, label, tokens] of INTENT_FIELDS) {
    const value = intent[field];
    if (value && tokens[value]) chips.push(`${label} · ${tokens[value]}`);
  }
  return chips;
}

function intentDisplay(intent) {
  // 先列出“氛围 / 情绪”两组感知列表，再列出单项视觉特征。
  const listChips = [];
  for (const [field, label] of LIST_FIELDS) {
    if (Array.isArray(intent[field]) && intent[field].length) {
      for (const item of intent[field]) listChips.push(`${label} · ${item}`);
    }
  }
  return { listChips, scalarChips: scalarChips(intent) };
}

// ---- shared bits ------------------------------------------------------------
function memoryCountLine(memories) {
  const failed = memories.filter((m) => m.status === "failed").length;
  const ok = memories.length - failed;
  const failedNote = failed
    ? `<span class="memory-count-failed"> · ${failed} 条分析失败，可重新分析</span>`
    : "";
  return `<p class="quiet-note">已保存 ${ok} 段视觉记忆${failedNote} · 数据只存在你自己的浏览器（localStorage），不上传。</p>`;
}

function reRenderIndex() {
  window.location.hash = "#memory";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function flash(button, text) {
  const original = button.textContent;
  button.textContent = text;
  button.disabled = true;
  window.setTimeout(() => {
    if (button.isConnected) {
      button.textContent = original;
      button.disabled = false;
    }
  }, 1600);
}

function attachDeleteHandlers(root) {
  root.querySelectorAll("[data-memory-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.memoryDelete;
      if (!id) return;
      if (!window.confirm(`删除「${id}」这条视觉记忆？`)) return;
      await deleteMemory(id);
      flash(button, "已删除");
      reRenderIndex();
    });
  });
}

// ---- retry（P5.1.8）---------------------------------------------------------
// 档案页失败卡片：无原文件，用已保存的预览图降级重试（诚实标注低于原图质量）。
async function dataUrlToFile(dataUrl, filename, mime) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], filename || "retry.jpg", { type: mime || blob.type || "image/jpeg" });
}

async function retryMemoryById(id) {
  const memory = await getMemory(id);
  if (!memory) return { ok: false, error: { code: "NOT_FOUND", message: "记录不存在。" } };
  const thumb = memory.userData && memory.userData.thumbnail;
  if (!thumb) {
    return { ok: false, error: { code: "NO_FILE", message: "这条失败记录没有保留预览图，请重新选择上传。" } };
  }
  const file = await dataUrlToFile(thumb, memory.image.path || "retry.jpg", memory.image.mime || "image/jpeg");
  return uploadMemory(file, {
    id,
    title: memory.metadata.title || "",
    origin: memory.metadata.origin || "",
    tags: Array.isArray(memory.metadata.tags) ? memory.metadata.tags : [],
    note: memory.userData.note || "",
    thumbnail: thumb,
  });
}

function attachRetryHandlers(root) {
  root.querySelectorAll("[data-retry-memory]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.retryMemory;
      if (!id) return;
      flash(button, "重新分析中…");
      const result = await retryMemoryById(id);
      if (result.ok && result.memory) {
        window.location.hash = `#memory/${result.memory.id}`;
      } else {
        reRenderIndex(); // 刷新显示最新错误/状态
      }
    });
  });
}

// ---- #memory  index ---------------------------------------------------------
export async function renderMemoryIndex(app) {
  setRouteActive("memory");
  const memories = await listMemories();
  const sorted = [...memories].reverse(); // 最新在前

  app.innerHTML = `
    <section class="index-page memory-page">
      <header class="memory-head">
        <p class="kicker">MEMORY</p>
        <h1>你的视觉档案</h1>
        <p>把你在意的画面存下来——每一张图都会被转译成同一种视觉语言，之后可以按视觉特征找回。</p>
        <div class="memory-head-actions">
          <a class="memory-cta" href="#memory/upload">＋ 保存一段新素材</a>
          <a class="memory-search-cta" href="#memory/search">按感觉寻找 →</a>
          <a class="memory-profile-cta" href="#memory/profile">我的视觉档案 →</a>
          <a class="memory-assistant-cta" href="#memory/assistant">Visual Assistant →</a>
        </div>
        ${memoryCountLine(sorted)}
        <div class="memory-archive-bar">
          <button class="memory-archive-btn" type="button" data-archive-export>导出档案</button>
          <label class="memory-archive-btn">导入档案<input type="file" accept="application/json,.json" data-archive-import hidden /></label>
          <button class="memory-archive-btn memory-archive-danger" type="button" data-archive-clear>清空档案</button>
          <span class="memory-archive-msg" data-archive-msg hidden></span>
        </div>
        <p class="quiet-note">导出含缩略图与全部视觉语言数据（不含原图）· 导入合并同名覆盖 · 清空只影响个人档案，不影响其他数据。</p>
      </header>

      ${
        sorted.length
          ? `<div class="memory-grid">${sorted.map((m) => memoryCard(m)).join("")}</div>`
          : `<div class="empty">
              还没有保存任何视觉素材。
              去 <a href="#memory/upload">上传一张图</a>——电影剧照、绘画参考、随手拍都可以。
            </div>`
      }
    </section>
  `;
  attachDeleteHandlers(app);
  attachRetryHandlers(app);
  attachArchiveHandlers(app, renderMemoryIndex);
}

// ---- P5.8.1 · archive lifecycle UI（最小实现：导出/导入/清空）-----------------
function archiveMsg(app, text, danger = false) {
  const el = app.querySelector("[data-archive-msg]");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("memory-archive-msg-danger", danger);
}

function attachArchiveHandlers(app, rerender) {
  const exportBtn = app.querySelector("[data-archive-export]");
  const importInput = app.querySelector("[data-archive-import]");
  const clearBtn = app.querySelector("[data-archive-clear]");

  exportBtn &&
    exportBtn.addEventListener("click", async () => {
      try {
        const archive = await exportPersonalArchive();
        const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `visual-archive-${archive.exportedAt.slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        archiveMsg(app, `已导出 ${archive.memoryCount} 条视觉记忆（JSON）。`);
      } catch (err) {
        archiveMsg(app, `导出失败：${String((err && err.message) || err)}`, true);
      }
    });

  importInput &&
    importInput.addEventListener("change", async () => {
      const file = importInput.files && importInput.files[0];
      if (!file) return;
      try {
        const archive = JSON.parse(await file.text());
        const r = await importPersonalArchive(archive, { mode: "merge" });
        if (!r.ok) archiveMsg(app, `导入被拒绝：${r.reason}`, true);
        else {
          archiveMsg(app, `已恢复 ${r.restored} 条${r.skipped.length ? `，跳过 ${r.skipped.length} 条无效条目` : ""}。`);
          setTimeout(rerender, 600, app);
        }
      } catch (err) {
        archiveMsg(app, `导入失败：${String((err && err.message) || err)}`, true);
      } finally {
        importInput.value = "";
      }
    });

  clearBtn &&
    clearBtn.addEventListener("click", async () => {
      if (!window.confirm("确定清空整个个人视觉档案？此操作不可撤销（建议先导出备份）。")) return;
      if (!window.confirm("再次确认：全部视觉记忆将被删除。")) return;
      await clearPersonalMemory();
      archiveMsg(app, "个人档案已清空。");
      setTimeout(rerender, 600, app);
    });
}

// ---- #memory/upload ----------------------------------------------------------
function uploadFormMarkup() {
  return `
    <form class="memory-form" id="memory-upload-form">
      <label class="memory-dropzone" id="memory-dropzone">
        <input type="file" id="memory-file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden />
        <span class="memory-dropzone-hint" id="memory-dropzone-hint">
          点击选择，或拖入图片（可多选）<br /><small>JPG / PNG / WEBP / GIF · 单张 ≤ 6MB</small>
        </span>
        <span class="memory-dropzone-count" id="memory-dropzone-count" hidden></span>
      </label>
      <p class="memory-form-error" id="memory-form-error" hidden></p>

      <div class="memory-form-row">
        <label>名称（可留空，用文件名） <input id="memory-title" type="text" placeholder="例如：雾中的车站" autocomplete="off" /></label>
        <label>来源
          <select id="memory-origin">
            <option value="film-still">电影剧照</option>
            <option value="artwork-reference" selected>绘画参考</option>
            <option value="photo">照片</option>
            <option value="ai-generated">AI 生成</option>
            <option value="user-upload">其他</option>
          </select>
        </label>
      </div>
      <div class="memory-form-row">
        <label>标签（逗号分隔）<input id="memory-tags" type="text" placeholder="夜晚, 车站, 孤独" autocomplete="off" /></label>
        <label>备注 <input id="memory-note" type="text" placeholder="为什么想留着它" autocomplete="off" /></label>
      </div>

      <div class="batch-status" id="batch-status" hidden></div>
      <ul class="batch-list" id="batch-list"></ul>

      <button class="memory-submit" id="memory-submit" type="submit" disabled>分析并保存</button>
      <p class="quiet-note">失败的图片会保留记录并显示原因，可点击「重新分析」恢复——不需要重新选图。</p>
    </form>
  `;
}

let queueSeq = 0;
function nextQueueId() {
  queueSeq += 1;
  return createReadableId((Date.now() % 96000) + queueSeq);
}

export async function renderMemoryUpload(app) {
  setRouteActive("memory");
  app.innerHTML = `
    <section class="index-page memory-page">
      <header class="memory-head">
        <p class="kicker">MEMORY / UPLOAD</p>
        <h1>保存视觉记忆</h1>
        <p>一次可拖入多张图，AI 逐张读成视觉语言；上传过程实时可见，失败可单独重试。</p>
        <a class="memory-back" href="#memory">← 返回档案</a>
      </header>
      ${uploadFormMarkup()}
    </section>
  `;

  const form = app.querySelector("#memory-upload-form");
  const fileInput = app.querySelector("#memory-file");
  const dropzone = app.querySelector("#memory-dropzone");
  const dropzoneHint = app.querySelector("#memory-dropzone-hint");
  const dropzoneCount = app.querySelector("#memory-dropzone-count");
  const submitBtn = app.querySelector("#memory-submit");
  const errorBox = app.querySelector("#memory-form-error");
  const statusEl = app.querySelector("#batch-status");
  const listEl = app.querySelector("#batch-list");

  /** @type {{id:string, file:File, thumb:string, status:string, error?:object|null, memoryId?:string, latencyMs?:number|null}[]} */
  const queue = [];
  let busy = false;

  const updateDropzone = () => {
    dropzoneCount.hidden = queue.length === 0;
    dropzoneCount.textContent = `已选 ${queue.length} 张`;
    submitBtn.disabled = queue.length === 0 || busy;
  };

  async function addFiles(fileList) {
    const files = Array.from(fileList || []).slice(0, 50); // 安全上限，避免一次数百张
    for (const file of files) {
      const item = { id: nextQueueId(), file, thumb: "", status: "pending", error: null, memoryId: "", latencyMs: null };
      queue.push(item);
      try {
        item.thumb = await makeThumbnail(file);
      } catch {
        item.thumb = "";
      }
    }
    errorBox.hidden = true;
    updateDropzone();
    renderQueue();
  }

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (e) => e.preventDefault());
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    addFiles(e.dataTransfer.files).catch(() => {});
  });
  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files).catch(() => {});
    fileInput.value = "";
  });

  function collectMeta() {
    const origin = form.querySelector("#memory-origin").value;
    const tags = form
      .querySelector("#memory-tags")
      .value.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    return {
      title: form.querySelector("#memory-title").value.trim(),
      origin,
      tags,
      note: form.querySelector("#memory-note").value.trim(),
    };
  }

  function renderQueue() {
    const done = queue.filter((q) => q.status !== "pending").length;
    const success = queue.filter((q) => q.status === "success").length;
    const failed = queue.filter((q) => q.status === "failed").length;
    const processing = queue.filter((q) => q.status === "processing").length;

    const allDone = queue.length > 0 && done === queue.length;
    statusEl.hidden = queue.length === 0;
    statusEl.textContent = queue.length === 0
      ? ""
      : allDone
        ? `已处理 ${done}/${queue.length} · 成功 ${success} · 失败 ${failed}——${success ? "这些画面已转译成你的视觉语言，可回档案" : "可回档案"}按感觉寻找，或在「我的视觉档案」里看你的倾向统计。`
        : `已处理 ${done}/${queue.length} · 成功 ${success} · 失败 ${failed} · 处理中 ${processing}`;

    listEl.innerHTML = queue
      .map((item) => {
        const name = escapeHtml(item.file.name);
        const mark =
          item.status === "success"
            ? `<span class="batch-item-ok">✓ 已保存 <a href="#memory/${escapeHtml(item.memoryId)}">${escapeHtml(item.memoryId)}</a></span>`
            : item.status === "failed"
              ? `<span class="batch-item-fail">✗ ${escapeHtml((item.error && item.error.message) || "分析失败")}${item.error && item.error.code ? `（${escapeHtml(item.error.code)}）` : ""}</span>`
              : item.status === "processing"
                ? `<span class="batch-item-working">… 正在分析</span>`
                : `<span class="batch-item-pending">排队中</span>`;
        const retryBtn =
          item.status === "failed"
            ? `<button class="memory-retry" type="button" data-batch-retry="${escapeHtml(item.id)}">重新分析</button>`
            : "";
        return `<li class="batch-item" data-batch-id="${escapeHtml(item.id)}"><span class="batch-item-name">${name}</span> ${mark} ${retryBtn}</li>`;
      })
      .join("");

    listEl.querySelectorAll("[data-batch-retry]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (busy) return;
        const item = queue.find((q) => q.id === btn.dataset.batchRetry);
        if (!item) return;
        await runOne(item);
      });
    });
    updateDropzone();
  }

  async function runOne(item) {
    item.status = "processing";
    item.error = null;
    renderQueue();
    const meta = collectMeta();
    const result = await uploadMemory(item.file, {
      id: item.id,
      title: meta.title || item.file.name.replace(/\.[^.]+$/, ""),
      origin: meta.origin,
      tags: meta.tags,
      note: meta.note,
      thumbnail: item.thumb,
    });
    item.latencyMs = result.latencyMs ?? null;
    if (result.ok && result.memory) {
      item.status = "success";
      item.memoryId = result.memory.id;
    } else {
      item.status = "failed";
      item.error = result.error || { code: "UNKNOWN", message: "发生未知错误，请重新尝试。" };
    }
    renderQueue();
    return result;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy || queue.length === 0) return;
    const pending = queue.filter((q) => q.status === "pending" || q.status === "failed");
    if (pending.length === 0) return;
    busy = true;
    submitBtn.textContent = "正在逐张分析…";
    errorBox.hidden = true;

    for (const item of pending) {
      await runOne(item);
    }

    busy = false;
    submitBtn.textContent = "分析并保存";
    updateDropzone();

    // 单张成功 → 跳详情；多张 → 停留在结果列表
    if (queue.length === 1 && queue[0].status === "success") {
      window.location.hash = `#memory/${queue[0].memoryId}`;
    }
  });
}

// ---- #memory/:id  detail -----------------------------------------------------
function intentDetailHtml(intent) {
  const { listChips, scalarChips } = intentDisplay(intent);
  const chipsHtml =
    listChips.length || scalarChips.length
      ? `<div class="memory-chips">${[...listChips, ...scalarChips]
          .map((chip) => `<span class="memory-chip">${escapeHtml(chip)}</span>`)
          .join("")}</div>`
      : `<p class="quiet-note">这份记录没有可展示的视觉意图字段。</p>`;
  return chipsHtml;
}

export async function renderMemoryDetail(app, id) {
  setRouteActive("memory");
  const memory = await getMemory(id);

  if (!memory) {
    app.innerHTML = `
      <section class="index-page memory-page">
        <header class="memory-head">
          <p class="kicker">MEMORY</p>
          <h1>没有找到这条记录</h1>
          <p>它可能已被删除。</p>
          <a class="memory-back" href="#memory">← 返回档案</a>
        </header>
      </section>
    `;
    return;
  }

  // 失败的记录也有详情页：说明原因 + 提供重新分析
  if (memory.status === "failed") {
    const err = memory.error || {};
    app.innerHTML = `
      <section class="index-page memory-page">
        <header class="memory-head">
          <p class="kicker">MEMORY / ${escapeHtml(memory.id)}</p>
          <h1>${escapeHtml(memory.metadata.title || "未命名素材")}</h1>
          <p>这条素材的视觉分析失败了，没有生成视觉语言。</p>
          <a class="memory-back" href="#memory">← 返回档案</a>
        </header>
        <div class="memory-detail">
          <div class="memory-detail-body">
            <p class="memory-form-error">${escapeHtml(err.message || "发生未知错误，请重新尝试。")}（${escapeHtml(err.code || "UNKNOWN")}）</p>
            <button class="memory-retry" type="button" data-retry-memory="${escapeHtml(memory.id)}">重新分析</button>
            <button class="memory-delete" type="button" data-memory-delete="${escapeHtml(memory.id)}">删除这条记录</button>
          </div>
        </div>
      </section>
    `;
    attachDeleteHandlers(app);
    attachRetryHandlers(app);
    return;
  }

  const intent = memory.visualIntent || {};
  const meta = memory.metadata || {};
  const userData = memory.userData || {};
  const thumb = userData.thumbnail || "";

  app.innerHTML = `
    <section class="index-page memory-page">
      <header class="memory-head">
        <p class="kicker">MEMORY / ${escapeHtml(memory.id)}</p>
        <h1>${escapeHtml(meta.title || "未命名素材")}</h1>
        <p>来源：${escapeHtml(sourceLabel(memory.source))}${meta.film ? ` · 影片：${escapeHtml(meta.film)}` : ""}${
          meta.year ? ` · ${escapeHtml(String(meta.year))}` : ""
        } · 保存于 ${escapeHtml(formatDate(meta.createdAt) || "—")}</p>
        <a class="memory-back" href="#memory">← 返回档案</a>
      </header>

      <div class="memory-detail">
        <div class="memory-detail-media">
          ${
            thumb
              ? `<img class="memory-detail-img" src="${thumb}" alt="${escapeHtml(meta.title || "视觉素材")}" />`
              : `<div class="memory-detail-placeholder">图</div>`
          }
        </div>

        <div class="memory-detail-body">
          <h2 class="section-title">这段画面的视觉语言</h2>
          ${intentDetailHtml(intent)}

          ${
            userData.note
              ? `<section class="analysis-section"><h2 class="section-title">你的备注</h2><p>${escapeHtml(userData.note)}</p></section>`
              : ""
          }
          ${
            meta.tags && meta.tags.length
              ? `<section class="analysis-section"><h2 class="section-title">标签</h2><p>${meta.tags.map((t) => escapeHtml(t)).join(" · ")}</p></section>`
              : ""
          }

          <button class="memory-delete" type="button" data-memory-delete="${escapeHtml(memory.id)}">删除这条记录</button>
        </div>
      </div>
    </section>
  `;
  attachDeleteHandlers(app);
  attachRetryHandlers(app);
}

// ---- thumbnail (product layer: keeps localStorage small) ---------------------
async function makeThumbnail(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image decode failed"));
      el.src = url;
    });
    const max = 420;
    const ratio = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * ratio));
    canvas.height = Math.max(1, Math.round(img.height * ratio));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.72);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export { makeThumbnail };