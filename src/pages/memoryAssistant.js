// memoryAssistant — Personal Visual Assistant (P5.6 STEP 6). Route #memory/assistant.
//
// NOT a chat window: three task cards, no conversation thread, no free-form
// AI generation. Each card is one assistant task over the personal archive:
//   [ 我想了解我的视觉偏好 ]  → understand_taste
//   [ 我想找参考 ]            → find_reference
//   [ 我正在创作 ]            → creative_support
// Every answer carries its evidence (counts / matchedFields / reasons /
// sampleSize). The assistant never grades taste, never assigns a personality,
// never recommends "what you should like", never invents references.
import { setRouteActive } from "../app/events.js";
import { escapeHtml } from "../utils/html.js";
import { runAssistant } from "../services/memory/visualAssistant.js";
import { retrievalCard } from "../components/memory/retrievalCard.js";

function resultCards(r) {
  if (!r.results || !r.results.length) {
    return `<p class="assistant-empty">${escapeHtml(r.note || r.message || "没有可呈现的结果。")}</p>`;
  }
  return `<div class="assistant-results">${r.results
    .map((hit) =>
      retrievalCard({
        id: hit.id,
        score: hit.score,
        matchedFields: hit.matchedFields,
        reasons: hit.reason,
        memory: { metadata: { title: hit.title, origin: hit.medium === "film" ? "film-still" : "artwork-reference" }, userData: { thumbnail: hit.image } },
      })
    )
    .join("")}</div>`;
}

function tasteView(r) {
  if (!r.ok) {
    return `<p class="assistant-empty">${escapeHtml(r.summary)}</p>`;
  }
  return `
    <p class="assistant-summary">${escapeHtml(r.summary)}</p>
    <ul class="assistant-evidence">
      ${r.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}
    </ul>
    <p class="assistant-note">样本：${escapeHtml(r.confidence.basis)} · 置信级 ${escapeHtml(r.confidence.level)} · 只统计你自己保存的资产。</p>
    ${
      Object.keys(r.unavailable || {}).length
        ? `<details class="assistant-unavailable"><summary>暂时无法呈现</summary><ul>${Object.entries(r.unavailable)
            .map(([f, why]) => `<li><strong>${escapeHtml(f)}</strong> — ${escapeHtml(why)}</li>`)
            .join("")}</ul></details>`
        : ""
    }`;
}

function findView(r) {
  if (!r.ok) return `<p class="assistant-empty">${escapeHtml(r.message)}</p>`;
  const vq = Object.entries(r.visualQuery || {})
    .map(([k, v]) => `<span class="memory-chip">${escapeHtml(k)}: ${escapeHtml(Array.isArray(v) ? v.join("/") : String(v))}</span>`)
    .join("");
  return `
    <div class="assistant-query">${vq}</div>
    ${r.enrichedQuery ? `<p class="assistant-note">已按你的高频倾向补全检索：${escapeHtml(JSON.stringify(r.enrichedQuery))}</p>` : ""}
    ${resultCards(r)}`;
}

function creativeView(r) {
  if (!r.ok) return `<p class="assistant-empty">${escapeHtml(r.message)}</p>`;
  const dir = (label, list) =>
    list && list.length ? `<div class="assistant-dir-row"><span class="assistant-dir-label">${label}</span><span>${list.map(escapeHtml).join(" · ")}</span></div>` : "";
  return `
    <p class="assistant-note">场景语言：${escapeHtml(JSON.stringify(r.sceneQuery || {}))} · 基于样本 ${escapeHtml(String(r.basedOn.sampleSize))}（${escapeHtml(r.basedOn.confidence.level)}）</p>
    <div class="assistant-direction">
      ${dir("空间", r.direction.space)}
      ${dir("构图", r.direction.composition)}
      ${dir("色彩", r.direction.color)}
      ${dir("叙事", r.direction.narrative)}
    </div>
    <p class="assistant-note">以下是你自己的历史参考（为什么匹配见每条证据）：</p>
    ${resultCards(r)}
    <p class="assistant-note">${escapeHtml(r.note || "")}</p>`;
}

const TASKS = [
  { key: "find_reference", title: "我想找参考", hint: "例如：找一些孤独荒原感觉的参考", needsInput: true, view: findView },
  { key: "understand_taste", title: "我想了解我的视觉偏好", hint: "", needsInput: false, view: tasteView },
  { key: "creative_support", title: "我正在创作", hint: "例如：我要设计一个夜晚工业城市", needsInput: true, view: creativeView },
];

export async function renderMemoryAssistant(app) {
  setRouteActive("memory");
  app.innerHTML = `
    <section class="index-page memory-page assistant-page">
      <header class="memory-head">
        <p class="kicker">MEMORY / ASSISTANT</p>
        <h1>Visual Assistant</h1>
        <p class="quiet-note">它读的是你自己的视觉档案：理解你的倾向、在你的收藏里找参考、把个人记忆整理成创作提示。没有聊天，没有 AI 替你创作，没有审美评分。</p>
        <a class="memory-back" href="#memory">← 返回档案</a>
      </header>

      <div class="assistant-tasks">
        ${TASKS.map(
          (t) => `
          <section class="assistant-card" data-task="${t.key}">
            <h2 class="assistant-card-title">${escapeHtml(t.title)}</h2>
            <div class="assistant-card-input">
              ${
                t.needsInput
                  ? `<input class="assistant-input" type="text" placeholder="${escapeHtml(t.hint)}" data-assistant-input="${t.key}" />
                     <button class="memory-retry assistant-run" type="button" data-assistant-run="${t.key}">执行</button>`
                  : `<button class="memory-retry assistant-run" type="button" data-assistant-run="${t.key}">读取我的档案</button>`
              }
            </div>
            <div class="assistant-output" data-assistant-output="${t.key}">
              <p class="assistant-empty">等待执行——结果只来自你的个人记忆。</p>
            </div>
          </section>`
        ).join("")}
      </div>
    </section>
  `;

  const outputOf = (key) => app.querySelector(`[data-assistant-output="${key}"]`);
  const inputOf = (key) => app.querySelector(`[data-assistant-input="${key}"]`);
  const taskOf = (key) => TASKS.find((t) => t.key === key);

  app.querySelectorAll("[data-assistant-run]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.getAttribute("data-assistant-run");
      const task = taskOf(key);
      const query = task.needsInput ? (inputOf(key).value || "").trim() : "";
      const out = outputOf(key);
      out.innerHTML = `<p class="assistant-empty">读取个人记忆中…</p>`;
      try {
        const r = await runAssistant({ task: key, query });
        out.innerHTML = task.view(r);
      } catch (err) {
        out.innerHTML = `<p class="assistant-empty">执行失败：${escapeHtml(String((err && err.message) || err))}</p>`;
      }
    });
  });
  app.querySelectorAll("[data-assistant-input]").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const key = input.getAttribute("data-assistant-input");
        app.querySelector(`[data-assistant-run="${key}"]`).click();
      }
    });
  });
}
