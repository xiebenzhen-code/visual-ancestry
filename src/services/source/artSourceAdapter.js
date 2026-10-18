// P6.3 — external art source adapter (NEW MODULE, additive only).
//
// This file adds source integration. It imports NOTHING from the frozen core and
// changes NOTHING in it: Vision / Retrieval / Profile / Assistant are untouched,
// and `visualIntent` remains the only retrieval field. Adapters produce raw
// asset records (file + provenance); turning a record into a VisualMemory
// requires a real provider intent, which is orchestrated outside this module.
//
// Contracts were established by measurement, not assumption (work/p6.3/probe-*):
//
//  MET — MIGRATED. `/public/collection/v1/search` was retired on 2026-10-01 and
//        now answers with an error message pointing at `/v1.1/search`
//        (Elastic-backed, paginated). The `/objects/{id}` detail endpoint did
//        NOT move and still serves on v1. Any adapter still on v1 search is
//        broken against the live API today.
//
//  Rijks — the `isShownBy.id` field carries a COMPLETE, WORKING IIIF URL
//        (https://iiif.micr.io/<handle>/full/max/0/default.jpg). The pattern
//        documented in the older adapter — building
//        `https://iiif.micr.io/<id>/full/{w},/0/default.jpg` from a bare object
//        number — returns 404 against the live service. We use the real URL and
//        only rewrite the size segment.
//
//  AIC — IIIF at /iiif/2/{image_id}/full/{w},/0/default.jpg. Works as documented.
//
// All three are keyless public APIs. Every function is serial-safe: the caller
// controls pacing, and every network failure is returned, never faked.

const UA = "VisualArchive-P6.3-source/1.0 (public museum data services)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, { headers = {}, tries = 4, timeoutMs = 45000 } = {}) {
  let lastErr = "";
  for (let attempt = 0; attempt <= tries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      lastErr = `transport:${String(e?.message || e).slice(0, 60)}`;
      if (attempt === tries) break;
      await sleep(2000 * Math.pow(2, attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = `http-${res.status}`;
      if (attempt === tries) break;
      await sleep(2500 * Math.pow(2, attempt));
      continue;
    }
    if (!res.ok) return { error: `http-${res.status}` };
    const text = await res.text();
    if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) return { error: "non-json" };
    try { return { data: JSON.parse(text) }; } catch (e) { return { error: "bad-json" }; }
  }
  return { error: lastErr || "exhausted" };
}

