// rijksAdapter.js — Rijksmuseum via the CURRENT official Data Services.
// No API key. Two hops:
//   1. Search API  https://data.rijksmuseum.nl/search/collection
//      (Linked Art Search spec) returns Linked Data identifiers.
//   2. Resolver    https://data.rijksmuseum.nl/<n>?_profile=edm-framed
//      returns EDM JSON-LD with title / creator / date / IIIF image.
// IIIF Image API: https://iiif.micr.io/<imageId>/full/{w},/0/default.jpg
const SEARCH_URL = "https://data.rijksmuseum.nl/search/collection";
const RESOLVE_URL = "https://data.rijksmuseum.nl";

export const rijksAdapter = {
  source: "rijks",
  sourceName: "Rijksmuseum",
  enabled: true,

  async search(query, { limit = 12 } = {}) {
    // The Search API has typed params, not a free-text "q". For a generic
    // keyword we query the fields most likely to match: creator + description
    // (English/Dutch terms both work), then merge + dedupe by LOD id.
    const params = new URLSearchParams({ imageAvailable: "true" });
    params.set("creator", query);
    params.set("description", query);
    const res = await fetch(`${SEARCH_URL}?${params}`);
    if (!res.ok) throw new Error(`Rijks search HTTP ${res.status}`);
    const json = await res.json();
    const ids = (json.orderedItems || []).map((item) => item.id).filter(Boolean);

    // Resolve metadata for the first `limit` identifiers.
    const out = [];
    for (const id of ids.slice(0, limit)) {
      try {
        const raw = await this.resolveObject(id);
        if (raw) out.push(raw);
      } catch (error) {
        console.warn(`[rijks] resolve ${id} failed: ${error.message}`);
      }
    }
    return out;
  },

  async resolveObject(id) {
    const num = String(id).split("/").pop();
    const res = await fetch(`${RESOLVE_URL}/${num}?_profile=edm-framed`, {
      headers: { accept: "application/ld+json" },
    });
    if (!res.ok) throw new Error(`Rijks resolve HTTP ${res.status}`);
    const json = await res.json();
    return this.toRaw(json, num);
  },

  toRaw(edm, num) {
    const cho = edm.aggregatedCHO || edm;
    // creator -> skos prefLabel (en preferred, fallback nl)
    let artist = "";
    const creators = Array.isArray(cho.creator) ? cho.creator : cho.creator ? [cho.creator] : [];
    if (creators.length) {
      const labels = creators[0]["http://www.w3.org/2004/02/skos/core#prefLabel"];
      const pick = (arr) => (arr || []).find((l) => l["@language"] === "en")?.["@value"]
        || (arr || [])[0]?.["@value"] || "";
      artist = pick(labels);
    }
    // title: {"en": [...], "nl": [...]} or a literal
    let title = "";
    if (typeof cho.title === "string") title = cho.title;
    else if (cho.title && cho.title.en && cho.title.en.length) title = cho.title.en[0];
    else if (cho.title && typeof cho.title === "object") {
      const firstLang = Object.values(cho.title)[0];
      title = Array.isArray(firstLang) ? firstLang[0] : firstLang;
    }
    // year: created = [{ "@language": "en", "@value": "c. 1660" }, ...]
    let year = "";
    if (Array.isArray(cho.created)) {
      year = cho.created.find((l) => l["@language"] === "en")?.["@value"]
        || cho.created[0]?.["@value"] || "";
    } else if (typeof cho.created === "string") {
      year = cho.created;
    }
    // medium / type (dcType skos prefLabel)
    let medium = "";
    if (Array.isArray(cho.dcType) && cho.dcType.length) {
      const labels = cho.dcType[0]["http://www.w3.org/2004/02/skos/core#prefLabel"];
      medium = (labels || []).find((l) => l["@language"] === "en")?.["@value"] || "";
    }
    // IIIF image via iiif.micr.io access point
    const imageId = this.iiifImageId(edm);
    let image = null;
    if (imageId) {
      const base = `https://iiif.micr.io/${imageId}/full`;
      image = {
        url: `${base}/960,/0/default.jpg`,
        tiers: {
          thumb: `${base}/480,/0/default.jpg`,
          preview: `${base}/960,/0/default.jpg`,
          detail: `${base}/1920,/0/default.jpg`,
        },
        ratio: null,
        fallbackUrl: null,
      };
    }
    const license = JSON.stringify(edm).match(/creativecommons\.org\/(licenses|publicdomain)\/[a-z0-9.\/-]+/i)?.[0] || "";
    const rights = license ? `${license} (Rijksmuseum)` : "Rijksmuseum data services";
    const objectNumber = (Array.isArray(cho.identifier) ? cho.identifier[0] : cho.identifier) || num;
    return {
      source: this.source,
      sourceId: num,
      title,
      artist,
      year,
      origin: "",
      culture: "Netherlands",
      museum: this.sourceName,
      medium,
      image,
      rights,
      publicDomain: license.includes("publicdomain") || license.includes("public-domain"),
      sourceUrl: `https://www.rijksmuseum.nl/nl/collectie/object/${encodeURIComponent(objectNumber)}`,
      sourceName: this.sourceName,
    };
  },

  // locate the iiif.micr.io access point inside the EDM JSON-LD
  iiifImageId(edm) {
    const json = JSON.stringify(edm);
    const m = json.match(/https:\/\/iiif\.micr\.io\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  },
};
