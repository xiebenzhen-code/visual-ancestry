// artwork.js — 作品是工具节点，不是终点。
//
// 本地作品与自动发现的远端作品共用这一页（不建第二套详情系统）。
// 区别只有三处：图片来源、有没有独立画像、探索候选从哪来。
//
// 探索区的纪律：
//   · 本地候选走 buildBranches（档案 + 像素），分支语义本来就是"保留画派，换一个维度"。
//   · 远端候选来自向量近邻 + 像素亲和度，**没有 Vision 确认**，一律标"待验证"，
//     并明确写出保留了什么证据、改变了什么；两段缺一就照实说缺哪一段。
//   · 媒介筛选由同一份状态驱动，重绘分支不会丢失外部结果。

import { findByKey, findLocalById } from "../services/artService.js";
import { retrieveByArtworkChecked, relationsFor, provenanceLabel } from "../services/retrieval/retrievalService.js";
import { setRouteActive, attachSaveHandlers } from "../app/events.js";
import { renderImg, bindImgFallback, aspectRatioCss } from "../utils/image.js";
import { escapeHtml } from "../utils/html.js";
import { track } from "../utils/profile.js";
import { buildBranches, BRANCHES } from "../services/explore/styleBranches.js";
import { MEDIA_MODES } from "../services/explore/media.js";
import { matchesMedia } from "../services/explore/externalMedia.js";
import {
  fetchExternalNeighbors,
  fetchExternalNeighborsByHash,
  fetchDiscoveryWork,
  fetchDiscoveryJob,
} from "../services/discoveryClient.js";

const REMOTE_PREFIX = "r.";
const isRemoteKey = (key) => typeof key === "string" && key.startsWith(REMOTE_PREFIX);

const LEVEL_LABEL = {
  "vector-only": "同媒介近邻（仅向量）",
  "style-candidate": "待验证的风格延展",
  "same-language": "同一视觉语言（主体未变）",
  "changed-only": "视觉语言证据不足",
};

const NEUTRAL_BRANCH = {
  subject: "换主体（待验证）",
  scene: "换场景（待验证）",
  composition: "换构图（待验证）",
  local: "局部视觉语言（待验证）",
};

const PROVIDER_LABEL = {
  aic: "Art Institute of Chicago",
  met: "The Metropolitan Museum of Art",
  cleveland: "Cleveland Museum of Art",
  rijks: "Rijksmuseum",
  openverse: "Openverse",
  commons: "Wikimedia Commons",
  tmdb: "TMDB",
  anilist: "AniList",
};

/* ---------------- 页面状态（一次渲染一份，切路由即失） ---------------- */

let pageState = null;

function newState(key) {
  return { key, external: null, mode: "all", jobTimer: null, jobId: null };
}

/* ---------------- 通用区块 ---------------- */

function factsBlock(artwork) {
  const rows = [
    ["馆藏 / 来源", artwork.museum],
    ["地区 / Culture", artwork.culture || artwork.origin],
    ["年代", artwork.year],
    ["媒介", artwork.mediumLabel || artwork.medium],
    ["版权", artwork.rightsStatus],
    ["Evidence", artwork.evidenceLevel],
    ["发现关键词", artwork.foundBy],
    ["影片", artwork.movie],
    ["时间戳", artwork.timestamp !== null && artwork.timestamp !== undefined ? `${artwork.timestamp}s` : null],
    ["署名", artwork.credit],
  ].filter(([, v]) => v);
  return `
    <details class="detail-facts">
      <summary>··· / Artwork facts</summary>
      <dl class="metadata-list">
        ${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}
      </dl>
      ${
        artwork.sourceUrl
          ? `<p class="quiet-note"><a href="${escapeHtml(artwork.sourceUrl)}" target="_blank" rel="noreferrer">查看原始馆藏 →</a></p>`
          : ""
      }
    </details>
  `;
}

