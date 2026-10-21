// clevelandAdapter.js — The Cleveland Museum of Art, open access API (no key, CORS-enabled).
// Provides web (≈723px) and print (≈2732px) images + IIIF. CC0 licensing flag.
const API = "https://openaccess-api.clevelandart.org/api/artworks/";

export const clevelandAdapter = {
  source: "cleveland",
  sourceName: "The Cleveland Museum of Art",
  enabled: true,

  async search(query, { limit = 12 } = {}) {
    const select = [
      "id", "title", "creation_date", "culture", "technique", "department",
      "type", "images", "creators", "artists", "url", "share_license_status", "tombstone",
    ].join(",");
    // has_image=1：不加时 API 会返回没有 images.web 的档案条目，落地就是 0 件可用图。
    const url = `${API}?search=${encodeURIComponent(query)}&has_image=1&limit=${Math.min(limit, 40)}&select=${select}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Cleveland ${res.status}`);
    const json = await res.json();
    return (json.data || []).map((item) => this.toRaw(item)).filter(Boolean);
  },

  toRaw(item) {
    const web = item.images && item.images.web;
    const print = item.images && item.images.print;
    if (!web || !web.url) return null;
    const ratio = Number(web.width) && Number(web.height) ? Number(web.height) / Number(web.width) : null;
    const artist = this.artistName(item);
    return {
      source: this.source,
      sourceId: item.id,
      title: item.title || "",
      artist,
      year: item.creation_date || "",
      origin: Array.isArray(item.culture) ? item.culture.join(" / ") : (item.culture || ""),
      culture: Array.isArray(item.culture) ? item.culture.join(" / ") : (item.culture || ""),
      museum: this.sourceName,
      medium: item.technique || item.type || "",
      image: {
        url: (print && print.url) || web.url,
        tiers: {
          thumb: web.url,
          preview: web.url,
          detail: (print && print.url) || web.url,
        },
        ratio,
        fallbackUrl: null,
      },
      rights: item.share_license_status ? `${item.share_license_status} (Cleveland Museum of Art)` : "Open access",
      publicDomain: item.share_license_status === "CC0",
      sourceUrl: item.url || "",
      sourceName: this.sourceName,
    };
  },

  artistName(item) {
    if (Array.isArray(item.creators) && item.creators.length && item.creators[0].name) {
      return item.creators[0].name;
    }
    if (Array.isArray(item.artists) && item.artists.length && item.artists[0].name) {
      return item.artists[0].name;
    }
    // tombstone: "Title, date. Artist (Nationality, dates). Medium..." —
    // the artist segment is the one whose pre-"(" part contains no digits.
    const seg = (item.tombstone || "").split(".").find((s) => {
      const before = s.split("(")[0];
      return s.includes("(") && !/\d/.test(before) && before.trim().length > 0;
    });
    return seg ? seg.split("(")[0].trim() : "";
  },
};
