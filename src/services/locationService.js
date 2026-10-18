// locationService — single access point for real-world location data.
// This phase is static-data only by design: no Maps / Places API yet.
// Future provider: Maps / Places. The schema (country / region / city /
// placeName / coordinates / locationType / verified / source) is already
// compatible with a Places lookup.

import { artworks } from "../data/artworks.js";
import { filmReferences } from "../data/filmReferences.js";

export function getArtworkLocation(artworkId) {
  const artwork = artworks.find((item) => item.id === artworkId);
  return artwork ? artwork.location : null;
}

export function listArtworkLocations() {
  return artworks
    .filter((artwork) => artwork.location)
    .map((artwork) => ({ artworkId: artwork.id, titleZh: artwork.titleZh, location: artwork.location }));
}

export function listFilmLocations() {
  return filmReferences
    .filter((reference) => reference.location)
    .map((reference) => ({
      filmTitle: reference.filmTitle,
      filmTitleZh: reference.filmTitleZh,
      artworkId: reference.artworkId,
      location: reference.location,
      locationPattern: reference.locationPattern,
    }));
}

// Display helper: an unverified or missing location must never be presented
// as a confirmed shooting spot.
export function locationLabel(location) {
  if (!location) return "未确认具体拍摄点";
  if (!location.verified) return "未确认具体拍摄点";
  const parts = [location.region, location.city, location.placeName].filter(Boolean);
  return parts.length ? parts.join(" · ") : "未确认具体拍摄点";
}
