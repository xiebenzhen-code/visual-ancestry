// remoteFilmCard.js — STEP 4：远程电影候选卡与它的四个动作。
//
// 为什么单独成组件：这张卡要同时承担「如实展示核验状态」和「用户纠正」两件事，
// 混进 find.js 会让页面文件继续膨胀，而且动作绑定需要跟随远程区段的每次重绘。
//
// 四个动作：
//   选为参考   —— 记入 TaskContext，下游 CREATE 能取用（不新增另一套引用体系）
//   核对原始来源 —— 直达 Commons / Wikidata 页面，由用户自己复核
//   标记有误   —— 选轴 + **必填证据**，写入会话级纠正记录
//   排除此件   —— 从本次列表移除，并把被排除的件数如实报出
//
// 边界：纠正记录只说「这条声称有问题 + 我的依据」，**不改写**导演、年份等事实字段。
// 事实只来自来源的具名陈述；模型的判断没有资格写进事实。

import { escapeHtml } from "../utils/html.js";
import { renderImg, aspectRatioCss } from "../utils/image.js";
import { recordReference, beginTask, getSnapshot } from "../utils/taskContext.js";
import { recordCorrection, summarizeCorrections } from "../services/retrieval/filmCorrections.js";

const AXIS_BADGE = { verified: "已核验", partial: "部分核验", unverified: "未核验" };

function axisRow(a) {
  if (!a) return "";
  // Commons 有些描述/分类原文本身就以「证据:」开头，外面再拼一个前缀会渲染成
  // 「证据： 证据: …」（实测见过）。先剥掉原文自带的标签再拼。
  const raw = String(a.evidence || "").replace(/^\s*(证据|evidence)\s*[:：]\s*/i, "");
  const evidence = raw ? `<span class="find-remote-evidence">证据：${escapeHtml(raw.slice(0, 120))}</span>` : "";
  return `<li><b>${escapeHtml(a.label)}</b>：${escapeHtml(String(a.value))}（${escapeHtml(
    AXIS_BADGE[a.status] || a.status
  )}）${evidence}</li>`;
}

const LOC_LABEL = {
  description: "文件描述",
  category: "Commons 类目",
  "description+category": "描述与类目",
  "title-only": "仅片名",
};

function recallLine(art) {
  const rb = art.recallBasis || null;
  const label = art.visualStatusLabel || "未验证";
  if (!rb || !rb.matched || !rb.matched.length) {
    return `<p class="find-remote-recall">召回依据：${escapeHtml(label)}（未被任何检索词命中）</p>`;
  }
  const parts = rb.matched.map(
    (m) =>
      `「${escapeHtml(m.term)}」${escapeHtml(LOC_LABEL[m.location] || m.location)}（${escapeHtml(
        String(m.source || "").replace("受控词表·", "")
      )}${m.matchedToken && m.matchedToken !== m.term ? `←你的词「${escapeHtml(m.matchedToken)}」` : ""}）`
  );
  const unmapped = (rb.unmapped || []).length ? ` · 未参与检索：${escapeHtml(rb.unmapped.join("、"))}` : "";
  return `<p class="find-remote-recall">召回依据：${escapeHtml(label)} · ${parts.join("，")}${unmapped}</p>`;
}

