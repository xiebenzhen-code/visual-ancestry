// Verifies every artwork image URL; for failures, queries the Commons API for suggestions.
// Usage: node scripts/verify-images.mjs
import { artworks } from "../src/data/artworks.js";

const CONCURRENCY = 6;
const TIMEOUT_MS = 15000;

async function head(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    return res.status;
  } catch (err) {
    return `ERR:${err.name}`;
  } finally {
    clearTimeout(timer);
  }
}

async function commonsSearch(query) {
  const api = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
    query + " filetype:bitmap"
  )}&srnamespace=6&srlimit=5&format=json&origin=*`;
  try {
    const res = await fetch(api);
    const json = await res.json();
    return (json.query?.search || []).map((hit) => hit.title.replace(/^File:/, ""));
  } catch {
    return [];
  }
}

const withImages = artworks.filter((a) => a.image && a.image.url);
console.log(`Checking ${withImages.length} image URLs across ${artworks.length} artworks...\n`);

const failures = [];
let cursor = 0;
async function worker() {
  while (cursor < withImages.length) {
    const artwork = withImages[cursor++];
    const status = await head(artwork.image.url);
    const ok = status === 200;
    console.log(`${ok ? "OK  " : "FAIL"} [${status}] ${artwork.id} -> ${artwork.image.fileName || artwork.image.url}`);
    if (!ok) failures.push(artwork);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

if (failures.length) {
  console.log(`\n${failures.length} failures. Commons API suggestions:`);
  for (const artwork of failures) {
    const query = artwork.imageSearch || `${artwork.artist} ${artwork.titleEn}`;
    const suggestions = await commonsSearch(query);
    console.log(`\n# ${artwork.id} (${query})`);
    for (const s of suggestions) console.log(`  - ${s}`);
  }
} else {
  console.log("\nAll image URLs verified.");
}
