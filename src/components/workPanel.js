// workPanel.js —— 作品详情：桌面侧栏 / 手机详情层（Phase 2「减少跳转」）
//
// 为什么用侧栏而不是跳页：
//   跳页会丢掉「搜索词 + 媒介筛选 + 滚动位置」这三样用户刚建立起来的上下文，
//   看完还得退回来重找。侧栏不换页面，所以这三样天然保留；关闭时再显式
//   还原一次滚动位置与焦点，属于防御而不是补救。
//
// 深链不受影响：每个作品仍然带 href="#artwork/<key>"，只有**普通左键点击**
// 被拦截；中键/右键/⌘点击仍然由浏览器接管，地址栏也仍然可以复制。
//
// 动作全部复用既有能力，不新造后端写入：
//   收藏      → attachSaveHandlers（收藏到我的视觉档案）
//   使用参考  → recordReference（TaskContext 引用体系）
//   生成 Prompt→ #create/<id>
//   拍摄指导  → #shoot/<key>
//   来源核验  → 馆藏/来源/版权/证据等级（与详情页同一份 factsBlock 数据）
import { findByKey, findLocalById } from "../services/artService.js";
import { attachSaveHandlers } from "../app/events.js";
import { renderImg, bindImgFallback } from "../utils/image.js";
import { escapeHtml } from "../utils/html.js";
import { beginTask, recordReference } from "../utils/taskContext.js";

function factsRows(artwork) {
  return [
    ["馆藏", artwork.museum],
    ["来源", artwork.source ? artwork.source.name : ""],
    ["年代", artwork.year],
    ["版权", artwork.rightsStatus],
    ["证据等级", artwork.evidenceLevel],
  ].filter(([, v]) => v);
}

function analysisHtml(artwork) {
  if (!artwork.hasAnalysis) {
    return `<p class="quiet-note">该作品只带档案事实，没有视觉分析记录。我们不替没有依据的作品编造分析。</p>`;
  }
  const fields = [
    ["构图", artwork.composition],
    ["光线", artwork.lighting],
    ["色彩", artwork.color],
    ["空间结构", artwork.spatialStructure],
  ].filter(([, v]) => v);
  if (!fields.length) return "";
  return fields
    .map(
      ([label, value]) => `
    <p><strong>${escapeHtml(label)}</strong><br />${escapeHtml(value)}</p>`
    )
    .join("");
}

function panelHtml(artwork) {
  const id = artwork.id || artwork.key;
  const rows = factsRows(artwork);
  return `
    <div class="work-panel-head">
      <div>
        <p class="work-panel-artist">${escapeHtml(artwork.artistZh || artwork.artist || "")}</p>
        <h2 class="work-panel-title">${escapeHtml(artwork.titleZh || artwork.title)}${
    artwork.year ? ` · ${escapeHtml(String(artwork.year))}` : ""
  }</h2>
      </div>
      <button class="work-panel-close" type="button" data-panel-close aria-label="关闭详情">关闭</button>
    </div>
    <figure class="work-panel-figure">${renderImg(artwork, { priority: true })}</figure>
    <div class="work-panel-actions">
      <button type="button" class="is-primary" data-panel-reference="${escapeHtml(id)}">使用参考</button>
      <button class="ghost-action" type="button" data-save-artwork="${escapeHtml(id)}" aria-pressed="false">收藏</button>
      ${artwork.id ? `<button type="button" data-panel-create="${escapeHtml(artwork.id)}">生成 Prompt</button>` : ""}
      <a href="#shoot/${escapeHtml(artwork.key)}" data-panel-shoot="1">拍摄指导</a>
      <a href="#artwork/${escapeHtml(artwork.key)}" data-panel-deeplink="1">完整页面</a>
    </div>
    <div class="work-panel-body">
      ${analysisHtml(artwork)}
      <h3>来源核验</h3>
      <dl class="metadata-list">
        ${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}
      </dl>
      ${
        artwork.sourceUrl
          ? `<p class="quiet-note"><a href="${escapeHtml(artwork.sourceUrl)}" target="_blank" rel="noreferrer">在馆方查看原记录 →</a></p>`
          : `<p class="quiet-note">这件作品没有可点的来源链接，来源核验只能到上面这几项。</p>`
      }
      <p class="quiet-note">视觉特征未经图像分析核对；这里展示的是档案事实与已登记的分析字段。</p>
    </div>
  `;
}

// 用作品 key 或 id 找到档案对象；墙上与结果里的 href 都带 key。
function resolveWork(key) {
  return findByKey(key) || findLocalById(key) || null;
}

/**
 * 绑定作品点击 → 详情侧栏/详情层。
 * 作用域是 root（默认 document），只处理带 data-plate-key / data-hit-key 的链接。
 */
