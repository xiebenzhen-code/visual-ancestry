(async () => {
  const out = {};
  const t0 = Date.now();
  try {
    const { findRemoteFilm } = await import("/src/services/retrieval/remoteReferences.js");
    const r = await findRemoteFilm("Intolerance", { media: "film" });
    out.ms = Date.now() - t0;
    out.resultCount = r.results?.length ?? 0;
    out.degraded = r.degraded;
    out.note = r.note;
    out.unsupported = r.unsupported;
    out.vision = r.vision;
    out.verificationTally = r.verificationTally;
    out.natureKinds = r.natureKinds;
    out.first = r.results?.[0]
      ? {
          title: r.results[0].artwork.film?.titleZh,
          director: r.results[0].artwork.film?.directorZh,
          imageKind: r.results[0].artwork.imageKind,
          imageKindLabel: r.results[0].artwork.imageKindLabel,
          thumb: r.results[0].artwork.image?.tiers?.detail?.slice(0, 90),
          axes: Object.keys(r.results[0].artwork.remote?.axes || {}),
          identityStatus: r.results[0].artwork.identity?.wikidataStatus,
        }
      : null;
  } catch (e) {
    out.ms = Date.now() - t0;
    out.error = String(e && (e.stack || e.message || e)).slice(0, 500);
  }
  // 直接测两个外部端点在浏览器里的可达性
  out.probeCommons = await (async () => {
    try {
      const r = await fetch(
        "https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&prop=imageinfo&iiprop=url&iiurlwidth=960&origin=*&titles=" +
          encodeURIComponent("File:Intolerance (1916) - 2.jpg"),
        { headers: { "User-Agent": "VisualAncestry-RemoteDiscovery/1.0 (probe)" } }
      );
      return "HTTP " + r.status;
    } catch (e) {
      return "FETCH FAILED: " + String(e.message || e).slice(0, 90);
    }
  })();
  out.probeWikidata = await (async () => {
    try {
      const r = await fetch("https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=1&search=Intolerance", {
        headers: { "User-Agent": "VisualAncestry-RemoteDiscovery/1.0 (probe)" },
      });
      return "HTTP " + r.status;
    } catch (e) {
      return "FETCH FAILED: " + String(e.message || e).slice(0, 90);
    }
  })();
  out.probeWikidataNoUA = await (async () => {
    try {
      const r = await fetch("https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=1&search=Intolerance");
      return "HTTP " + r.status;
    } catch (e) {
      return "FETCH FAILED: " + String(e.message || e).slice(0, 90);
    }
  })();
  return out;
})()