function whyItWorksSection(artwork) {
  if (!artwork.hasAnalysis) {
    if (artwork.remote) {
      return `
        <section class="analysis-section">
          <h2 class="section-title">WHY IT WORKS</h2>
          <p class="analysis-unavailable">Visual analysis unavailable</p>
          <p class="quiet-note">这件作品是系统自动发现的：有真实图片、实测像素与来源记录，但没有独立视觉画像。我们不替它编造构图或光线分析。</p>
        </section>
      `;
    }
    return `
      <section class="analysis-section">
        <h2 class="section-title">WHY IT WORKS</h2>
        <p class="analysis-unavailable">Visual analysis unavailable</p>
        <p class="quiet-note">该作品来自馆方 API，仅有档案事实。我们不替未知作品编造视觉分析。</p>
      </section>
    `;
  }
  const fields = [
    ["Composition", artwork.composition],
    ["Lighting", artwork.lighting],
    ["Color", artwork.color],
    ["Spatial Structure", artwork.spatialStructure],
  ].filter(([, v]) => v);
  return `
    <section class="analysis-section">
      <h2 class="section-title">WHY IT WORKS</h2>
      <div class="analysis-grid">
        ${fields.map(([k, v]) => `<div class="field-block"><span>${escapeHtml(k)}</span><p>${escapeHtml(v)}</p></div>`).join("")}
      </div>
    </section>
  `;
}

