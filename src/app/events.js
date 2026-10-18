import { state } from "./state.js";
import { renderArchiveGrid } from "../components/archiveGrid.js";
import { copyText } from "../utils/projectContext.js";
import { track } from "../utils/profile.js";
import { findByKey, findLocalById, allKnownWorks } from "../services/artService.js";
import { intentFromArtwork } from "../services/retrieval/artworkIntent.js";
import { createVisualMemory } from "../services/memory/types.js";
import { addMemory, deleteMemory, getMemory } from "../services/memory/memoryRepository.js";

export function attachSearchHandlers() {
  window.__visualAncestryState = state;
  const form = document.querySelector("#search-form");
  if (form) {
    form.addEventListener("submit", (event) => event.preventDefault());
    form.addEventListener("input", (event) => {
      state.query = event.currentTarget.query.value;
      state.activeCategory = null;
      state.activeTerm = null;
      renderArchiveGrid();
    });
  }
  document.querySelectorAll("[data-category][data-term]").forEach((button) => {
    button.addEventListener("click", () => {
      state.query = "";
      state.activeCategory = button.dataset.category;
      state.activeTerm = button.dataset.term;
      if (state.activeCategory === "emotion") track("selectedEmotion", state.activeTerm);
      if (state.activeCategory === "atmosphere") track("selectedAtmosphere", state.activeTerm);
      if (state.activeCategory === "tradition") track("selectedTradition", state.activeTerm);
      if (["emotion", "atmosphere", "tradition"].includes(state.activeCategory)) renderArchiveGrid();
    });
  });
}

export function setRouteActive(route) {
  document.querySelectorAll(".main-nav a").forEach((link) => {
    link.classList.toggle("is-active", link.dataset.route === route);
  });
}

function flashButton(button, text) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = text;
  button.classList.add("is-confirmed");
  window.setTimeout(() => {
    button.textContent = original;
    button.classList.remove("is-confirmed");
  }, 1600);
}

// Copy buttons: <button data-copy="text to copy"> or
// <button data-copy-target="#element-id"> (copies that element's textContent).
export function attachCopyHandlers(root = document) {
  root.querySelectorAll("[data-copy], [data-copy-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      let text = button.dataset.copy || "";
      if (button.dataset.copyTarget) {
        const target = document.querySelector(button.dataset.copyTarget);
        text = target ? target.textContent.trim() : "";
      }
      if (!text) return;
      const ok = await copyText(text);
      flashButton(button, ok ? "已复制" : "复制失败");
    });
  });
}

// Composition overlay toggle: <button data-overlay-toggle="#overlay-id">.
// Default state is hidden — artwork stays clean until 构图分析 is requested.
export function attachOverlayToggle(root = document) {
  root.querySelectorAll("[data-overlay-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = document.querySelector(button.dataset.overlayToggle);
      if (!target) return;
      const willShow = target.hidden;
      target.hidden = !willShow;
      button.classList.toggle("is-on", willShow);
      button.textContent = willShow ? "隐藏构图线" : "构图分析";
      button.setAttribute("aria-pressed", String(willShow));
    });
  });
}

// Save-to-profile buttons: <button data-save-artwork="artwork-id">.
// Real personal-memory collection: addMemory on first click, deleteMemory on
// second (idempotent toggle). A valid VisualIntent is derived from the
// artwork's own analysis (intentFromArtwork) so the entry satisfies the
// VisualMemory schema — nothing is fabricated. The behavior log (track) is
// kept as a secondary, append-only signal. UI reflects the saved state.
const SAVE_LABEL = "收藏到我的视觉档案";
const SAVE_LABEL_ON = "已收藏（点击取消）";

function artworkForSave(saveId) {
  // saveId is artwork.id || artwork.key. Try both lookup paths.
  return findLocalById(saveId) || findByKey(saveId) || allKnownWorks().find((a) => (a.id || a.key) === saveId) || null;
}

function memoryIdForArtwork(artwork) {
  return `artwork:${artwork.id || artwork.key}`;
}

function artworkToMemory(artwork) {
  const intent = intentFromArtwork(artwork);
  const id = memoryIdForArtwork(artwork);
  const now = new Date().toISOString();
  return createVisualMemory({
    id,
    source: "artwork-reference",
    visualIntent: intent,
    metadata: {
      title: artwork.titleZh || artwork.title || "",
      origin: `${artwork.artist || ""} · ${artwork.year || ""}`,
      year: artwork.year ? String(artwork.year) : null,
      tags: [...(artwork.emotion || []), ...(artwork.atmosphere || [])].filter(Boolean),
      createdAt: now,
      artworkKey: artwork.key || artwork.id || "",
    },
    userData: { note: "来自作品详情页收藏", collections: [] },
  });
}

export function attachSaveHandlers(root = document) {
  root.querySelectorAll("[data-save-artwork]").forEach((button) => {
    const artwork = artworkForSave(button.dataset.saveArtwork);
    if (!artwork) {
      // Unknown id — keep the legacy behavior-log-only fallback, don't crash.
      button.addEventListener("click", () => {
        track("savedArtwork", button.dataset.saveArtwork);
        flashButton(button, "已记录");
      });
      return;
    }
    const memId = memoryIdForArtwork(artwork);
    const refreshState = async () => {
      try {
        const existing = await getMemory(memId);
        const saved = Boolean(existing);
        button.classList.toggle("is-saved", saved);
        button.textContent = saved ? SAVE_LABEL_ON : SAVE_LABEL;
        button.setAttribute("aria-pressed", String(saved));
      } catch {
        button.textContent = SAVE_LABEL;
      }
    };
    button.addEventListener("click", async () => {
      const existing = await getMemory(memId).catch(() => null);
      if (existing) {
        const res = await deleteMemory(memId).catch(() => ({ ok: false, error: "unknown" }));
        if (res && res.ok === false) {
          flashButton(button, "取消失败：存储不可用");
          return;
        }
        track("unsavedArtwork", button.dataset.saveArtwork);
        flashButton(button, "已取消收藏");
      } else {
        const memory = artworkToMemory(artwork);
        const res = await addMemory(memory).catch(() => ({ ok: false, error: "unknown" }));
        if (res && res.ok === false) {
          flashButton(button, "收藏失败：存储不可用");
          return;
        }
        track("savedArtwork", button.dataset.saveArtwork);
        flashButton(button, "已收藏");
      }
      await refreshState();
    });
    refreshState();
  });
}

// Generic context-export buttons wired by pages through a provider callback.
export function attachContextExport(root, provider) {
  root.querySelectorAll("[data-context-export]").forEach((button) => {
    button.addEventListener("click", async () => {
      const format = button.dataset.contextExport; // "markdown" | "json"
      const text = provider(format);
      if (!text) return;
      const ok = await copyText(text);
      flashButton(button, ok ? "已复制项目上下文" : "复制失败");
    });
  });
}