export function renderRemoteFilmCard(item, film) {
  const art = item.artwork;
  const remote = art.remote || {};
  const axes = remote.axes || {};
  const identity = art.identity || null;
  const vision = (film && film.vision) || null;
  const corrections = art.corrections || [];
  const sourceId = escapeHtml(remote.sourceId || "");

  const visionLine =
    vision && vision.analyzed > 0
      ? `已做图像分析 ${vision.analyzed}/${vision.attempted} 件（${escapeHtml(vision.provenance)}）`
      : vision && vision.note
        ? escapeHtml(vision.note)
        : "未做图像分析";

  // P4.9 STEP 4 — 默认层只留「这是什么 / 凭什么进来的 / 去哪核」。
  // 身份、许可细节、三轴核验、用户校正全部收进 <details>，一条证据都不删。
  // 旧版把四按钮 + 标记表单 + 三轴 + 依据全部摊开，五列网格下每卡被挤成一列长条，
  // 一屏装不下两张卡 —— 那是布局问题，不是信息量问题。
  const title = art.film?.titleZh || art.title || "";
  const year = art.year ? String(art.year) : "";
  const kindLabel = art.imageKindLabel || "未标注";
  const kindBadge = AXIS_BADGE[art.imageKindStatus] || art.imageKindStatus || "未核验";

  return `
    <div class="find-hit find-hit-remote find-hit-film" data-film-source="${sourceId}"
         data-film-title="${escapeHtml(title)}"
         data-film-year="${escapeHtml(year)}">
      <span class="find-ref-thumb" style="${aspectRatioCss(art)}">${renderImg(art)}</span>
      <div class="find-remote-body">
        <em class="find-remote-title">${escapeHtml(title)}${year ? ` · ${escapeHtml(year)}` : ""}</em>
        <p class="find-remote-nature">图像性质：${escapeHtml(kindLabel)}（${escapeHtml(kindBadge)}）</p>
        ${item.display?.reason ? `<p class="find-remote-tier">${escapeHtml(item.display.reason)}</p>` : ""}
        ${(() => {
          // P4.10 — 像素比较证据。只有真的比较过才显示；没有就是没有，不留空壳。
          const px = item.pixelCompare;
          if (!px) return "";
          const sim = (px.explanation?.similar || []).slice(0, 2);
          const dif = (px.explanation?.different || []).slice(0, 2);
          const inc = px.explanation?.incomparable || [];
          return `
            <div class="find-remote-pixel">
              <p class="find-remote-pixel-head"><strong>像素分布：${escapeHtml(px.levelLabel)}</strong>
                <span class="find-remote-pixel-dist">距离 ${escapeHtml(String(px.distance))}</span></p>
              ${sim.length ? `<ul class="find-remote-pixel-sim">${sim.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : ""}
              ${dif.length ? `<ul class="find-remote-pixel-dif">${dif.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : ""}
              ${inc.length ? `<p class="quiet-note">${escapeHtml(inc.join("；"))}</p>` : ""}
              <p class="quiet-note">${escapeHtml(px.explanation?.disclaimer || "")}</p>
              <p class="quiet-note find-remote-pixel-limit">实测它分辨不出「同一张图重新裁切」与「换了另一幅画」，<strong>所以不能当作画面相似的证据，也不参与排序。</strong></p>
            </div>`;
        })()}
        ${recallLine(art)}
        <p class="find-remote-source"><a href="${escapeHtml(remote.sourceUrl || "#")}" target="_blank" rel="noopener noreferrer">Commons 原始来源</a>
          ${remote.rights?.licenseShortName ? ` · ${escapeHtml(String(remote.rights.licenseShortName))}` : ""}</p>
        ${
          corrections.length
            ? `<p class="find-remote-corrected">你标记过：${escapeHtml(summarizeCorrections(corrections))}</p>`
            : ""
        }
        <details class="find-remote-more">
          <summary>身份、许可与核验详情</summary>
          <div class="find-remote-more-body">
            <p class="find-remote-director">导演：${escapeHtml(art.film?.directorZh || "未知（未确证）")}</p>
            <ul class="find-remote-axes">
              ${axisRow(axes.identity)}${axisRow(axes.nature)}${axisRow(axes.licence)}
              ${
                identity && identity.wikidataUrl
                  ? `<li><b>身份复核</b>：<a href="${escapeHtml(identity.wikidataUrl)}" target="_blank" rel="noopener noreferrer">Wikidata ${escapeHtml(
                      String(identity.qid || "")
                    )}</a>${identity.imdbId ? ` · IMDb ${escapeHtml(identity.imdbId)}` : ""}</li>`
                  : ""
              }
            </ul>
            <small class="find-remote-prov">依据：Commons 文件元数据（许可 + 类目 + 描述）${
              identity && identity.wikidataStatus === "verified" ? " + Wikidata 身份核实" : ""
            } · ${visionLine} · 匹配分 ${item.retrievalScore}</small>
            <div class="find-remote-actions">
              <button type="button" class="ghost-action" data-film-action="pick" data-film-source="${sourceId}">选为参考</button>
              <a class="ghost-action" href="${escapeHtml(remote.sourceUrl || "#")}" target="_blank" rel="noopener noreferrer">核对原始来源</a>
              <button type="button" class="ghost-action" data-film-action="flag" data-film-source="${sourceId}">标记有误</button>
              <button type="button" class="ghost-action" data-film-action="exclude" data-film-source="${sourceId}">排除此件</button>
            </div>
            <form class="find-remote-flag" data-film-flag-for="${sourceId}" hidden>
              <label>哪一项有误？
                <select data-film-axis>
                  <option value="identity">电影身份（导演 / 年份 / 片名）</option>
                  <option value="nature">图像性质（不是影片画面等）</option>
                  <option value="licence">版权依据</option>
                </select>
              </label>
              <label>证据（必填：引文、链接或你的判断依据）
                <textarea data-film-evidence rows="2" placeholder="例如：Commons 描述为 lobby card，实际是印刷品"></textarea>
              </label>
              <p class="quiet-note">标记只作为你的纠正记录（本次会话内有效），<strong>不会</strong>改写来源的导演、年份等事实字段。</p>
              <button type="submit" class="ghost-action">记录标记</button>
              <button type="button" class="ghost-action" data-film-cancel="1">取消</button>
            </form>
            <p class="find-remote-flash" data-film-flash-for="${sourceId}" hidden></p>
          </div>
        </details>
      </div>
    </div>`;
}
/**
 * 绑定四个动作。必须在远程区段每次重绘后调用（含异步补写），
 * 因此放在远程区段的唯一写入口里，而不是渲染函数内部。
 */
export function bindFilmRemoteActions(app, { onChanged = null, onExcluded = null } = {}) {
  const host = app.querySelector("#find-remote");
  if (!host || host.dataset.filmBound === "1") return;
  host.dataset.filmBound = "1";

  const flash = (sourceId, text, isError = false) => {
    const el = host.querySelector(`[data-film-flash-for="${CSS.escape(sourceId)}"]`);
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    el.classList.toggle("is-error", Boolean(isError));
  };

  host.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-film-action]");
    if (btn) {
      const sourceId = btn.dataset.filmSource || "";
      const card = btn.closest(".find-hit-film");
      const action = btn.dataset.filmAction;
      if (action === "flag") {
        const form = card?.querySelector(".find-remote-flag");
        if (form) {
          form.hidden = !form.hidden;
          if (!form.hidden) form.querySelector("[data-film-evidence]")?.focus();
        }
        return;
      }
      if (action === "pick") {
        // 记入 TaskContext：没有任务上下文时先开一个空的，
        // 这样 CREATE 能看到这条参考（引用体系只有这一套，不新增第二条路）。
        const snap = getSnapshot();
        if (!snap.fresh) beginTask(null);
        recordReference(sourceId);
        flash(sourceId, `已选为参考：${sourceId}`);
        btn.textContent = "已选为参考";
        btn.disabled = true;
        return;
      }
      if (action === "exclude") {
        const ok = recordCorrection({
          sourceId,
          axis: "nature",
          verdict: "unverifiable",
          evidence: "用户选择排除此件（无法核实）",
        });
        if (ok.ok) {
          // 排除必须**改变当前结果集**：先本地移除，再让页面用留存的远程结果
          // 重渲染（计数同步更新）。只写记录、不改列表的话，用户会以为排除没生效。
          card?.setAttribute("data-excluded", "1");
          if (card) card.style.display = "none";
          flash(sourceId, "已排除本次会话中的这件候选");
          if (onExcluded) onExcluded(sourceId);
        } else {
          flash(sourceId, `排除未记录：${ok.reason}`, true);
        }
        return;
      }
    }
    if (event.target.closest("[data-film-cancel]")) {
      event.target.closest(".find-remote-flag")?.setAttribute("hidden", "");
      return;
    }
  });

  host.addEventListener("submit", (event) => {
    const form = event.target.closest(".find-remote-flag");
    if (!form) return;
    event.preventDefault();
    const sourceId = form.dataset.filmFlagFor || "";
    const axis = form.querySelector("[data-film-axis]")?.value || "identity";
    const evidence = form.querySelector("[data-film-evidence]")?.value || "";
    const card = form.closest(".find-hit-film");
    const claimedFrom =
      axis === "nature"
        ? card?.querySelector(".find-remote-nature")?.textContent?.trim() || ""
        : axis === "licence"
          ? card?.querySelectorAll(".find-remote-axes li")[2]?.textContent?.trim() || ""
          : card?.querySelectorAll(".find-remote-axes li")[0]?.textContent?.trim() || "";
    const outcome = recordCorrection({ sourceId, axis, verdict: "wrong", evidence, claimedFrom });
    if (outcome.ok) {
      form.hidden = true;
      form.querySelector("[data-film-evidence]").value = "";
      flash(sourceId, `已记录你的标记（${axis === "identity" ? "电影身份" : axis === "nature" ? "图像性质" : "版权依据"}有误）`);
      if (onChanged) onChanged(sourceId, outcome.entry);
    } else {
      flash(sourceId, `标记未记录：${outcome.reason === "evidence-required" ? "证据为必填" : outcome.reason}`, true);
    }
  });
}