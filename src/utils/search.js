import { aliases } from "../data/aliases.js";
import { traditions } from "../data/traditions.js";
import { normalize } from "./html.js";

export function traditionById(id) {
  return traditions.find((tradition) => tradition.id === id);
}

export function traditionLabel(id) {
  const tradition = traditionById(id);
  return tradition ? `${tradition.zh} ${tradition.en}` : id;
}

export function artSearchText(artwork) {
  return [
    artwork.titleZh,
    artwork.titleEn,
    artwork.title,
    artwork.artist,
    artwork.artistZh,
    artwork.year,
    artwork.origin,
    artwork.culture,
    artwork.museum,
    (artwork.emotion || []).join(" "),
    (artwork.atmosphere || []).join(" "),
    (artwork.visualDNA || []).join(" "),
    (artwork.narrativeFunction || []).join(" "),
    (artwork.traditions || []).map(traditionLabel).join(" "),
    artwork.oneLine,
    artwork.composition,
    artwork.lighting,
    artwork.color,
    artwork.spatialStructure,
    artwork.location ? Object.values(artwork.location).filter((v) => typeof v === "string").join(" ") : "",
    (artwork.locationPattern || []).join(" "),
  ]
    .join(" ")
    .toLowerCase();
}

// Does this artwork belong to the semantic field of an alias entry?
function artworkInEntryField(artwork, entry, text) {
  if (artwork.emotion.includes(entry.primary) || artwork.atmosphere.includes(entry.primary)) return true;
  if (artwork.traditions.some((id) => traditionLabel(id).toLowerCase().includes(normalize(entry.primary)))) return true;
  if (text.includes(normalize(entry.primary))) return true;
  if (entry.related.some((term) => text.includes(normalize(term)))) return true;
  return false;
}

// A single query token hits if it appears in the raw text, or if it maps to an
// alias entry whose semantic field the artwork belongs to (e.g. 江南 -> 富春江).
function tokenHit(artwork, token, text) {
  if (text.includes(token)) return true;
  for (const entry of aliases) {
    const matchesEntry =
      normalize(entry.primary) === token ||
      entry.aliases.some((alias) => {
        const n = normalize(alias);
        return n === token || (n.length > 1 && n.includes(token)) || (token.length > 1 && token.includes(n));
      }) ||
      entry.related.some((term) => normalize(term) === token);
    if (matchesEntry && artworkInEntryField(artwork, entry, text)) return true;
  }
  return false;
}

export function aliasScore(artwork, query) {
  const q = normalize(query);
  if (!q) return 0;
  let score = 0;
  const text = artSearchText(artwork);
  const tokens = q.split(/\s+/).filter(Boolean);
  for (const entry of aliases) {
    const primaryHit = normalize(entry.primary) === q ? entry.weight * 9 : 0;
    const aliasHit = entry.aliases.some((alias) => normalize(alias) === q || normalize(alias).includes(q))
      ? entry.weight * 7
      : 0;
    const relatedHit = entry.related.some((term) => normalize(term) === q || normalize(term).includes(q))
      ? entry.weight * 4
      : 0;
    if (primaryHit || aliasHit || relatedHit) {
      // Only score when the artwork actually belongs to this entry's field.
      // (A bare related-match must not leak score onto every artwork.)
      if (artworkInEntryField(artwork, entry, text)) {
        score += primaryHit + aliasHit + relatedHit;
      }
    }
  }
  // Multi-token queries ("孤独 夜晚", "江南 空旷"): strict semantic AND —
  // every token must hit the record, otherwise the artwork is excluded.
  if (tokens.length > 1) {
    const hits = tokens.filter((token) => tokenHit(artwork, token, text)).length;
    if (hits !== tokens.length) return 0;
    score += 10 + hits * 2;
  }
  if (text.includes(q)) score += 3;
  return score;
}

export function filterArtworks(artworks, state) {
  let results = artworks.map((artwork, index) => ({ artwork, score: 1, index }));
  if (state.activeCategory && state.activeTerm) {
    results = results.filter(({ artwork }) => {
      if (state.activeCategory === "emotion") return (artwork.emotion || []).includes(state.activeTerm);
      if (state.activeCategory === "atmosphere") return (artwork.atmosphere || []).includes(state.activeTerm);
      if (state.activeCategory === "tradition") return (artwork.traditions || []).includes(state.activeTerm);
      return true;
    });
  }
  if (state.query) {
    results = results
      .map((item) => ({ ...item, score: item.score + aliasScore(item.artwork, state.query) }))
      .filter((item) => item.score > 1 || artSearchText(item.artwork).includes(normalize(state.query)));
  }
  return results.sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.artwork);
}
