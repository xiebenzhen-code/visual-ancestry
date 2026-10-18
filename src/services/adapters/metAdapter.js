// metAdapter.js — The Metropolitan Museum of Art, public Collection API (no key, CORS-enabled).
// Search returns id lists without pagination; we fetch objects until `limit`
// works with a usable image are collected. No 480px tier is provided by the
// API, so thumb/preview share primaryImageSmall and detail uses primaryImage.
//
// MEASURED 2026-10-14: `/public/collection/v1/search` is RETIRED and now
// answers HTTP 410 Gone. This adapter was still pointing at it, so every Met
// search in the app failed with "MET 410" — the channel looked dead. The search
// endpoint moved to v1.1 (Elastic-backed, paginated); the DETAIL endpoint did
// NOT move and still serves on v1. artSourceAdapter.metSource already had this
// migration; this adapter had not been updated with it.
const SEARCH_API = "https://collectionapi.metmuseum.org/public/collection/v1.1/search";
const API = "https://collectionapi.metmuseum.org/public/collection/v1";

export const metAdapter = {
  source: "met",
  sourceName: "The Metropolitan Museum of Art",
  enabled: true,

  async search(query, { limit = 12 } = {}) {
    // hasImages=true keeps the id list to objects that actually carry an image;
    // without it most hits are metadata-only records with no primaryImage.
    const sRes = await fetch(`${SEARCH_API}?q=${encodeURIComponent(query)}&hasImages=true`);
    if (!sRes.ok) throw new Error(`MET ${sRes.status}`);
    const { objectIDs = [] } = await sRes.json();
    const ids = objectIDs.slice(0, Math.min(limit * 4, 80));
    const out = [];
    for (const id of ids) {
      if (out.length >= limit) break;
      try {
        const raw = await this.fetchObject(id);
        if (raw) out.push(raw);
      } catch {
        // skip objects that fail to load
      }
    }
    return out;
  },

  async fetchObject(id) {
    const res = await fetch(`${API}/objects/${id}`);
    if (!res.ok) throw new Error(`MET object ${res.status}`);
    const o = await res.json();
    return this.toRaw(o);
  },

  toRaw(o) {
    if (!o || !o.primaryImage) return null; // many search hits are non-public-domain
    const ratio = this.ratioFromMeasurements(o);
    const small = o.primaryImageSmall || o.primaryImage;
    return {
      source: this.source,
      sourceId: o.objectID,
      title: o.title || "",
      artist: o.artistDisplayName || o.artistAlphaSort || "",
      year: o.objectDate || "",
      origin: o.artistNationality || "",
      culture: o.culture || o.artistNationality || "",
      museum: this.sourceName,
      medium: o.medium || "",
      image: {
        url: o.primaryImage,
        tiers: { thumb: small, preview: small, detail: o.primaryImage },
        ratio,
        fallbackUrl: null,
      },
      rights: o.rightsAndReproduction || (o.isPublicDomain ? "Public domain" : "Institution rights reserved"),
      publicDomain: Boolean(o.isPublicDomain),
      sourceUrl: o.objectURL || `https://www.metmuseum.org/art/collection/search/${o.objectID}`,
      sourceName: this.sourceName,
    };
  },

  ratioFromMeasurements(o) {
    const m = (o.measurements || []).find((x) => x.elementName === "Overall");
    const em = m && m.elementMeasurements;
    if (em && em.Width && em.Height) return em.Height / em.Width;
    return null;
  },
};
