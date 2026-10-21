// providers/anilist.mjs — AniList GraphQL（免费、无需 key）。
//
// 只产出"目录图片"：cover / banner → anime-cover。
// 这些**不是**剧集画面，不能拿来当动画视觉参考。
// TMDB 关联靠标题+年份的保守匹配，匹配不上就保持 unmatched（不猜 id 对应关系）。

import { normalize, IMAGE_KINDS } from "../normalize.mjs";

const ENDPOINT = "https://graphql.anilist.co";

const QUERY = `query ($search: String, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
      id
      title { romaji english native }
      startDate { year }
      format
      genres
      coverImage { extraLarge large }
      bannerImage
      siteUrl
      isAdult
    }
  }
}`;

async function graphql(variables) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: QUERY, variables }),
      signal: controller.signal,
    });
    if (!res.ok) throw Object.assign(new Error(`AniList HTTP ${res.status}`), { status: res.status });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export const anilistProvider = {
  id: "anilist",
  label: "AniList（动漫目录）",
  capabilities: ["anime-cover"],
  credentialRequired: false,
  /** 目录封面不是画面，标记出来供上层过滤。 */
  catalogOnly: true,

  async search(query, { limit = 20 } = {}) {
    const started = Date.now();
    try {
      const json = await graphql({ search: query, perPage: Math.min(limit, 25) });
      const media = json?.data?.Page?.media || [];
      const records = media.filter((m) => !m.isAdult).map((m) => normalize({
        providerId: String(m.id),
        title: m.title?.english || m.title?.romaji || m.title?.native || null,
        creator: null,
        year: m.startDate?.year ? String(m.startDate.year) : null,
        medium: m.format ? `anime:${m.format}` : "anime",
        imageKind: IMAGE_KINDS.ANIME_COVER,
        imageUrl: m.bannerImage || m.coverImage?.extraLarge || m.coverImage?.large,
        thumbnailUrl: m.coverImage?.large || m.coverImage?.extraLarge,
        sourceUrl: m.siteUrl,
        rightsStatus: "AniList catalog image; rights with original publisher",
        license: "AniList",
        width: null,
        height: null,
        origin: "anilist",
      }, { provider: "anilist", query }));
      return [{ provider: "anilist", status: 200, returned: records.length, records, latencyMs: Date.now() - started }];
    } catch (e) {
      return [{ provider: "anilist", status: Number(e.status) || 0, returned: 0, records: [], latencyMs: Date.now() - started, error: String(e.message).slice(0, 140) }];
    }
  },
};
