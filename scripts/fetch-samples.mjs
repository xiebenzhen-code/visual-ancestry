// Fetch sample API responses (AIC / MET / CLEV) into work/api-samples/ for adapter authoring.
import https from "node:https";
import { mkdirSync, writeFileSync } from "node:fs";

const samples = [
  ["aic-search", "https://api.artic.edu/api/v1/artworks/search?q=monet&limit=2&fields=id,title,image_id,artist_display,date_display,artist_title,place_of_origin,classification_title,department_title,medium_display,is_public_domain,thumbnail"],
  ["met-search", "https://collectionapi.metmuseum.org/public/collection/v1.1/search?q=monet&hasImages=true"],
  ["met-object", "https://collectionapi.metmuseum.org/public/collection/v1/objects/438003"],
  ["clev-search", "https://openaccess-api.clevelandart.org/api/artworks/?search=monet&limit=2"],
];

function get(url) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { rejectUnauthorized: false, headers: { "user-agent": "visual-ancestry-dev/1.0" } },
      (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => resolve({ status: r.statusCode, body: d }));
      }
    );
    req.on("error", (e) => resolve({ status: "ERR", body: e.message }));
    req.setTimeout(25000, function () {
      this.destroy();
      resolve({ status: "TIMEOUT", body: "" });
    });
  });
}

mkdirSync("work/api-samples", { recursive: true });
for (const [name, url] of samples) {
  const r = await get(url);
  const body = r.body.length > 4000 ? r.body.slice(0, 4000) + "\n...[truncated]" : r.body;
  writeFileSync(`work/api-samples/${name}.txt`, `STATUS ${r.status}\n${body}`);
  console.log(name, r.status, r.body.length);
}
console.log("SAMPLES-DONE");
