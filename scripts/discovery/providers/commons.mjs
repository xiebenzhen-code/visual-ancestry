// providers/commons.mjs — Wikimedia Commons 图片检索（正式 API，不抓 HTML）。
//
// 只取文件命名空间（gsrnamespace=6）的图片，附带 imageinfo：
// 缩略图地址、原始尺寸、MIME、许可与作者。Commons 的图既可能是绘画也可能是照片，
// 所以 imageKind 由许可/描述里的关键词判定，判不出来就是 unknown——不冒充绘画。

import { getJson } from "../http.mjs";
import { normalize, IMAGE_KINDS } from "../normalize.mjs";

const API = "https://commons.wikimedia.org/w/api.php";

function kindOf(meta, mime) {
  const text = [
    meta?.ObjectName?.value, meta?.ImageDescription?.value, meta?.Categories?.value,
    meta?.Artist?.value, meta?.Credit?.value,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/painting|oil on canvas|watercolou?r|etching|engraving|lithograph|drawing|woodblock|tempera|fresco/.test(text)) {
    return IMAGE_KINDS.ARTWORK;
  }
  if (/poster/.test(text)) return IMAGE_KINDS.POSTER;
  if (/photograph|photo|daguerreotype/.test(text)) return IMAGE_KINDS.PHOTOGRAPH;
  if (mime === "image/jpeg" || mime === "image/png") return IMAGE_KINDS.PHOTOGRAPH;
  return IMAGE_KINDS.UNKNOWN;
}

const plain = (html) => String(html || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

export const commonsProvider = {
  id: "commons",
  label: "Wikimedia Commons",
  capabilities: ["artwork", "photograph"],
  credentialRequired: false,

  async search(query, { limit = 24 } = {}) {
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      generator: "search",
      gsrsearch: `filetype:bitmap ${query}`,
      gsrnamespace: "6",
      gsrlimit: String(Math.min(limit, 50)),
      prop: "imageinfo",
      iiprop: "url|size|mime|extmetadata",
      iiurlwidth: "640",
    });
    const started = Date.now();
    try {
      const { json } = await getJson(`${API}?${params}`, {
        headers: { "User-Agent": "visual-ancestry-poc/0.2 (research; contact: local)" },
      });
      const pages = json?.query?.pages ? Object.values(json.query.pages) : [];
      const records = pages.map((p) => {
        const info = (p.imageinfo || [])[0];
        if (!info) return null;
        const meta = info.extmetadata || {};
        return normalize(
          {
            providerId: String(p.pageid),
            title: plain(p.title).replace(/^File:/i, "").replace(/\.(jpe?g|png|tiff?|webp|gif)$/i, ""),
            creator: plain(meta.Artist?.value) || null,
            year: plain(meta.DateTimeOriginal?.value).slice(0, 40) || null,
            medium: plain(meta.MediaType?.value) || null,
            imageKind: kindOf(meta, info.mime),
            imageUrl: info.url,
            thumbnailUrl: info.thumburl || info.url,
            sourceUrl: info.descriptionurl || `https://commons.wikimedia.org/?curid=${p.pageid}`,
            rightsStatus: plain(meta.LicenseShortName?.value) || null,
            license: plain(meta.LicenseShortName?.value) || null,
            width: info.width,
            height: info.height,
            origin: "wikimedia-commons",
          },
          { provider: "commons", query },
        );
      }).filter(Boolean);
      return [{ provider: "commons", status: 200, returned: records.length, records, latencyMs: Date.now() - started }];
    } catch (e) {
      return [{ provider: "commons", status: Number(e.status) || 0, returned: 0, records: [], latencyMs: Date.now() - started, error: String(e.message).slice(0, 140) }];
    }
  },
};
