// searchLayer.js — the ONLY search surface. Used by the global topbar layer
// and the homepage search box. Never a separate page.
//
// Feedback contract:
//   - visible change within 100-200ms of typing ("Searching local…")
//   - local matches render instantly under the input
//   - 400ms debounce merges museum results ("Searching museums…")
//   - status shows counts: "12 local · 38 museum results"
//   - no match: "No exact match" + "Try: …" chips (alias-based suggestions,
//     shown IMMEDIATELY when local hits are zero, while museums still load)
//   - remote failure: "馆藏搜索暂时不可用，本地结果仍可浏览"
// Results are ARTWORK CARDS (tap -> detail), never a taxonomy dictionary.
import { searchLocal, searchRemote, getCachedRemote, wasRemoteUnavailable } from "../services/artService.js";
import { suggestForQueryWithFallback } from "../services/suggestionService.js";
import { renderImg, bindImgFallback } from "../utils/image.js";
import { escapeHtml } from "../utils/html.js";

const DEBOUNCE_MS = 400;
const LOCAL_FEEDBACK_MS = 120;

export function initSearchLayer() {
  const layer = document.querySelector("#search-layer");
  const trigger = document.querySelector("#top-search-trigger");
  if (!layer || !trigger) return;

  const input = layer.querySelector("#global-search");
  const statusEl = layer.querySelector("#search-layer-status");
  const chipsEl = layer.querySelector("#search-layer-chips");
  const resultsEl = layer.querySelector("#search-layer-results");

  let timer = null;
  let localTimer = null;
  let seq = 0;
  let open = false;

  function openLayer() {
    open = true;
    layer.hidden = false;
    document.body.classList.add("search-open");
    window.setTimeout(() => input.focus(), 30);
    if (input.value.trim()) run(input.value.trim());
  }
  function closeLayer() {
    open = false;
    layer.hidden = true;
    document.body.classList.remove("search-open");
  }

  trigger.addEventListener("click", openLayer);
  layer.querySelectorAll("[data-search-close]").forEach((el) => el.addEventListener("click", closeLayer));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) closeLayer();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      open ? closeLayer() : openLayer();
    }
  });

  input.addEventListener("input", () => {
    const q = input.value.trim();
    window.clearTimeout(localTimer);
    if (!q) {
      statusEl.textContent = "";
      resultsEl.innerHTML = "";
      chipsEl.innerHTML = "";
      return;
    }
    statusEl.textContent = "Searching local…";
    localTimer = window.setTimeout(() => renderLocal(q), LOCAL_FEEDBACK_MS);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => run(q), DEBOUNCE_MS);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault();
  });

  function renderLocal(q) {
    const seqNow = ++seq;
    const local = searchLocal(q);
    if (seqNow !== seq) return;
    const cached = getCachedRemote(q);
    if (cached) {
      statusEl.textContent = `${local.length} local · ${cached.length} museum results (cache)`;
      renderResults([...local, ...cached]);
    } else {
      statusEl.textContent = local.length
        ? `${local.length} local · Searching museums…`
        : "Searching museums…";
      renderResults(local);
      if (!local.length) renderSuggestions(q);
    }
  }

  function renderSuggestions(q) {
    const tips = suggestForQueryWithFallback(q);
    chipsEl.innerHTML = tips.length
      ? `<span class="sug-label">Try:</span>` +
        tips
          .slice(0, 4)
          .map((t) => `<button type="button" data-sug="${escapeHtml(t)}">${escapeHtml(t)}</button>`)
          .join("")
      : "";
  }

  async function run(q) {
    const seqNow = ++seq;
    const local = searchLocal(q);
    const cached = getCachedRemote(q);
    if (cached) {
      if (seqNow !== seq) return;
      statusEl.textContent = `${local.length} local · ${cached.length} museum results`;
      renderResults([...local, ...cached]);
      return;
    }
    if (seqNow !== seq) return;
    statusEl.textContent = local.length
      ? `${local.length} local · Searching museums…`
      : "Searching museums…";
    renderResults(local);
    if (!local.length) renderSuggestions(q);

    let remote = [];
    try {
      remote = await searchRemote(q, { limit: 36 });
    } catch {
      remote = [];
    }
    if (seqNow !== seq) return;
    if (remote.length) {
      const seen = new Set(local.map((w) => w.key));
      const fresh = remote.filter((w) => !seen.has(w.key));
      statusEl.textContent = `${local.length} local · ${remote.length} museum results`;
      renderResults([...local, ...fresh]);
    } else if (!local.length) {
      statusEl.textContent = wasRemoteUnavailable()
        ? "馆藏搜索暂时不可用，本地结果仍可浏览"
        : "No exact match";
      renderSuggestions(q);
    } else {
      statusEl.textContent = wasRemoteUnavailable()
        ? `${local.length} local · 馆藏搜索暂时不可用`
        : `${local.length} local · 0 museum results`;
    }
  }

  function renderResults(works) {
    resultsEl.innerHTML = works
      .slice(0, 40)
      .map(
        (w, i) => `
        <a class="sresult" href="#artwork/${escapeHtml(w.key)}">
          <span class="sresult-img">${renderImg(w, { priority: i < 4 })}</span>
          <span class="sresult-meta">
            <b>${escapeHtml(w.artist)}</b>
            <span>${escapeHtml(w.titleZh || w.title)} · ${escapeHtml(w.year)}</span>
            <em>${escapeHtml(w.museum || "")}</em>
          </span>
        </a>`
      )
      .join("");
    bindImgFallback(resultsEl);
  }

  chipsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sug]");
    if (!btn) return;
    input.value = btn.dataset.sug;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  window.__searchLayer = { open: openLayer, close: closeLayer };
}

