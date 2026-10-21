// providers/commonsCinema.mjs — Commons 上的「真实画面」按分类采集。
//
// 与 commons.mjs（关键词搜索）的差别：
//   · 走分类成员，不做关键词搜索 —— 分类本身已经限定了"这是电影/动画画面"
//   · 许可证逐条硬校验：只收公有领域 / CC0 / CC BY / CC BY-SA，其余一律跳过
//   · 标题级排除：海报、片名字卡、字幕卡、预告片、幕后、封面、DVD 包装都不算画面
//
// 不做网页抓取，只用 MediaWiki 官方 API。

import { getJson } from "../http.mjs";
import { normalize, IMAGE_KINDS } from "../normalize.mjs";

const API = "https://commons.wikimedia.org/w/api.php";
const UA = { "User-Agent": "visual-ancestry/phase22a (research; local)" };

// 允许的许可表述（大小写不敏感）。其余（fair use / non-free / 缺字段）一律跳过。
const LICENSE_OK = /public domain|pd-|cc0|cc-by|cc by|creative commons attribution|no known copyright/i;
const LICENSE_BAD = /fair use|non-free|nonfree|copyright|all rights reserved|permission/i;

const NOT_A_FRAME = [
  /poster/i, /\btitle card\b/i, /intertitle/i, /titlecard/i, /trailer/i,
  /behind the scenes/i, /making[- ]of/i, /\blogo\b/i, /\bcover\b/i, /\bdvd\b/i,
  /blu-?ray/i, /screenshot of (the )?(credits|menu)/i, /concept art/i, /storyboard/i,
  /\bpromo/i, /publicity/i, /film still photographer/i,
  /\btitolo\b/i, /\btitel\b/i, /\btítulo\b/i, /\bzaglavlje\b/i,
  // 分类里混进来的非影片静帧（迈布里奇实验照片、核试验高速摄影等）
  /muybridge/i, /\btest stills?\b/i, /explosion/i, /nuclear/i, /high[- ]speed camera/i,
];

const ANIMATION_HINT = /animat|cartoon|animation/i;

export function isFrameCandidate(title, category, description = "") {
  // 描述也要查：有些片名字卡的标题很普通（Pisacane bis），但描述里写着 "titolo del film"
  const t = `${title} ${category || ""} ${description || ""}`;
  if (NOT_A_FRAME.some((re) => re.test(t))) return false;
  return /\.(jpe?g|png|webp)$/i.test(title);
}

/** 许可判定：返回 { ok, license, reason }。 */
export function licenseVerdict(meta) {
  const short = String(meta?.LicenseShortName?.value || "").trim();
  const usage = String(meta?.UsageTerms?.value || "").trim();
  const combined = `${short} ${usage}`.trim();
  if (!combined) return { ok: false, license: null, reason: "无许可证字段" };
  if (LICENSE_BAD.test(combined)) return { ok: false, license: short || usage, reason: `许可不可用：${short || usage}` };
  if (!LICENSE_OK.test(combined)) return { ok: false, license: short || usage, reason: `许可不明：${short || usage}` };
  return { ok: true, license: short || usage, reason: null };
}

const plain = (html) => String(html || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

export const commonsCinemaProvider = {
  id: "commons-cinema",
  label: "Wikimedia Commons（电影 / 动画画面分类）",
  capabilities: ["film-still", "animation-frame"],
  credentialRequired: false,

  /**
   * @param {string} _query 未使用：本来源按分类采，不按关键词
   * @param {{limit?:number, categories?:string[], kindHint?:string}} opts
   */
  async search(_query, { limit = 40, categories = [], kindHint = null } = {}) {
    const started = Date.now();
    const out = [];
    let lastStatus = 200;
    const errors = [];
    const skipped = { license: 0, notFrame: 0, noImage: 0, lowRes: 0 };

    for (const [ci, cat] of categories.entries()) {
      // 限流：Commons 对连续请求会直接返回纯文本错误，必须留间隔
      if (ci > 0) await new Promise((r) => setTimeout(r, 700));
      try {
        // 分类成员（文件）
        const params = new URLSearchParams({
          action: "query", format: "json", generator: "categorymembers",
          gcmtitle: cat, gcmtype: "file", gcmlimit: String(Math.min(50, limit)),
          prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "960",
        });
        const { json, status } = await getJson(`${API}?${params}`, { headers: UA });
        lastStatus = status;
        const pages = json?.query?.pages ? Object.values(json.query.pages) : [];
        for (const p of pages) {
          const info = (p.imageinfo || [])[0];
          const title = plain(p.title);
          if (!info) { skipped.noImage += 1; continue; }
          const metaRaw = info.extmetadata || {};
          if (!isFrameCandidate(title, cat, plain(metaRaw.ImageDescription?.value))) { skipped.notFrame += 1; continue; }
          const meta = info.extmetadata || {};
          // 元数据必须能自证是"影片画面"：描述/分类/文件名里要有 film/movie/cinema/animation 之类
          const desc = plain(meta.ImageDescription?.value);
          const cats = plain(meta.Categories?.value);
          const filmEvidence = /film|movie|cinema|animat|cartoon|screenshot|frame/i.test(`${title} ${desc} ${cats}`);
          if (!filmEvidence) { skipped.notFrame += 1; continue; }
          const verdict = licenseVerdict(meta);
          if (!verdict.ok) { skipped.license += 1; errors.push(verdict.reason); continue; }
          if (!info.width || !info.height || Math.min(info.width, info.height) < 200) { skipped.lowRes += 1; continue; }

          const isAnim = kindHint === "animation" || ANIMATION_HINT.test(`${title} ${cat}`) || ANIMATION_HINT.test(plain(meta.Categories?.value));
          out.push(normalize({
            providerId: String(p.pageid),
            title: title.replace(/^File:/i, "").replace(/\.(jpe?g|png|webp)$/i, ""),
            creator: plain(meta.Artist?.value) || plain(meta.Credit?.value) || null,
            year: plain(meta.DateTimeOriginal?.value).slice(0, 30) || null,
            medium: isAnim ? "animation" : "film",
            imageKind: isAnim ? IMAGE_KINDS.ANIMATION_FRAME : IMAGE_KINDS.FILM_STILL,
            imageUrl: info.url,
            thumbnailUrl: info.thumburl || info.url,
            sourceUrl: info.descriptionurl,
            rightsStatus: verdict.license,
            license: verdict.license,
            width: info.width,
            height: info.height,
            origin: `commons:${cat.replace(/^Category:/, "")}`,
            extra: { category: cat, usageTerms: plain(meta.UsageTerms?.value) || null, credit: plain(meta.Credit?.value) || null, description: desc.slice(0, 160) || null },
          }, { provider: "commons", query: cat.replace(/^Category:/, "") }));
        }
      } catch (e) {
        errors.push(`${cat}: ${String(e.message).slice(0, 80)}`);
        lastStatus = Number(e.status) || lastStatus;
      }
    }

    const deduped = new Map(out.map((r) => [r.id, r]));
    return [{
      provider: "commons",
      status: lastStatus,
      returned: deduped.size,
      records: [...deduped.values()],
      latencyMs: Date.now() - started,
      skipped,
      errors: errors.slice(0, 4),
    }];
  },
};
