// aicAdapter.js — Art Institute of Chicago, public API (no key, CORS-enabled).
// https://api.artic.edu/api/v1 — IIIF image service for all tiers.
const API = "https://api.artic.edu/api/v1";
const IIIF = "https://www.artic.edu/iiif/2";

export const aicAdapter = {
  source: "aic",
  sourceName: "Art Institute of Chicago",
  enabled: true,

  async search(query, { limit = 12 } = {}) {
    const url =
      `${API}/artworks/search?q=${encodeURIComponent(query)}&limit=${Math.min(limit, 24)}` +
      `&fields=id,title,image_id,artist_title,artist_display,date_display,place_of_origin,medium_display,is_public_domain,department_title,classification_title,thumbnail,api_link`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`AIC ${res.status}`);
    const json = await res.json();
    return (json.data || []).map((item) => this.toRaw(item)).filter(Boolean);
  },

  toRaw(item) {
    if (!item.image_id) return null;
    const ratio = item.thumbnail && item.thumbnail.width
      ? item.thumbnail.height / item.thumbnail.width
      : null;
    const tier = (w) => `${IIIF}/${item.image_id}/full/${w},/0/default.jpg`;
    const artist = item.artist_title || (item.artist_display || "").split("(")[0].trim() || "";
    return {
      source: this.source,
      sourceId: item.id,
      title: item.title,
      artist,
      year: item.date_display || "",
      origin: item.place_of_origin || "",
      culture: item.place_of_origin || "",
      museum: this.sourceName,
      medium: item.medium_display || "",
      image: {
        url: tier(960),
        tiers: { thumb: tier(480), preview: tier(960), detail: tier(1920) },
        ratio,
        fallbackUrl: null,
      },
      rights: item.is_public_domain ? "Public domain" : "Institution rights reserved",
      publicDomain: Boolean(item.is_public_domain),
      sourceUrl: item.api_link || `https://www.artic.edu/artworks/${item.id}`,
      sourceName: this.sourceName,
    };
  },
};
