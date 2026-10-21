// openverseAdapter.js — Openverse（WordPress 基金会）开放图片检索，第五个发现来源。
//
// 为什么加它：四馆都是"艺术作品馆藏"，题材停留在美术史内部；
// Openverse 覆盖 Flickr / Wikimedia / 各机构开放授权图，能发现
// "雨夜街道""城市天际线"这类现实影像，正好补四馆缺的题材。
//
// 许可：API 无需 key；每条记录自带 license + license_version + foreign_landing_url。
// 这里只取缩略图作为预览（thumbnail），不下载原图——PoC 阶段不做大流量抓取。
//
// 注意：Openverse 的 thumbnail 由上游缓存提供，尺寸不一；ratio 用记录的
// width/height 计算（缺失时为 null，交给准入规则剔除）。

const API = "https://api.openverse.org/v1/images/";

export const openverseAdapter = {
  source: "openverse",
  sourceName: "Openverse",
  enabled: true,

  async search(query, { limit = 24 } = {}) {
    // MEASURED：匿名请求 page_size 上限是 20，超过不会给 400，而是给 401
    // （detail: "page_size may not exceed 20 for anonymous requests"）。
    // 所以要 30-50 条必须翻页，不能把 page_size 顶大。
    const out = [];
    const pages = Math.min(3, Math.ceil(limit / 20));
    for (let page = 1; page <= pages; page += 1) {
      const params = new URLSearchParams({
        q: query,
        page_size: "20",
        page: String(page),
        mature: "false",
      });
      const call = () => fetch(`${API}?${params}`, {
        headers: { "User-Agent": "visual-ancestry-poc/0.1 (local research)" },
      });
      let res = await call();
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 4000));
        res = await call();
      }
      if (!res.ok) {
        if (page === 1) throw new Error(`Openverse ${res.status}`);
        break; // 后续页失败就保留已拿到的部分
      }
      const json = await res.json();
      const batch = (json.results || []).map((r) => this.toRaw(r)).filter(Boolean);
      out.push(...batch);
      if (out.length >= limit || !json.next) break;
      await new Promise((r) => setTimeout(r, 900)); // 匿名配额，页间留间隔
    }
    return out.slice(0, limit);
  },

  toRaw(r) {
    if (!r || !r.thumbnail || !r.id) return null;
    const ratio = r.width && r.height ? r.height / r.width : null;
    const license = [r.license, r.license_version].filter(Boolean).join(" ").toUpperCase();
    return {
      source: this.source,
      sourceId: r.id,
      title: r.title || "",
      artist: r.creator || "",
      year: "",
      origin: r.source || "",           // 上游（flickr / wikimedia / met …）
      culture: "",
      museum: r.source ? `Openverse · ${r.source}` : "Openverse",
      medium: "",                        // Openverse 不保证给出媒介，留空不猜
      image: {
        url: r.thumbnail,
        tiers: { thumb: r.thumbnail, preview: r.thumbnail, detail: r.url || r.thumbnail },
        ratio,
        fallbackUrl: null,
      },
      rights: license || "Unknown license",
      publicDomain: /^(CC0|PDM)/i.test(license),
      sourceUrl: r.foreign_landing_url || r.url || "",
      sourceName: this.sourceName,
    };
  },
};
