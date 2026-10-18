// image.js — tiered-image helpers for the Phase 2A image system.
// Local works get three webp tiers (480/960/1920) from the pipeline;
// remote works get best-effort tiers straight from the museum adapters.
// Everything degrades: placeholder by known ratio -> tier fallback chain ->
// "IMAGE UNAVAILABLE". Never infinite retries.

import { escapeHtml } from "./html.js";

// 参考候选卡片（CREATE / FIND / SHOOT 的 picks 网格）的 sizes 契约：
// 卡片在三种断点下实际能占到的最大宽度 —— 820px 以下两列约 45vw、
// 1180px 以下三列约 30vw、桌面五列约 17vw。少了它，手机浏览器会按
// auto 规则挑到 1920 档的大图，首屏因此卡在下载上（本轮 STEP 1 的实测问题）。
export const PICK_SIZES = "(max-width: 820px) 45vw, (max-width: 1180px) 30vw, 17vw";

export function tierUrl(artwork, tier) {
  const t = artwork.image && artwork.image.tiers;
  if (t && t[tier]) return t[tier];
  return (artwork.image && artwork.image.url) || "";
}

// Ratio is stored as h/w (like CSS aspect-ratio needs w/h, we invert).
export function aspectRatioCss(artwork) {
  const ratio = artwork.image && artwork.image.ratio;
  if (ratio && ratio > 0) return `aspect-ratio: ${(1 / ratio).toFixed(3)} / 1`;
  const o = artwork.orientation || "landscape";
  return o === "vertical" || o === "portrait"
    ? "aspect-ratio: 3 / 4"
    : "aspect-ratio: 4 / 3";
}

// Build <img> attributes for a tiered image.
export function imgAttrs(artwork, { priority = false, sizes = "(max-width: 680px) 96vw, (max-width: 1020px) 48vw, 31vw" } = {}) {
  const img = artwork.image;
  const attrs = {
    src: tierUrl(artwork, "detail") || (img && img.url) || "",
    srcset: "",
    sizes: "",
    loading: priority ? "eager" : "lazy",
    decoding: priority ? "sync" : "async",
    fetchpriority: priority ? "high" : "auto",
    alt: escapeHtml(artwork.titleZh || artwork.title || ""),
    "data-fallback-chain": "",
  };
  if (img && img.tiers && img.tiers.thumb && img.tiers.preview && img.tiers.detail) {
    attrs.srcset =
      `${img.tiers.thumb} 480w, ${img.tiers.preview} 960w, ${img.tiers.detail} 1920w`;
    attrs.sizes = sizes;
    attrs["data-fallback-chain"] = [img.tiers.thumb, img.tiers.preview, img.tiers.detail]
      .concat(img.fallbackUrl || [])
      .filter(Boolean)
      .join("|");
  } else if (img && img.url) {
    attrs["data-fallback-chain"] = (img.tiers ? [img.tiers.thumb, img.tiers.preview].filter(Boolean) : [])
      .concat(img.fallbackUrl || [], img.url)
      .filter(Boolean)
      .join("|");
  }
  return attrs;
}

export function renderImg(artwork, { priority = false, sizes = null } = {}) {
  const a = imgAttrs(artwork, sizes ? { priority, sizes } : { priority });
  const style = `style="${aspectRatioCss(artwork)}"`;
  const title = escapeHtml(artwork.titleZh || artwork.title || "作品");
  return `
    <div class="img-slot" ${style}>
      <img src="${a.src}"${a.srcset ? ` srcset="${a.srcset}" sizes="${a.sizes}"` : ""}
        loading="${a.loading}" decoding="${a.decoding}" fetchpriority="${a.fetchpriority}"
        alt="${a.alt}" data-fallback-chain="${escapeHtml(a["data-fallback-chain"])}" data-failures="0" />
      <span class="img-unavailable" aria-hidden="true">
        <strong>${title}</strong>
        <small>图像暂不可用 · 仅档案与分析</small>
      </span>
    </div>
  `;
}

