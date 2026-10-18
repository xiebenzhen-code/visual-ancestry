// YOUR EYE — visual preference summary, not a personality profile.
// Shows what the user has actually been looking at, explains why those
// formal elements produce the feelings they do, and points to further
// artists / traditions / films. No MBTI-style labels, ever.

import { setRouteActive } from "../app/events.js";
import { escapeHtml } from "../utils/html.js";
import { getProfile, getAestheticReading, getRecommendations } from "../utils/profile.js";
import { traditionLabel } from "../utils/search.js";

function rankedList(entries, { tradition = false, empty = "还没有足够记录。" } = {}) {
  if (!entries.length) return `<p class="quiet-note">${escapeHtml(empty)}</p>`;
  return `
    <ol class="eye-list">
      ${entries
        .map(
          ([term, count]) => `
            <li>
              <strong>${escapeHtml(tradition ? traditionLabel(term) : term)}</strong>
              <span>${count}×</span>
            </li>
          `
        )
        .join("")}
    </ol>
  `;
}

export function renderEye(app) {
  setRouteActive("eye");
  const profile = getProfile();
  const readings = getAestheticReading(profile);
  const recommendations = getRecommendations(profile);

  const emptyState = profile.viewedCount === 0;

  app.innerHTML = `
    <section class="index-page eye-page">
      <header class="taxonomy-head">
        <p class="kicker">YOUR EYE</p>
        <h1>你的眼睛，最近在看什么</h1>
        <p>只总结视觉偏好，不判断性格。数据保存在你自己的浏览器里，不上传。</p>
      </header>

      ${
        emptyState
          ? `
        <div class="empty">
          还没有浏览记录。去 <a href="#discover">DISCOVER</a> 看几幅画，再回到这里。
        </div>
      `
          : `
        <div class="eye-grid">
          <section class="eye-card">
            <h2>你最近偏好的情绪</h2>
            ${rankedList(profile.topEmotions)}
          </section>
          <section class="eye-card">
            <h2>你最近偏好的氛围</h2>
            ${rankedList(profile.topAtmospheres)}
          </section>
          <section class="eye-card">
            <h2>你常看的视觉传统</h2>
            ${rankedList(profile.topTraditions, { tradition: true })}
          </section>
          <section class="eye-card">
            <h2>你常选择的构图</h2>
            ${rankedList(profile.topComposition)}
          </section>
          <section class="eye-card">
            <h2>你常选择的光线</h2>
            ${rankedList(profile.topLighting)}
          </section>
          <section class="eye-card">
            <h2>你反复看的视觉 DNA</h2>
            ${rankedList(profile.topVisualDNA)}
          </section>
        </div>

        <section class="analysis-section eye-reading">
          <h2 class="section-title">这些画面为什么对你起作用</h2>
          ${
            readings.length
              ? `
            <p class="quiet-note">你最近选择的画面经常具有：</p>
            <ul class="reading-elements">
              ${readings.map((reading) => `<li>${escapeHtml(reading.element)}</li>`).join("")}
            </ul>
            <p class="reading-effect">
              这类画面通常会产生：${escapeHtml([...new Set(readings.map((reading) => reading.effect))].join("；"))}。
            </p>
          `
              : `<p class="quiet-note">再看几幅作品，这里会开始解释你的视觉选择为什么会产生对应的感觉。</p>`
          }
        </section>

        <section class="analysis-section eye-recommend">
          <h2 class="section-title">你可以继续看</h2>
          ${
            recommendations.length
              ? `
            <div class="recommend-tags">
              ${recommendations.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
            </div>
            <p class="quiet-note">推荐指向艺术家、视觉传统和电影，不指向“你是哪种人”。</p>
          `
              : `<p class="quiet-note">浏览更多作品后，这里会推荐与你近期视觉选择相邻的艺术家和电影。</p>`
          }
        </section>

        <p class="quiet-note eye-stats">
          已记录 ${profile.eventCount} 次行为 · 看过 ${profile.viewedCount} 件作品 · CREATE ${profile.creatorUsage} 次 · SHOOT ${profile.shootUsage} 次
          ${profile.savedIds.length ? ` · 收藏 ${profile.savedIds.length} 件` : ""}
        </p>
      `
      }
    </section>
  `;
}