function relationsSection(artwork) {
  if (artwork.remote) return "";
  const outcome = retrieveByArtworkChecked(artwork, { limit: 4 });
  if (!outcome.ok || !outcome.results.length) return "";
  const hits = outcome.results;
  return `
    <section class="analysis-section" id="visual-relations" data-retrieval-evidence="${escapeHtml(
      (outcome.enhancement && outcome.enhancement.evidence) || "none"
    )}">
      <h2 class="section-title">VISUAL RELATIONS</h2>
      ${hits
        .map(
          (item) => `
        <a class="relation-row" href="#artwork/${escapeHtml(item.artwork.key)}">
          <span class="relation-thumb" style="${aspectRatioCss(item.artwork)}">${renderImg(item.artwork)}</span>
          <span class="relation-meta">
            <strong>${escapeHtml(item.artwork.artist)} · ${escapeHtml(item.artwork.titleZh || item.artwork.title)}</strong>
            <small>Retrieval score ${item.retrievalScore} · 匹配依据取自${escapeHtml(provenanceLabel(item.intentProvenance))}</small>
            <ul>${item.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
          </span>
        </a>`
        )
        .join("")}
    </section>
  `;
}

/* ---------------- 本地分支卡片 ---------------- */

function branchCard(branch) {
  const cards = branch.results
    .map(
      (r) => `
      <a class="explore-card" href="${escapeHtml(r.href)}" data-explore-result="${escapeHtml(r.id)}">
        <span class="img-slot" style="${aspectRatioCss(r)}">${renderImg(r)}</span>
        <strong>${escapeHtml(r.title)}</strong>
        <span class="explore-artist">${escapeHtml(r.artist || "")}${r.year ? ` · ${escapeHtml(String(r.year))}` : ""}</span>
        <span class="explore-change">${escapeHtml(r.changes)}</span>
        <ul class="explore-evidence">
          ${r.evidence
            .map((e) => `<li><span class="ev-kind">${escapeHtml(e.kind)}</span>${escapeHtml(e.text)}</li>`)
            .join("")}
        </ul>
        <span class="explore-badge ${r.visionVerified ? "is-verified" : ""}">${
          r.visionVerified ? "有独立画像（A 级）" : "未分析"
        }</span>
      </a>`
    )
    .join("");
  return `
    <article class="explore-branch" data-branch="${escapeHtml(branch.id)}">
      <div class="explore-branch-head">
        <h3>${escapeHtml(branch.label)}</h3>
        <span class="explore-flag">改变：${escapeHtml(branch.changeDim)}</span>
      </div>
      <p class="explore-preserve">保留：${escapeHtml(branch.preserves)}</p>
      <p class="explore-vision" data-tone="${escapeHtml(branch.vision ? branch.vision.tone : "none")}">Vision：${escapeHtml(
        branch.vision ? branch.vision.note : ""
      )}</p>
      ${
        branch.empty
          ? `<p class="explore-empty">这一栏是空的。${escapeHtml(branch.emptyReason || "")}</p>`
          : `<div class="explore-results">${cards}</div>`
      }
    </article>`;
}

/* ---------------- 外部候选卡片 ---------------- */

function externalCard(item) {
  const level = item.level || "changed-only";
  const tone = level === "style-candidate" ? "candidate" : level === "same-language" ? "same" : level === "vector-only" ? "media" : "weak";
  const retained = (item.retained || []).filter(Boolean);
  const changed = (item.changed || []).filter(Boolean);
  const vectorOnly = level === "vector-only";
  // 卡片外层不是链接：里面有两个目标（画之旅内部详情 / 原始馆藏），嵌套 <a> 会被浏览器拆开。
  return `
    <div class="explore-card explore-external"
         data-explore-result="${escapeHtml(item.id)}"
         data-ext-kind="${escapeHtml(item.imageKind || "unknown")}"
         data-ext-sat="${item.metrics && typeof item.metrics.meanSat === "number" ? item.metrics.meanSat : ""}">
      <a class="explore-external-open" href="${escapeHtml(item.href || "#")}">
        <span class="img-slot"><img src="${escapeHtml(item.image)}" alt="" loading="lazy" decoding="async" /></span>
        <strong>${escapeHtml(item.title || "(无标题)")}</strong>
        <span class="explore-artist">${escapeHtml(item.creator || "")}${item.year ? " · " + escapeHtml(String(item.year)) : ""}</span>
      </a>
      <span class="explore-claim" data-tone="${tone}">${escapeHtml(LEVEL_LABEL[level] || "待验证")}</span>
      ${
        vectorOnly
          ? `<ul class="explore-evidence">
               <li><span class="ev-kind">依据</span>向量近邻 cos ${escapeHtml(String(item.cos))}（仅同媒介召回，未做风格判定）</li>
               ${retained.length ? `<li><span class="ev-kind">参考</span>像素相似项 ${escapeHtml(retained.join("；"))}（未达风格阈值）</li>` : ""}
             </ul>`
          : `<ul class="explore-evidence">
               ${
                 retained.length
                   ? `<li><span class="ev-kind">保留</span>${escapeHtml(retained.join("；"))}</li>`
                   : `<li><span class="ev-kind">保留</span>像素证据不足，只有向量近邻（不作为风格证据）</li>`
               }
               ${
                 changed.length
                   ? `<li><span class="ev-kind">改变</span>${escapeHtml(changed.join("；"))}</li>`
                   : `<li><span class="ev-kind">改变</span>未检测到主体/场景/构图变化</li>`
               }
             </ul>`
      }
      <span class="explore-badge is-external">自动发现 · ${escapeHtml(PROVIDER_LABEL[item.provider] || item.provider)}</span>
      <span class="explore-source"><a href="${escapeHtml(item.sourceUrl || "#")}" target="_blank" rel="noreferrer" data-raw-source>原始馆藏 ↗</a></span>
    </div>`;
}

function visibleExternal(mode) {
  const data = pageState && pageState.external;
  if (!data || !data.branches) return { buckets: {}, hidden: 0, total: 0 };
  const buckets = {};
  let hidden = 0;
  let total = 0;
  for (const [key, arr] of Object.entries(data.branches)) {
    const keep = arr.filter((item) => matchesMedia(item, mode));
    hidden += arr.length - keep.length;
    total += arr.length;
    buckets[key] = keep;
  }
  return { buckets, hidden, total };
}

/** 同媒介视觉近邻：仅向量，未做风格判定——所以单独一行，不混进风格分支。 */
function mediaRowCards(mode) {
  const data = pageState && pageState.external && pageState.external.mediaNeighbors;
  if (!data || mode === "all") return { items: [], hidden: 0 };
  const all = data[mode] || [];
  const items = all.filter((i) => matchesMedia(i, mode));
  return { items, hidden: all.length - items.length, total: all.length };
}

function renderMediaRow(mode) {
  const host = document.querySelector("#explore-media-row");
  if (!host) return { shown: 0 };
  const picked = mediaRowCards(mode);
  const items = picked.items.slice(0, 6);
  const hidden = picked.hidden + Math.max(0, picked.items.length - items.length);
  if (!items.length) {
    host.hidden = true;
    host.innerHTML = "";
    return { shown: 0, hidden };
  }
  host.hidden = false;
  host.innerHTML = `
    <div class="explore-media-row-head">
      <h4>同媒介视觉近邻</h4>
      <span>仅向量近邻，未做风格判定 · ${items.length} 张${hidden ? `（另有 ${hidden} 张因媒介规则隐藏）` : ""}</span>
    </div>
    <div class="explore-media-row-cards">${items.map(externalCard).join("")}</div>`;
  return { shown: items.length, hidden };
}

function appendExternal(host, mode) {
  const { buckets, hidden, total } = visibleExternal(mode);
  let shown = 0;
  for (const [key, arr] of Object.entries(buckets)) {
    if (!arr.length) continue;
    const branch = host.querySelector(`[data-branch="${key}"]`);
    if (!branch) continue;
    let list = branch.querySelector(".explore-results");
    if (!list) {
      branch.querySelector(".explore-empty")?.remove();
      list = document.createElement("div");
      list.className = "explore-results";
      branch.appendChild(list);
    }
    list.insertAdjacentHTML("beforeend", arr.map(externalCard).join(""));
    // 一旦这一栏混入外部候选，标题就不能再写"同风格"——那是本地档案+画像才有的说法
    const head = branch.querySelector("h3");
    if (head && !head.dataset.original) {
      head.dataset.original = head.textContent;
      head.textContent = NEUTRAL_BRANCH[key] || "待验证的视觉发现";
    }
    shown += arr.length;
  }
  return { shown, hidden, total };
}

function renderBranches(host, artwork, mode) {
  const local = artwork.remote
    ? BRANCHES.map((def) => ({
        ...def,
        results: [],
        empty: true,
        emptyReason: "以这件外部作品为起点时，这一维度没有拿到候选（它没有档案描述，主体/场景只能从标题判断）。",
        vision: { tone: "none", note: "外部作品没有独立画像，这里不给风格结论。" },
      }))
    : buildBranches(artwork, { media: mode });
  host.innerHTML = local.map(branchCard).join("");
  // 以外部作品为起点的页面：四条分支从一开始就不能叫"同风格"——没有任何一条经过 Vision 确认
  if (artwork.remote) {
    host.querySelectorAll(".explore-branch").forEach((el) => {
      const head = el.querySelector("h3");
      const key = el.dataset.branch;
      if (head && NEUTRAL_BRANCH[key]) head.textContent = NEUTRAL_BRANCH[key];
    });
  }
  const added = appendExternal(host, mode);
  const media = renderMediaRow(mode);
  return { local, ...added, media };
}

/* ---------------- 外部候选抓取与补货 ---------------- */

function setStatus(text) {
  const el = document.querySelector("#explore-external-status");
  if (el) el.textContent = text;
}

async function pollJob(hash, artwork) {
  if (!pageState || !pageState.jobId) return;
  const job = await fetchDiscoveryJob(pageState.jobId);
  if (!pageState) return;
  if (!job) return;
  if (job.status === "queued" || job.status === "running") {
    setStatus(`候选不足，正在后台补充（${job.status === "queued" ? "排队中" : "采集中"}）：${job.query}`);
    pageState.jobTimer = setTimeout(() => pollJob(hash, artwork), 3000);
    return;
  }
  if (job.status === "done") {
    setStatus(`补充完成：新增 ${job.added || 0} 件，正在重新计算候选…`);
    await hydrateExternal(artwork, hash);
    return;
  }
  if (job.status === "failed") {
    setStatus(`补充失败（${job.error || "来源不可用"}）；上面已有结果不受影响。`);
    return;
  }
  setStatus("");
}

async function hydrateExternal(artwork, hash) {
  if (!pageState) return;
  const status = document.querySelector("#explore-external-status");
  if (status) status.textContent = "正在读取自动发现索引…";
  const data = hash ? await fetchExternalNeighborsByHash(hash) : await fetchExternalNeighbors(artwork.id);
  if (!pageState) return;
  if (!data || !data.ok) {
    if (status) {
      status.textContent = data && data.error === "vector-pending"
        ? "这件作品还没有预生成向量，外部候选暂不可用。"
        : "自动发现服务暂时没有返回；上面的候选仍然可用。";
    }
    return;
  }
  pageState.external = data;
  const host = document.querySelector("#explore-branches");
  if (host) {
    const { shown, hidden, total } = renderBranches(host, artwork, pageState.mode);
    setStatus(
      [
        total ? `自动发现候选 ${total} 条，当前媒介下显示 ${shown} 条` : "外部索引里暂时没有更多候选。",
        hidden ? `已按媒介隐藏 ${hidden} 条` : "",
        data.job && data.job.status === "queued" ? "候选偏少，已排入后台补充" : "",
      ].filter(Boolean).join("。")
    );
  }
  if (data.job && (data.job.status === "queued" || data.job.status === "running") && data.job.id !== "cached") {
    pageState.jobId = data.job.id;
    pollJob(hash, artwork);
  }
}

/* ---------------- 探索区 ---------------- */

function exploreSection(artwork) {
  return `
    <section class="analysis-section explore-section" id="explore" data-media="all" data-remote="${artwork.remote ? "1" : "0"}">
      <h2 class="section-title">EXPLORE · ${artwork.remote ? "更多视觉发现（待验证）" : "同风格，换一个维度"}</h2>
      <p class="explore-lede">${
        artwork.remote
          ? "这件作品是自动发现的，没有独立画像。下面是像素实测与向量近邻给出的候选，全部标为待验证——不宣称已验证同风格。"
          : "保留画派与整体气质，每次只改一个维度。每条结果都写明：保留了什么、换掉了什么、证据来自档案、像素实测还是独立画像。"
      }</p>
      <div class="explore-media" role="group" aria-label="按媒介筛选">
        <span class="explore-media-label">媒介</span>
        ${MEDIA_MODES.map(
          (m) => `<button type="button" class="${m.value === "all" ? "is-on" : ""}" data-explore-media="${m.value}">${m.label}</button>`
        ).join("")}
      </div>
      <p class="explore-external-status" id="explore-external-status" aria-live="polite"></p>
      <div class="explore-media-row" id="explore-media-row" hidden></div>
      <div class="explore-branches" id="explore-branches">
        ${
          artwork.remote
            ? BRANCHES.map((def) => branchCard({
                ...def,
                results: [],
                empty: true,
                emptyReason: "等待自动发现候选…",
                vision: { tone: "none", note: "外部作品没有独立画像，这里不给风格结论。" },
              })).join("")
            : buildBranches(artwork, { media: "all" }).map(branchCard).join("")
        }
      </div>
      <p class="explore-media-note" id="explore-media-note"></p>
    </section>`;
}

function cinemaSection(artwork) {
  if (artwork.remote) return "";
  const refs = relationsFor(artwork);
  if (!refs.length) return "";
  return `
    <section class="analysis-section seen-in-cinema">
      <h2 class="section-title">SEEN IN CINEMA</h2>
      ${refs
        .map(
          (r) => `
        <div class="film-ref-row">
          <strong>${escapeHtml(r.filmTitle)}</strong>
          <span>${escapeHtml(r.director || "")} · ${escapeHtml(String(r.year || ""))}</span>
          <em>${escapeHtml(r.relationClass)} · ${escapeHtml(r.relationType)}</em>
          ${r.description ? `<p>${escapeHtml(r.description)}</p>` : ""}
        </div>`
        )
        .join("")}
    </section>
  `;
}

/* ---------------- 渲染 ---------------- */

function detailTemplate(artwork) {
  const isLocal = !artwork.remote;
  return `
    <article class="detail-page" data-remote="${artwork.remote ? "1" : "0"}">
      <figure class="detail-figure" style="${aspectRatioCss(artwork)}">
        ${renderImg(artwork, { priority: true })}
      </figure>
      <header class="detail-head">
        <p class="d-artistline">${escapeHtml(artwork.artistZh || artwork.artist || artwork.creator || "")}</p>
        <h1>${escapeHtml(artwork.titleZh || artwork.title)}${artwork.year ? ` · ${escapeHtml(String(artwork.year))}` : ""}</h1>
        ${artwork.remote ? `<p class="detail-origin">自动发现 · ${escapeHtml(PROVIDER_LABEL[artwork.provider] || artwork.provider || "")}</p>` : ""}
        <div class="detail-actionsrow">
          <a href="#find" data-detail-action="similar">FIND SIMILAR</a>
          ${isLocal ? `<a href="#create/${escapeHtml(artwork.id)}" data-detail-action="create">CREATE WITH THIS</a>` : ""}
          ${isLocal ? `<a class="alt" href="#shoot/${escapeHtml(artwork.key)}" data-detail-action="shoot">SHOOT LIKE THIS</a>` : ""}
          ${
            artwork.sourceUrl
              ? `<a class="alt" href="${escapeHtml(artwork.sourceUrl)}" target="_blank" rel="noreferrer" data-raw-source>查看原始馆藏 ↗</a>`
              : ""
          }
        </div>
      </header>
      <div class="detail-body">
        ${whyItWorksSection(artwork)}
        ${exploreSection(artwork)}
        ${relationsSection(artwork)}
        ${cinemaSection(artwork)}
        ${factsBlock(artwork)}
        ${
          isLocal
            ? `<div class="context-actions record-actions">
                 <button class="ghost-action" type="button" data-save-artwork="${escapeHtml(artwork.id || artwork.key)}" aria-pressed="false">收藏到我的视觉档案</button>
               </div>`
            : ""
        }
      </div>
    </article>
  `;
}

function wireDetail(app, artwork, hash) {
  bindImgFallback(app);
  if (!artwork.remote) attachSaveHandlers(app);

  const explore = app.querySelector("#explore");
  if (explore) {
    hydrateExternal(artwork, hash);
    const branchesHost = explore.querySelector("#explore-branches");
    const note = explore.querySelector("#explore-media-note");
    explore.querySelectorAll("[data-explore-media]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!pageState) return;
        const mode = btn.dataset.exploreMedia;
        pageState.mode = mode;
        explore.querySelectorAll("[data-explore-media]").forEach((b) => b.classList.toggle("is-on", b === btn));
        explore.dataset.media = mode;
        const { local, shown, hidden } = renderBranches(branchesHost, artwork, mode);
        const excluded = local[0] && local[0].mediaState ? local[0].mediaState.excluded : { monochromeFilms: 0 };
        const emptyCount = local.filter((b) => b.empty).length;
        const externalTotal = pageState.external ? Object.values(pageState.external.branches).flat().length : 0;
        const mediaShown = branchesHost.parentElement.querySelector("#explore-media-row:not([hidden])") ? true : false;
        note.textContent = [
          excluded.monochromeFilms ? `已排除 ${excluded.monochromeFilms} 张黑白电影剧照（不作为 AIGC 视觉参考）。` : "",
          externalTotal ? `风格候选 ${externalTotal} 条，本媒介下 ${shown} 条${hidden ? `，隐藏 ${hidden} 条` : ""}。` : "",
          mediaShown ? "下方另列同媒介视觉近邻（仅向量）。" : "",
          emptyCount === 4 && !shown ? (local[0].emptyReason || "") : "",
        ].filter(Boolean).join(" ");
      });
    });
  }

  app.querySelector('[data-detail-action="similar"]')?.addEventListener("click", (e) => {
    e.preventDefault();
    document.querySelector("#explore")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function remoteToArtwork(doc) {
  const w = doc.work;
  const m = doc.metrics || {};
  const ratio = m.aspect ? 1 / m.aspect : 0.75;
  return {
    id: `r.${w.hash}`,
    key: `r.${w.hash}`,
    remote: true,
    hash: w.hash,
    title: w.title,
    titleZh: w.title,
    artist: w.creator,
    creator: w.creator,
    year: w.year,
    provider: w.provider,
    providerId: w.providerId,
    museum: PROVIDER_LABEL[w.provider] || w.provider,
    medium: w.medium,
    mediumLabel: w.medium,
    imageKind: w.imageKind,
    rightsStatus: w.rights,
    sourceUrl: w.sourceUrl,
    foundBy: w.foundBy,
    movie: w.movie,
    timestamp: w.timestamp,
    credit: w.credit,
    licenseUrl: w.licenseUrl,
    image: { url: w.image, ratio },
    metrics: doc.metrics || null,
    hasAnalysis: false,
  };
}

async function renderRemote(app, hash) {
  pageState = newState(`r.${hash}`);
  app.innerHTML = `<div class="detail-page"><p class="quiet-note" id="remote-loading">正在读取这件自动发现的作品…</p></div>`;
  const doc = await fetchDiscoveryWork(hash);
  if (!doc || !doc.ok) {
    app.innerHTML = `<div class="empty">没有找到这件作品（可能已从索引中移除）。<a href="#find">回到图片墙</a></div>`;
    return;
  }
  const artwork = remoteToArtwork(doc);
  track("viewedArtwork", artwork.id);
  setRouteActive("");
  app.innerHTML = detailTemplate(artwork);
  wireDetail(app, artwork, hash);
}

export function renderArtwork(app, key) {
  if (isRemoteKey(key)) {
    renderRemote(app, key.slice(REMOTE_PREFIX.length));
    return;
  }
  const artwork = findByKey(key) || findLocalById(key);
  if (!artwork) {
    app.innerHTML = `<div class="empty">未找到该作品。<a href="#find">回到图片墙</a></div>`;
    return;
  }
  pageState = newState(artwork.key || artwork.id);
  track("viewedArtwork", artwork.id || artwork.key);
  setRouteActive("");
  app.innerHTML = detailTemplate(artwork);
  wireDetail(app, artwork, null);
}
