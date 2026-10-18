export function externalArtworkImage(fileName, width = 1800) {
  return {
    type: "external",
    fileName,
    width,
    url: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(fileName)}?width=${width}`,
  };
}

export function artworkImageUrl(artwork) {
  return typeof artwork.image === "string" ? artwork.image : artwork.image.url;
}