// Bind an inline homepage search box (hero) to the same feedback engine.
export function bindHeroSearch(box) {
  const input = box.querySelector("input");
  const statusEl = box.querySelector(".hero-search-status");
  const chipsEl = box.querySelector(".hero-search-chips");
  const resultsEl = box.querySelector(".hero-search-results");
  if (!input) return;

  let timer = null;
  let localTimer = null;
  let seq = 0;

  function renderSuggestions(q) {
    const tips = suggestForQueryWithFallback(q);
    chipsEl.innerHTML = tips.length
      ? `<span class="sug-label">Try:</span>` +
        tips
          .slice(0, 4)
          .map((t) => `<button type="button" data-sug="${escapeHtml(t)}">${escapeHtml(t)}</button>`)
          .join("")
      : "";
  }

  function renderResults(works) {
    resultsEl.innerHTML = works
      .slice(0, 16)
      .map(
        (w) => `
        <a class="sresult" href="#artwork/${escapeHtml(w.key)}">
          <span class="sresult-img">${renderImg(w)}</span>
          <span class="sresult-meta">
            <b>${escapeHtml(w.artist)}</b>
            <span>${escapeHtml(w.titleZh || w.title)} · ${escapeHtml(w.year)}</span>
          </span>
        </a>`
      )
      .join("");
    bindImgFallback(resultsEl);
  }

  input.addEventListener("input", () => {
    const q = input.value.trim();
    window.clearTimeout(localTimer);
    if (!q) {
      statusEl.textContent = "";
      resultsEl.innerHTML = "";
      chipsEl.innerHTML = "";
      return;
    }
    statusEl.textContent = "Searching local…";
    localTimer = window.setTimeout(() => {
      const s = ++seq;
      const local = searchLocal(q);
      if (s !== seq) return;
      statusEl.textContent = local.length
        ? `${local.length} local · Searching museums…`
        : "Searching museums…";
      renderResults(local);
      if (!local.length) renderSuggestions(q);
    }, LOCAL_FEEDBACK_MS);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => run(q), DEBOUNCE_MS);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = resultsEl.querySelector("a.sresult");
      if (first) window.location.hash = first.getAttribute("href").replace("#", "");
    }
  });

  async function run(q) {
    const s = ++seq;
    const local = searchLocal(q);
    const cached = getCachedRemote(q);
    if (cached) {
      if (s !== seq) return;
      statusEl.textContent = `${local.length} local · ${cached.length} museum results`;
      renderResults([...local, ...cached]);
      return;
    }
    if (s !== seq) return;
    let remote = [];
    try {
      remote = await searchRemote(q, { limit: 36 });
    } catch {
      remote = [];
    }
    if (s !== seq) return;
    if (remote.length) {
      const seen = new Set(local.map((w) => w.key));
      const fresh = remote.filter((w) => !seen.has(w.key));
      statusEl.textContent = `${local.length} local · ${remote.length} museum results`;
      renderResults([...local, ...fresh]);
    } else if (!local.length) {
      statusEl.textContent = wasRemoteUnavailable()
        ? "馆藏搜索暂时不可用，本地结果仍可浏览"
        : "No exact match";
      renderSuggestions(q);
    } else {
      statusEl.textContent = wasRemoteUnavailable()
        ? `${local.length} local · 馆藏搜索暂时不可用`
        : `${local.length} local · 0 museum results`;
    }
  }

  chipsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sug]");
    if (!btn) return;
    input.value = btn.dataset.sug;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}