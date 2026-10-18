(async () => {
  const out = {};
  const tryUrl = async (name, url, init) => {
    try {
      const r = await fetch(url, init);
      const txt = await r.text();
      out[name] = { http: r.status, head: txt.slice(0, 120).replace(/\s+/g, " ") };
    } catch (e) {
      out[name] = { error: String(e.message || e).slice(0, 80) };
    }
  };
  const sparql = `SELECT ?film ?filmLabel ?director ?directorLabel WHERE {
    ?film rdfs:label "Intolerance"@en .
    ?film wdt:P31/wdt:P279* wd:Q11424 .
    OPTIONAL { ?film wdt:P57 ?director }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  } LIMIT 5`;
  await tryUrl("sparql", "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql), {
    headers: { Accept: "application/sparql-results+json" },
  });
  await tryUrl("sparql-noAccept", "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql));
  await tryUrl("rest-search", "https://www.wikidata.org/w/rest.php/wikibase/v0/search/items?q=Intolerance&language=en&limit=3");
  await tryUrl("rest-entity", "https://www.wikidata.org/w/rest.php/wikibase/v1/entities/items/Q192206");
  await tryUrl("commons-api", "https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&prop=imageinfo&iiprop=url&titles=" + encodeURIComponent("File:Intolerance (1916) - 2.jpg") + "&origin=*");
  // 预检行为（不带 UA，但带自定义头）——看预检是否放行
  try {
    const r = await fetch("https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&ids=Q192206", {
      headers: { "X-Test": "1" },
    });
    out.preflightTest = "HTTP " + r.status;
  } catch (e) {
    out.preflightTest = "FETCH FAILED: " + String(e.message || e).slice(0, 60);
  }
  return out;
})()