// One-shot fallback walker. Bound after innerHTML injection (no inline JS).
//
// 两个真实缺陷在这一轮修掉（都是渲染逻辑，不是资源）：
//   1) 原来先 img.remove() 再 closest(".img-slot") —— 元素已经脱离文档，
//      查不到 .img-slot，is-broken 从来没被写上，真正的失败永远显示不出占位。
//   2) srcset 还在时改写 img.src 不会生效：浏览器仍按 srcset 选源，
//      于是 tier 回退链等于空转。失败一次就撤掉 srcset/sizes，让 src 说了算。
export function bindImgFallback(scope, { onBroken = null, loadTimeoutMs = 25000, retryTimeoutMs = 9000 } = {}) {
  const images = scope.querySelectorAll("img[data-fallback-chain]");
  images.forEach((img) => {
    const slot = img.closest(".img-slot");
    // Loading is its own state: a slot that has not decoded yet is not broken.
    if (slot && !img.complete) slot.classList.add("is-loading");

    // MEASURED（P2 STEP 2）：远程渠道并发取 6 张图时，upload/thumb.wikimedia.org
    // 有 5 张既不返回也不报错 —— 20 秒后仍 complete=false。实测同一批 URL
    // 逐个取（间隔 400ms）全部 200，个别并发请求直接 429（retry-after: 1）。
    // 也就是说失败形态是「挂着」，不是 error 事件，原来的回退链永远不会启动，
    // 卡片就一直空着。既然等不到，就主动放弃这一档、换下一档 URL。
    // 两档预算不能一视同仁（都是实测出来的）：
    //   · 首档 25s —— Met 缩略图冷启动实测要 13.7s（600px），Cleveland 5.0s。
    //     实测踩过：首档也只给 12s 时，一张 13.7s 的缩略图被当成挂死而放弃，
    //     回退到原始大文件（2463px，实测 17–24s 且多数失败），于是
    //     「远程图片能否解码」从能变成不能 —— 判据被自己的超时机制破坏。
    //   · 换档后 9s —— 后面的档位是替代方案，逐档等满 25s 会把一次失败拖成 1 分钟。
    let timer = null;
    const arm = () => {
      const budget = Number(img.dataset.failures || 0) > 0 ? retryTimeoutMs : loadTimeoutMs;
      if (!budget) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        // 只在「仍未完成且仍在加载中」时才算超时（error/load 已清除定时器）。
        if (!img.complete) img.dispatchEvent(new Event("timeout-src"));
      }, budget);
    };

    // ---- 超时只对「已经进入视口、浏览器已经开始请求」的图才有意义 ----
    //
    // MEASURED（本轮 UI 改版实测）：给所有图都上计时器时，图片墙上
    // loading="lazy" 的图（首屏只加载前几张 eager）在 25 秒后被判「挂死」，
    // 走完回退链被标 .is-broken，页面出现一堆「图像暂不可用」占位。
    // 实测开发服务器 20 路并发取墙图 20/20 成功、总耗时 61ms ——
    // 服务器完全扛得住，坏的是判定逻辑。把「还没加载」误判成「加载不了」
    // 正是任务书禁止的「用空白卡代替内容」。
    const observeThenArm = () => {
      if (typeof IntersectionObserver === "undefined") {
        arm(); // 无观察器的环境：退回旧行为（宁可误判，也不留空白）
        return;
      }
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.disconnect();
            arm(); // 进入视口 → 浏览器此刻才开始请求，这时计时才成立
          }
        },
        { rootMargin: "300px" }
      );
      io.observe(img);
    };
    const settle = () => {
      clearTimeout(timer);
      timer = null;
    };

    img.addEventListener("load", () => {
      settle();
      slot?.classList.remove("is-loading");
      img.dataset.loaded = "1";
    });

    const advance = () => {
      const chain = (img.dataset.fallbackChain || "").split("|").filter(Boolean);
      let failures = Number(img.dataset.failures || 0);
      failures += 1;
      img.dataset.failures = String(failures);
      if (failures > 2 || !chain.length) {
        img.remove();
        slot?.classList.remove("is-loading");
        slot?.classList.add("is-broken");
        if (slot && typeof onBroken === "function") onBroken(slot);
        return;
      }
      const next = chain.shift();
      img.dataset.fallbackChain = chain.join("|");
      if (next) {
        // srcset would win over src — drop it before walking the chain.
        img.removeAttribute("srcset");
        img.removeAttribute("sizes");
        img.src = next;
        arm(); // 换档后重新计时，否则新的一档可以无限期挂着
      }
    };

    img.addEventListener("error", () => {
      settle();
      advance();
    });
    img.addEventListener("timeout-src", () => {
      // 如实记录这一档是被放弃的，而不是「加载失败」。
      img.dataset.timedOut = String(Number(img.dataset.timedOut || 0) + 1);
      advance();
    });

    observeThenArm();
  });
}
