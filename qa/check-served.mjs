// Fetch the feedTile.js the live server is actually serving.
const r = await fetch("http://127.0.0.1:4175/src/components/feedTile.js");
const text = await r.text();
const fs = await import("node:fs");
fs.writeFileSync(
  "C:<local-path>",
  `STATUS ${r.status}\nLEN ${text.length}\nHAS_DATA_HREF ${text.includes("data-href")}\nHAS_BUTTON ${text.includes("<button type=\"button\" data-tile-action")}\nSNIP ${text.slice(text.indexOf("tile-actions") - 40, text.indexOf("tile-actions") + 220)}`
);
console.log("DONE");