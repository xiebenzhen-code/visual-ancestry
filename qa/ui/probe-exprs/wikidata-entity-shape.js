(async () => {
  const r = await fetch("https://www.wikidata.org/w/rest.php/wikibase/v1/entities/items/Q192206");
  const j = await r.json();
  const st = j.statements || {};
  const full = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return "(absent)";
    const s = arr[0];
    const copy = { ...s, references: undefined };
    return JSON.stringify(copy);
  };
  return { P57: full(st.P57), P577: full(st.P577), P345: full(st.P345) };
})()