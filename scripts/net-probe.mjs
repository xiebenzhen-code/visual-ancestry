import https from "node:https";

const urls = [
  ["WIKI", "https://commons.wikimedia.org/wiki/Special:FilePath/Great%20Wave%20off%20Kanagawa2.jpg?width=200"],
  ["AIC", "https://api.artic.edu/api/v1/artworks/search?q=monet&limit=2&fields=id,title,image_id"],
  ["MET", "https://collectionapi.metmuseum.org/public/collection/v1/search?q=monet&hasImages=true"],
  ["CLEV", "https://openaccess-api.clevelandart.org/api/artworks/?search=monet&limit=2"],
  ["RIJK", "https://www.rijksmuseum.nl/api/en/collection?key=__bad__&q=monet&ps=2"],
];

let i = 0;
function next() {
  if (i >= urls.length) return;
  const [name, u] = urls[i++];
  const req = https.get(
    u,
    { rejectUnauthorized: false, headers: { "user-agent": "visual-ancestry-dev" } },
    (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => {
        console.log(name, r.statusCode, d.slice(0, 130).replace(/\n/g, " "));
        next();
      });
    }
  );
  req.on("error", (e) => {
    console.log(name, "SOCKERR", e.message);
    next();
  });
  req.setTimeout(20000, () => {
    console.log(name, "TIMEOUT");
    req.destroy();
    next();
  });
}
next();