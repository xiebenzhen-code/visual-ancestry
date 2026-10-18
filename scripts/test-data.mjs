// Data integrity + search sanity checks.
import { artworks, findArtwork } from "../src/data/artworks.js";
import { filterArtworks } from "../src/utils/search.js";
import { filmReferences, referencesForArtwork } from "../src/data/filmReferences.js";

const state = (query) => ({ query, activeCategory: null, activeTerm: null });

console.log(`artworks: ${artworks.length}`);
console.log(`with image: ${artworks.filter((a) => a.image).length}`);
console.log(`film references: ${filmReferences.length}`);
console.log(`with location: ${filmReferences.filter((f) => f.location).length}`);

const counts = {};
for (const a of artworks) for (const t of a.traditions) counts[t] = (counts[t] || 0) + 1;
console.log("\ntradition coverage:", counts);

const queries = ["水墨", "山水", "留白", "ink", "landscape", "孤独 夜晚", "江南 空旷", "浮世绘", "ukiyo-e", "新版画", "巴洛克", "baroque", "night", "solitude", "青绿", "工笔", "波斯细密画"];
console.log("\nsearch results:");
for (const q of queries) {
  const r = filterArtworks(artworks, state(q));
  console.log(`  "${q}" -> ${r.length} hits${r.length ? " | top: " + r[0].titleZh : ""}`);
}

// schema spot check
const sample = findArtwork("fuchun-mountains");
console.log("\nfuchun-mountains schema check:");
console.log("  visualDNA is array:", Array.isArray(sample.visualDNA));
console.log("  cinematic keys:", Object.keys(sample.creatorTranslation.cinematic).join(","));
console.log("  aigc keys:", Object.keys(sample.creatorTranslation.aigc).join(","));
console.log("  shoot subjectType:", sample.shootTranslation.subjectType);
console.log("  location:", JSON.stringify(sample.location?.placeName));
console.log("  locationPattern count:", sample.locationPattern?.length);
console.log("  film refs:", referencesForArtwork("fuchun-mountains").map((f) => `${f.filmTitleZh}(${f.relationType})`).join(" / "));