// ---------------------------------------------------------------------------
// Metropolitan Museum of Art — https://collectionapi.metmuseum.org
// ---------------------------------------------------------------------------
export const metSource = {
  id: "met",
  sourceName: "Metropolitan Museum of Art",
  homepage: "https://www.metmuseum.org",
  keyless: true,
  apiNote: "search endpoint moved to /public/collection/v1.1/search on 2026-10-01",

  async search(query, { limit = 100, offset = 0, hasImages = true, isPublicDomain = true } = {}) {
    const url = "https://collectionapi.metmuseum.org/public/collection/v1.1/search"
      + `?q=${encodeURIComponent(query)}`
      + (hasImages ? "&hasImages=true" : "")
      + (isPublicDomain ? "&isPublicDomain=true" : "")
      + `&limit=${Math.min(limit, 100)}&offset=${offset}`;
    const { data, error } = await getJSON(url);
    if (error) return { error, total: 0, objectIDs: [], records: [] };
    const ids = (data.objectIDs || []).filter((n) => Number.isInteger(n));
    const records = [];
    const failed = [];
    for (const id of ids) {
      const r = await this.fetchObject(id);
      if (r.error) failed.push({ id, error: r.error });
      else records.push(r.data);
      await sleep(140); // stay well inside the public rate limit
    }
    return { total: data.total ?? null, objectIDs: ids, records, failed };
  },

  async fetchObject(id) {
    const url = `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`;
    const { data, error } = await getJSON(url);
    if (error) return { error };
    if (!data?.primaryImage) return { error: "no-image" };
    // web-large is a sane default: full-res originals are 10–100 MB.
    const sized = (w) => `https://images.metmuseum.org/CRDImages/ep/web-large/${data.objectID}-${w}.jpg`;
    return {
      data: {
        source: this.id,
        sourceName: this.sourceName,
        sourceId: String(data.objectID),
        title: data.title || "",
        creator: data.artistDisplayName || (data.artistDisplayBioName || ""),
        year: data.objectDate || "",
        yearBegin: data.objectBeginDate ?? null,
        medium: data.medium || "",
        classification: data.classification || "",
        department: data.department || "",
        culture: data.culture || data.country || "",
        museum: this.sourceName,
        sourceUrl: data.objectURL || `https://www.metmuseum.org/art/collection/search/${data.objectID}`,
        rights: data.isPublicDomain ? "Public domain (The Met Open Access)" : "CC0 / institution rights",
        publicDomain: Boolean(data.isPublicDomain),
        image: {
          url: data.primaryImageSmall || data.primaryImage,
          tiers: {
            thumb: data.primaryImageSmall || data.primaryImage,
            preview: data.primaryImageSmall || data.primaryImage,
            detail: data.primaryImage,
          },
        },
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Art Institute of Chicago — https://api.artic.edu
// ---------------------------------------------------------------------------
export const aicSource = {
  id: "aic",
  sourceName: "Art Institute of Chicago",
  homepage: "https://www.artic.edu",
  keyless: true,
  apiNote: "https://api.artic.edu/api/v1/artworks/search — Elastic-backed, supports limit/offset",

  async search(query, { limit = 100, offset = 0, publicDomainOnly = true } = {}) {
    const fields = "id,title,image_id,artist_title,artist_display,date_display,place_of_origin,"
      + "medium_display,is_public_domain,department_title,classification_title,thumbnail,api_link,is_on_view";
    const url = "https://api.artic.edu/api/v1/artworks/search"
      + `?q=${encodeURIComponent(query)}&limit=${Math.min(limit, 100)}&offset=${offset}&fields=${fields}`;
    const { data, error } = await getJSON(url);
    if (error) return { error, total: 0, records: [] };
    let items = data.data || [];
    if (publicDomainOnly) items = items.filter((i) => i.is_public_domain);
    const records = items
      .filter((i) => i.image_id)
      .map((i) => {
        const base = `https://www.artic.edu/iiif/2/${i.image_id}`;
        const tier = (w) => `${base}/full/${w},/0/default.jpg`;
        return {
          source: this.id,
          sourceName: this.sourceName,
          sourceId: String(i.id),
          title: i.title || "",
          creator: i.artist_title || (i.artist_display || "").split("(")[0].trim(),
          year: i.date_display || "",
          medium: i.medium_display || "",
          classification: i.classification_title || "",
          department: i.department_title || "",
          culture: i.place_of_origin || "",
          museum: this.sourceName,
          sourceUrl: i.api_link || `https://www.artic.edu/artworks/${i.id}`,
          rights: i.is_public_domain ? "Public domain (AIC Open Access)" : "AIC image data terms",
          publicDomain: Boolean(i.is_public_domain),
          image: { url: tier(843), tiers: { thumb: tier(480), preview: tier(843), detail: tier(1920) } },
        };
      });
    return { total: data.pagination?.total ?? null, records, failed: [] };
  },
};

// ---------------------------------------------------------------------------
// Rijksmuseum — https://data.rijksmuseum.nl (Linked Art / EDM)
// ---------------------------------------------------------------------------
function pickLangPrefLabel(node) {
  if (!node) return "";
  const labels = node["http://www.w3.org/2004/02/skos/core#prefLabel"] || node.label || [];
  const arr = Array.isArray(labels) ? labels : [labels];
  return (arr.find((l) => l?.["@language"] === "en") || arr[0])?.["@value"] || "";
}
function pickTitle(cho) {
  const t = cho?.title;
  if (!t) return "";
  if (typeof t === "string") return t;
  if (t.en?.length) return t.en[0];
  const first = Object.values(t)[0];
  return Array.isArray(first) ? first[0] : (first || "");
}
function pickYear(cho) {
  const c = cho?.created;
  if (Array.isArray(c)) {
    return (c.find((l) => l?.["@language"] === "en") || c[0])?.["@value"] || "";
  }
  return typeof c === "string" ? c : "";
}

export const rijksSource = {
  id: "rijks",
  sourceName: "Rijksmuseum",
  homepage: "https://www.rijksmuseum.nl",
  keyless: true,
  apiNote: "data.rijksmuseum.nl Linked Art search + edm-framed resolver; real IIIF url is aggregatedCHO-free top-level isShownBy.id",

  // Walk pages of the Linked Art OrderedCollection. Yields raw ids lazily so a
  // 1000-asset run can stop early without fetching 10x more ids than needed.
  // MEASURED PARAM NAMES (work/p6.3.1c/diagnose-rijks.mjs):
  //   subject=Rembrandt -> HTTP 400 (rejected outright)
  //   q= / keyword= / text=              -> HTTP 400
  //   description=landscape              -> 200, total 347
  //   title=landscape                    -> 200, total 1083
  //   creator=Rembrandt                  -> 200, total 1447   (known good)
  // So subject search MUST go through description=/title=. Passing subject= made
  // this source look dead (0 results for every subject) when it is fully capable.
  async *iterateIds({ query = null, creator = null, subject = null, title = null, maxPages = 40, pageSize = 100 } = {}) {
    const params = new URLSearchParams({ imageAvailable: "true" });
    if (query) { params.set("description", query); }
    if (creator) { params.set("creator", creator); }
    if (title) { params.set("title", title); }
    if (subject) { params.set("description", subject); }
    let url = `https://data.rijksmuseum.nl/search/collection?${params}`;
    for (let page = 0; page < maxPages && url; page++) {
      const { data, error } = await getJSON(url);
      if (error) return { error, yielded: page * pageSize };
      const items = data.orderedItems || [];
      for (const it of items) if (it?.id) yield it.id;
      const next = typeof data.next === "string" ? data.next : data.next?.id;
      url = next || null;
      await sleep(150);
    }
  },

  async fetchObject(linkedId) {
    const num = String(linkedId).split("/").pop();
    const { data, error } = await getJSON(
      `https://data.rijksmuseum.nl/${num}?_profile=edm-framed`,
      { headers: { accept: "application/ld+json" } },
    );
    if (error) return { error };
    const cho = data.aggregatedCHO || {};
    // MEASURED: isShownBy is TOP-LEVEL on the edm-framed document, and its id is
    // a complete working IIIF url. The older adapter's constructed
    // iiif.micr.io/<objectNumber>/... form 404s against the live service.
    const shownBy = data.isShownBy?.id || data.isShownBy?.[0]?.id || null;
    if (!shownBy) return { error: "no-image" };
    const sized = (w) => shownBy.replace("/full/max/", `/full/${w},/`);
    const creators = Array.isArray(cho.creator) ? cho.creator : cho.creator ? [cho.creator] : [];
    const license = JSON.stringify(data).match(/creativecommons\.org\/(licenses|publicdomain)\/[a-z0-9./-]+/i)?.[0] || "";
    const objectNumber = (Array.isArray(cho.identifier) ? cho.identifier[0] : cho.identifier) || num;
    const subjects = (Array.isArray(cho.subject) ? cho.subject : cho.subject ? [cho.subject] : [])
      .map((s) => pickLangPrefLabel(s)).filter(Boolean).slice(0, 6);
    return {
      data: {
        source: this.id,
        sourceName: this.sourceName,
        sourceId: num,
        title: pickTitle(cho),
        creator: creators.length ? pickLangPrefLabel(creators[0]) : "",
        year: pickYear(cho),
        medium: cho.dcType ? pickLangPrefLabel(Array.isArray(cho.dcType) ? cho.dcType[0] : cho.dcType) : "",
        culture: "Netherlands",
        museum: this.sourceName,
        subjects,
        sourceUrl: `https://www.rijksmuseum.nl/nl/collectie/object/${encodeURIComponent(objectNumber)}`,
        rights: license ? `${license} (Rijksmuseum)` : "Rijksmuseum data services (public domain)",
        publicDomain: /publicdomain|public-domain/i.test(license) || !license,
        image: { url: sized(960), tiers: { thumb: sized(480), preview: sized(960), detail: sized(1920) } },
      },
    };
  },
};

export const SOURCES = { met: metSource, aic: aicSource, rijks: rijksSource };

// ---------------------------------------------------------------------------
// Uniform fetcher: download the real bytes for a record and verify them.
// A record is only "usable" when the file is a real raster image on disk with a
// recomputed sha256. No URL-only entries, no metadata-only entries.
// ---------------------------------------------------------------------------
export async function materializeRecord(record, destPath) {
  const url = record?.image?.tiers?.preview || record?.image?.url;
  if (!url) return { ok: false, reason: "no-image-url" };
  const { writeFile, mkdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const { createHash } = await import("node:crypto");
  let buf;
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) });
      if (res.status === 429 || res.status >= 500) { lastErr = `http-${res.status}`; await sleep(2500 * Math.pow(2, attempt)); continue; }
      if (!res.ok) return { ok: false, reason: `http-${res.status}` };
      buf = Buffer.from(await res.arrayBuffer());
      break;
    } catch (e) {
      lastErr = `transport:${String(e?.message || e).slice(0, 40)}`;
      await sleep(2000 * Math.pow(2, attempt));
    }
  }
  if (!buf) return { ok: false, reason: lastErr || "download-failed" };
  const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isJpeg && !isPng) return { ok: false, reason: `not-an-image(${buf.subarray(0, 24).toString("utf8").replace(/\s+/g, " ").slice(0, 24)})` };
  if (buf.length < 8000) return { ok: false, reason: `too-small(${buf.length}B)` };
  await mkdir(path.dirname(destPath), { recursive: true });
  await writeFile(destPath, buf);
  return {
    ok: true,
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
    mime: isJpeg ? "image/jpeg" : "image/png",
  };
}
