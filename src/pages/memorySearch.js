// memorySearch — 按感觉找回 (P5.2.2 STEP 2). Route #memory/search.
//
// The ONLY retrieval UI entry into the personal pool. It builds a VisualQuery
// from structured choices (schema tokens under Chinese labels), calls the
// P5.2.1 thin layer, and renders retrievalCard evidence.
//
// Boundary: this page does NOT re-implement scoring / filtering / ranking —
// retrieveVisualMemory() (P5.2.1) stays the single retrieval path. The
// choice→token map below is input vocabulary only (UI layer), never scoring.
import { setRouteActive } from "../app/events.js";
import { escapeHtml } from "../utils/html.js";
import { retrieveVisualMemory } from "../services/memory/retrieveVisualMemory.js";
import { retrievalCard } from "../components/memory/retrievalCard.js";

// ---- structured choice vocabulary (UI → VisualIntent schema tokens) -------
// atmosphere/emotion lists are Chinese schema tokens; scalars are enum tokens.
// First version is deliberately structured — no natural language (P5.2.1 rule).
const CHOICES = {
  atmosphere: {
    label: "氛围",
    multiple: true,
    options: [
      ["寂静", "寂静"], ["空旷", "空旷"], ["夜晚", "夜晚"],
      ["雾", "雾"], ["热闹", "热闹"], ["阴郁", "阴郁"],
    ],
  },
  spatialDepth: {
    label: "空间",
    multiple: false,
    options: [["纵深很深", "deep"], ["空间偏平面", "shallow"]],
  },
  colorTemperature: {
    label: "色彩",
    multiple: false,
    options: [["冷色调", "cool"], ["暖色调", "warm"], ["中性色", "neutral"]],
  },
  saturation: {
    label: "饱和度",
    multiple: false,
    options: [["低饱和", "low"], ["中饱和", "medium"], ["高饱和", "high"]],
  },
  humanRelation: {
    label: "人物",
    multiple: false,
    options: [["孤立", "isolated"], ["相伴", "together"], ["人群", "crowd"]],
  },
};

function buildQuery(selections) {
  const query = {};
  for (const [field, cfg] of Object.entries(CHOICES)) {
    const chosen = selections[field];
    if (!chosen) continue;
    if (cfg.multiple) {
      if (Array.isArray(chosen) && chosen.length) query[field] = [...chosen];
    } else if (chosen) {
      query[field] = chosen;
    }
  }
  return query;
}

export async function renderMemorySearch(app) {
  setRouteActive("memory");

  app.innerHTML = `
    <section class="index-page memory-page">
      <header class="memory-head">
        <p class="kicker">MEMORY / FIND</p>
        <h1>按感觉找回</h1>
        <p>描述你想要的那张画面的视觉感觉——不用文件名，不用标签。档案里所有素材都用同一种视觉语言记录，所以它们能被同一种语言找回来。</p>
        <a class="memory-back" href="#memory">← 返回档案</a>
      </header>

      <div class="search-builder" id="search-builder">
        <p class="search-builder-title">选择你记得的感觉</p>
        ${Object.entries(CHOICES)
          .map(
            ([field, cfg]) => `
              <div class="search-group" data-search-group="${field}">
                <span class="search-group-label">${cfg.label}</span>
                <div class="search-options">
                  ${cfg.options
                    .map(
                      ([label, token]) => `
                        <button class="search-option" type="button" data-field="${field}" data-token="${escapeHtml(token)}" aria-pressed="false">${label}</button>
                      `
                    )
                    .join("")}
                </div>
              </div>
            `
          )
          .join("")}
        <div class="search-actions">
          <button class="memory-submit" id="search-run" type="button" disabled>找回</button>
          <button class="search-clear" id="search-clear" type="button" disabled>清除条件</button>
        </div>
      </div>

      <div class="search-outcome" id="search-outcome" hidden></div>
      <div class="search-results" id="search-results"></div>
    </section>
  `;

  const selections = {};
  const runBtn = app.querySelector("#search-run");
  const clearBtn = app.querySelector("#search-clear");
  const outcomeEl = app.querySelector("#search-outcome");
  const resultsEl = app.querySelector("#search-results");

  function syncButtons() {
    const hasAny = Object.values(selections).some((v) => (Array.isArray(v) ? v.length > 0 : !!v));
    runBtn.disabled = !hasAny;
    clearBtn.disabled = !hasAny;
    app.querySelectorAll("[data-search-group]").forEach((group) => {
      const field = group.dataset.searchGroup;
      const chosen = selections[field];
      group.querySelectorAll("[data-token]").forEach((btn) => {
        const token = btn.dataset.token;
        const active = Array.isArray(chosen) ? chosen.includes(token) : chosen === token;
        btn.classList.toggle("is-selected", active);
        btn.setAttribute("aria-pressed", String(active));
      });
    });
  }

  app.querySelectorAll(".search-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const field = btn.dataset.field;
      const token = btn.dataset.token;
      const cfg = CHOICES[field];
      if (cfg.multiple) {
        const list = Array.isArray(selections[field]) ? [...selections[field]] : [];
        const idx = list.indexOf(token);
        if (idx >= 0) list.splice(idx, 1);
        else list.push(token);
        selections[field] = list;
      } else {
        selections[field] = selections[field] === token ? "" : token;
      }
      syncButtons();
    });
  });

  clearBtn.addEventListener("click", () => {
    for (const field of Object.keys(CHOICES)) {
      selections[field] = CHOICES[field].multiple ? [] : "";
    }
    outcomeEl.hidden = true;
    resultsEl.innerHTML = "";
    syncButtons();
  });

  async function run() {
    const query = buildQuery(selections);
    if (!Object.keys(query).length) return;
    runBtn.textContent = "寻找中…";
    runBtn.disabled = true;
    try {
      const results = await retrieveVisualMemory(query, { limit: 8 });
      outcomeEl.hidden = false;
      outcomeEl.innerHTML = results.length
        ? `<p class="search-outcome-note">找到 ${results.length} 条接近的感觉</p>`
        : `<p class="search-outcome-none">没有找到接近的感觉。档案里的素材还没覆盖这种感觉——再收集一些，或换个条件试试。</p>`;
      resultsEl.innerHTML = results.map((r) => retrievalCard(r)).join("");
      // honest edge: zero results is a valid outcome, never a fabricated recommendation
      if (!results.length) resultsEl.innerHTML = "";
    } finally {
      runBtn.textContent = "找回";
      syncButtons();
    }
  }

  runBtn.addEventListener("click", run);
}