// filmService — single access point for film reference data.
// Future provider: TMDB (film metadata / stills). Keep method signatures
// stable so the swap does not touch pages.

import { filmReferences, referencesForArtwork, referencesWithLocation } from "../data/filmReferences.js";

const localProvider = {
  async listReferences() {
    return filmReferences;
  },
  async referencesForArtwork(artworkId) {
    return referencesForArtwork(artworkId);
  },
  async referencesWithLocation() {
    return referencesWithLocation();
  },
};

const provider = localProvider;

export function listReferences() {
  return provider.listReferences();
}

export function getReferencesForArtwork(artworkId) {
  return provider.referencesForArtwork(artworkId);
}

export function getReferencesWithLocation() {
  return provider.referencesWithLocation();
}

// Sync convenience accessors.
export function listReferencesSync() {
  return filmReferences;
}

export function getReferencesForArtworkSync(artworkId) {
  return referencesForArtwork(artworkId);
}
