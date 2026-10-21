// providers/tmdb.mjs — TMDB 官方 API（服务端专用）。
//
// 凭据只从环境变量读，绝不出现在 URL 查询参数、日志或返回体里。
// 图片种类严格区分：
//   backdrop  → promotional-backdrop（宣传背景，不是正片画面）
//   poster    → poster
//   episode   → tv-episode-still（单集剧照，唯一可以当"动画/影视画面"的）
//
// 未配置 Token 时，search() 返回状态 credential-required，不做任何网络请求。

import { getJson } from "../http.mjs";
import { normalize, IMAGE_KINDS } from "../normalize.mjs";

const API = "https://api.tmdb.org/3";
const IMAGE_BASE_DEFAULT = "https://image.tmdb.org/t/p";

function token() {
  return process.env.TMDB_READ_ACCESS_TOKEN || "";
}

export function tmdbStatus() {
  return token() ? "configured" : "credential-required";
}

async function tmdb(pathAndQuery) {
  const t = token();
  if (!t) throw Object.assign(new Error("TMDB_READ_ACCESS_TOKEN 未配置"), { status: 0, credential: true });
  const { json, status } = await getJson(`${API}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${t}`, accept: "application/json" },
  });
  return { json, status };
}

let cachedConfig = null;
async function imageBase() {
  if (cachedConfig) return cachedConfig;
  const { json } = await tmdb("/configuration");
  const base = json?.images?.secure_base_url || IMAGE_BASE_DEFAULT;
  cachedConfig = { base, sizes: json?.images?.poster_sizes || ["w342"], backdropSizes: json?.images?.backdrop_sizes || ["w780"] };
  return cachedConfig;
}

export const tmdbProvider = {
  id: "tmdb",
  label: "TMDB（电影 / 剧集 / 动画单集）",
  capabilities: ["film-still", "tv-episode-still", "promotional-backdrop", "poster"],
  credentialRequired: true,

  /**
   * @param {string} query
   * @param {{limit?:number, season?:number, episode?:number, kind?:"movie"|"tv"|"both"}} opts
   */
  async search(query, { limit = 12, season = 1, episode = 1, kind = "both" } = {}) {
    const started = Date.now();
    if (!token()) {
      return [{ provider: "tmdb", status: 0, credentialRequired: true, returned: 0, records: [], latencyMs: 0, error: "TMDB_READ_ACCESS_TOKEN 未配置" }];
    }
    const out = { provider: "tmdb", status: 200, returned: 0, records: [], latencyMs: 0 };
    try {
      const cfg = await imageBase();
      const url = (size, file) => `${cfg.base}${size}${file}`;
      const kinds = kind === "both" ? ["movie", "tv"] : [kind];
      for (const k of kinds) {
        const { json } = await tmdb(`/search/${k}?query=${encodeURIComponent(query)}&include_adult=false&language=en-US&page=1`);
        for (const item of (json?.results || []).slice(0, Math.ceil(limit / kinds.length))) {
          const title = item.title || item.name || "";
          const year = String(item.release_date || item.first_air_date || "").slice(0, 4);
          const detail = await tmdb(`/${k}/${item.id}/images?include_image_language=en,null`);
          const backdrops = (detail.json?.backdrops || []).slice(0, 3);
          const posters = (detail.json?.posters || []).slice(0, 1);
          for (const b of backdrops) {
            out.records.push(normalize({
              providerId: `${k}:${item.id}:backdrop:${b.file_path}`,
              title, creator: null, year, medium: k === "movie" ? "film" : "tv",
              imageKind: IMAGE_KINDS.PROMOTIONAL_BACKDROP,
              imageUrl: url(cfg.backdropSizes.at(-1) || "w780", b.file_path),
              thumbnailUrl: url("w780", b.file_path),
              sourceUrl: `https://www.themoviedb.org/${k}/${item.id}`,
              rightsStatus: "TMDB terms; promotional image", license: "TMDB",
              width: b.width, height: b.height, origin: "tmdb",
            }, { provider: "tmdb", query }));
          }
          for (const p of posters) {
            out.records.push(normalize({
              providerId: `${k}:${item.id}:poster:${p.file_path}`,
              title, creator: null, year, medium: k === "movie" ? "film" : "tv",
              imageKind: IMAGE_KINDS.POSTER,
              imageUrl: url(cfg.sizes.at(-1) || "w342", p.file_path),
              thumbnailUrl: url("w342", p.file_path),
              sourceUrl: `https://www.themoviedb.org/${k}/${item.id}`,
              rightsStatus: "TMDB terms; poster", license: "TMDB",
              width: p.width, height: p.height, origin: "tmdb",
            }, { provider: "tmdb", query }));
          }
          // 单集剧照：只有 TV 才有，且是唯一能当"画面"的
          if (k === "tv") {
            try {
              const ep = await tmdb(`/tv/${item.id}/season/${season}/episode/${episode}/images`);
              for (const s of (ep.json?.stills || []).slice(0, 4)) {
                out.records.push(normalize({
                  providerId: `tv:${item.id}:s${season}e${episode}:still:${s.file_path}`,
                  title: `${title} S${season}E${episode}`, creator: null, year, medium: "tv",
                  imageKind: IMAGE_KINDS.TV_EPISODE_STILL,
                  imageUrl: url("original", s.file_path),
                  thumbnailUrl: url("w780", s.file_path),
                  sourceUrl: `https://www.themoviedb.org/tv/${item.id}/season/${season}/episode/${episode}`,
                  rightsStatus: "TMDB terms; episode still", license: "TMDB",
                  width: s.width, height: s.height, origin: "tmdb",
                }, { provider: "tmdb", query }));
              }
            } catch { /* 该剧没有单集剧照就跳过，不编造 */ }
          }
        }
      }
      out.returned = out.records.length;
      out.latencyMs = Date.now() - started;
      return [out];
    } catch (e) {
      return [{ ...out, status: Number(e.status) || 0, latencyMs: Date.now() - started, error: String(e.message).slice(0, 140) }];
    }
  },
};
