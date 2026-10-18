// AIC IIIF 403 diagnosis: UA-sensitive?
import https from "node:https";

const url = "https://www.artic.edu/iiif/2/9ea39501-a7c9-efb7-9fe8-ef58e2f18967/full/960,/0/default.jpg";
function probe(ua, referer) {
  return new Promise((resolve) => {
    const headers = { "user-agent": ua, accept: "image/*,*/*" };
    if (referer) headers.referer = referer;
    const req = https.get(url, { rejectUnauthorized: false, headers }, (r) => {
      let n = 0;
      r.on("data", (c) => (n += c.length));
      r.on("end", () => resolve({ status: r.statusCode, ct: r.headers["content-type"], bytes: n }));
    });
    req.on("error", (e) => resolve({ status: "ERR", error: e.message }));
    req.setTimeout(20000, function () { this.destroy(); resolve({ status: "TIMEOUT" }); });
  });
}

const uas = [
  ["node-default", "node"],
  ["chrome", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"],
  ["chrome+ref", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"],
];
for (const [name, ua] of uas) {
  const r = await probe(ua, name === "chrome+ref" ? "https://www.artic.edu/" : null);
  console.log(name, JSON.stringify(r));
}