// Inspect Cleveland artwork images + artist fields (full response, print images only).
import https from "node:https";

function get(url) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { rejectUnauthorized: false, headers: { "user-agent": "visual-ancestry-dev/1.0" } },
      (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => resolve(d));
      }
    );
    req.on("error", () => resolve("ERR"));
    req.setTimeout(25000, function () {
      this.destroy();
      resolve("TIMEOUT");
    });
  });
}

const raw = await get(
  "https://openaccess-api.clevelandart.org/api/artworks/?search=monet&limit=1&select=id,title,images,artists,creation_date,url,share_license_status"
);
const json = JSON.parse(raw);
const item = json.data[0];
console.log("ID", item.id);
console.log("TITLE", item.title);
console.log("CREATION", item.creation_date);
console.log("ARTISTS", JSON.stringify(item.artists));
console.log("IMAGES-KEYS", item.images && Object.keys(item.images));
console.log("WEB", JSON.stringify(item.images && item.images.web).slice(0, 300));
console.log("PRINT", JSON.stringify(item.images && item.images.print).slice(0, 300));
console.log("FULL", JSON.stringify(item.images && item.images.full).slice(0, 300));
console.log("URL", item.url);
console.log("LICENSE", item.share_license_status);