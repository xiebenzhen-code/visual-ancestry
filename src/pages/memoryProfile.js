// memoryProfile — 我的视觉档案 (P5.3.1 STEP 4). Route #memory/profile.
//
// A Visual Identity Page, NOT a dashboard: no radar charts, no rankings, no
// AI scores. It renders what the aggregator counted, phrased by the
// presenter, always limited by the confidence level (19 assets → 初步观察).
//
// Boundary: reads ONLY buildVisualProfile() (aggregator) + presenter helpers.
// No scoring imports, no retrieval, no #eye browsing data.
import { setRouteActive } from "../app/events.js";
import { escapeHtml } from "../utils/html.js";
import { buildVisualProfile } from "../services/memory/visualProfile.js";
import {
  confidenceHeadline,
  profileSections,
  atmosphereBlock,
  unavailableBlock,
} from "../components/memory/visualProfilePresenter.js";

export async function renderMemoryProfile(app) {
  setRouteActive("memory");
  const profile = await buildVisualProfile();
  const head = confidenceHeadline(profile.confidence);
  const sections = profileSections(profile);
  const atmosphere = atmosphereBlock(profile);
  const unavailable = unavailableBlock(profile);

  const sectionsHtml = sections
    .map(
      (group) => `
      <section class="profile-section">
        <h2 class="section-title">${escapeHtml(group.title)}</h2>
        ${group.lines
          .map(
            (line) => `
          <div class="profile-line">
            <p class="profile-sentence">${escapeHtml(line.text)}</p>
            ${line.fraction ? `<span class="profile-fraction">${escapeHtml(line.fraction)}</span>` : ""}
          </div>`
          )
          .join("")}
      </section>`
    )
    .join("");

  const atmosphereHtml = atmosphere
    ? `
      <section class="profile-section">
        <h2 class="section-title">氛围词</h2>
        <div class="profile-atmosphere">
          ${atmosphere.tokens
            .map((t) => `<span class="memory-chip">${escapeHtml(t.token)} · ${t.count}</span>`)
            .join("")}
        </div>
        <p class="quiet-note">${escapeHtml(atmosphere.note)}</p>
      </section>`
    : "";

  const unavailableHtml = unavailable.length
    ? `
      <section class="profile-section profile-unavailable">
        <h2 class="section-title">暂时无法呈现</h2>
        <ul>
          ${unavailable
            .map((u) => `<li><strong>${escapeHtml(u.field)}</strong> — ${escapeHtml(u.reason)}</li>`)
            .join("")}
        </ul>
      </section>`
    : "";

  app.innerHTML = `
    <section class="index-page memory-page profile-page">
      <header class="memory-head">
        <p class="kicker">MEMORY / PROFILE</p>
        <h1>我的视觉档案</h1>
        <p class="profile-headline">${escapeHtml(head.text)}</p>
        <p class="quiet-note">样本：${escapeHtml(head.basis)} · 只统计你自己保存的视觉资产，与浏览记录无关。</p>
        <a class="memory-back" href="#memory">← 返回档案</a>
      </header>

      <div class="profile-body">
        ${sectionsHtml}
        ${atmosphereHtml}
        ${unavailableHtml}
      </div>
    </section>
  `;
}
