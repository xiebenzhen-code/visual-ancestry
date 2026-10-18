// Artwork data aggregator. All records are normalized by defineArtwork().
import { defineArtwork, assembleFullPrompt } from "./artworks/builder.js";
import { westernSeeds } from "./artworks/western.js";
import { chineseSeeds } from "./artworks/chinese.js";
import { japaneseSeeds } from "./artworks/japanese.js";
import { otherSeeds } from "./artworks/other.js";

export { assembleFullPrompt };

export const artworks = [...westernSeeds, ...chineseSeeds, ...japaneseSeeds, ...otherSeeds].map(
  defineArtwork
);

export function findArtwork(id) {
  return artworks.find((artwork) => artwork.id === id) || null;
}
