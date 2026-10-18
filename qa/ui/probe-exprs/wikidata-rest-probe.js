(async () => {
  const out = {};
  const t = async (name, url) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url);
      const txt = await r.text();
      let brief = txt.slice(0, 160).replace(/\s+/g, " ");
      try {
        const j = JSON.parse(txt);
        if (Array.isArray(j.items)) brief = j.items.slice(0, 3).map((i) => `${i.id}:${i.label}`).join(" | ");
        else if (Array.isArray(j.search)) brief = j.search.slice(0, 3).map((i) => `${i.id}:${i.label}`).join(" | ");
      } catch {
        /* 非 JSON 就截断显示 */
      }
      out[name] = { http: r.status, ms: Date.now() - t0, brief };
    } catch (e) {
      out[name] = { error: String(e.message || e).slice(0, 60), ms: Date.now() - t0 };
    }
  };
  await t("rest-v1-search", "https://www.wikidata.org/w/rest.php/wikibase/v1/search/items?q=" + encodeURIComponent("Intolerance") + "&language=en&limit=5");
  await t("rest-v1-search-kid", "https://www.wikidata.org/w/rest.php/wikibase/v1/search/items?q=" + encodeURIComponent("The Kid") + "&language=en&limit=5");
  await t("rest-v1-entity", "https://www.wikidata.org/w/rest.php/wikibase/v1/entities/items/Q192206");
  await t("rest-v0-search-old", "https://www.wikidata.org/w/rest.php/wikibase/v0/search/items?q=Intolerance&language=en&limit=3");
  return out;
})()