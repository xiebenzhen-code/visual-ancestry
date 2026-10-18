// Inspect Rijks EDM-framed aggregatedCHO field names.
import https from "node:https";

function get(url, accept) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { rejectUnauthorized: false, headers: { "user-agent": "visual-ancestry-dev/1.0", accept } },
      (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => resolve({ status: r.statusCode, body: d }));
      }
    );
    req.on("error", (e) => resolve({ status: "SOCKERR", body: e.message }));
    req.setTimeout(25000, function () { this.destroy(); resolve({ status: "TIMEOUT", body: "" }); });
  });
}

const r = await get("https://data.rijksmuseum.nl/200108369?_profile=edm-framed", "application/ld+json");
const j = JSON.parse(r.body);
const cho = j.aggregatedCHO || {};
console.log("CHO KEYS:", Object.keys(cho).join(", "));
for (const k of Object.keys(cho)) {
  const v = cho[k];
  const s = JSON.stringify(v);
  if (s.length < 120) console.log(`  ${k} = ${s}`);
  else console.log(`  ${k} = ${s.slice(0, 150)}...`);
}