export function bindWorkPanel(app, { root = null } = {}) {
  const scope = root || app || document;
  let panel = document.querySelector(".work-panel");
  let backdrop = document.querySelector(".work-panel-backdrop");
  let lastTrigger = null;

  const ensurePanel = () => {
    if (!panel) {
      backdrop = document.createElement("div");
      backdrop.className = "work-panel-backdrop";
      backdrop.hidden = true;
      backdrop.addEventListener("click", () => closePanel());
      panel = document.createElement("aside");
      panel.className = "work-panel";
      panel.hidden = true;
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "false");
      panel.setAttribute("aria-label", "作品详情");
      document.body.append(backdrop, panel);
      panel.addEventListener("click", onPanelClick);
      document.addEventListener("keydown", onKey);
      // 路由变化必须收起面板：它挂在 document.body 上，不随页面 DOM 一起销毁。
      // 不收的话，点「作品记忆」之后这块浮层会盖在新页面上，而且还在显示上一个
      // 页面���作品 —— 实测截图里就是这样，连拍七个场景面板一直没关。
      window.addEventListener("hashchange", closePanelOnRoute);
    }
    return panel;
  };

  const closePanel = () => {
    if (!panel || panel.hidden) return;
    // 关闭后恢复滚动位置与焦点：面板是 fixed 覆盖层，正常情况下滚动不受影响，
    // 但明确还原一次，避免以后有人给面板加内滚动时静默改变用户位置。
    const y = window.scrollY;
    panel.hidden = true;
    backdrop.hidden = true;
    if (lastTrigger && document.contains(lastTrigger)) lastTrigger.focus({ preventScroll: true });
    window.scrollTo({ top: y, behavior: "instant" });
  };

  const onKey = (event) => {
    if (event.key === "Escape" && panel && !panel.hidden) closePanel();
  };

  // hashchange 只在「真的换路由」时收起面板。面板里的「生成 Prompt」「拍摄指导」
  // 是真实链接，点了会换路由 —— 那种情况下收起是对的（即将离开这个页面）；
  // 而面板自己打开时不会触发 hashchange，所以不会被自己关掉。
  const closePanelOnRoute = () => {
    if (panel && !panel.hidden) closePanel();
  };

  const onPanelClick = (event) => {
    const close = event.target.closest("[data-panel-close]");
    if (close) {
      closePanel();
      return;
    }
    const ref = event.target.closest("[data-panel-reference]");
    if (ref) {
      const artwork = resolveWork(ref.dataset.panelReference) || current;
      if (artwork) {
        beginTask();
        // MEASURED 缺陷（本轮查出）：recordReference 的签名是 (key: string)，
        // 传对象会被第一行 `typeof key !== "string"` 直接挡下，**什么都不写**，
        // 而且不报错、不抛异常 —— 于是「使用参考」按钮看起来生效（提示语出现），
        // CREATE 却收不到任何参考。上一版验收只查了提示语，所以是假通过。
        recordReference(artwork.key);
        flash(ref, "已加入参考，可直接进入创作或拍摄");
      }
      return;
    }
    // 生成 Prompt：先登记参考，再跳 CREATE。
    // CREATE 是靠 TaskContext 里的参考来决定选哪几幅的（syncTaskReferences），
    // 只跳不登记的话页面看起来和没点一样 —— 实测踩过。
    const create = event.target.closest("[data-panel-create]");
    if (create) {
      const artwork = resolveWork(create.dataset.panelCreate) || current;
      if (artwork) {
        beginTask();
        // 同样是 string key（见上方「使用参考」处的说明）
        recordReference(artwork.key);
        flash(create, "已加入参考，去写画面");
      }
      window.location.hash = "#create";
      closePanel();
      return;
    }

    // 拍摄指导 / 完整页面是真实链接，交给路由处理。
    const link = event.target.closest('a[href^="#"]');
    if (link) {
      closePanel();
    }
  };

  let current = null;
  const flash = (button, message) => {
    const old = button.textContent;
    button.textContent = message;
    button.disabled = true;
    setTimeout(() => {
      button.textContent = old;
      button.disabled = false;
    }, 1600);
  };

  const openPanel = (key, trigger) => {
    const artwork = resolveWork(key);
    if (!artwork) return false;
    current = artwork;
    ensurePanel();
    panel.innerHTML = panelHtml(artwork);
    panel.hidden = false;
    backdrop.hidden = false;
    bindImgFallback(panel);
    attachSaveHandlers(panel);
    panel.querySelector("[data-panel-close]")?.focus({ preventScroll: true });
    return true;
  };

  scope.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-plate-key], a[data-hit-key]");
    if (!link) return;
    // 修饰键 / 非左键：交给浏览器（新标签打开、复制链接等原生行为）
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const key = link.dataset.plateKey || link.dataset.hitKey;
    if (!key) return;
    if (openPanel(key, link)) {
      lastTrigger = link;
      event.preventDefault(); // 深链 href 保留在 DOM 里，只有这里阻止了默认跳转
    }
  });
}