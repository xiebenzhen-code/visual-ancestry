import { referencesForArtwork, RELATION_TYPES } from "../../data/filmReferences.js";

const CLASS = {
  DOCUMENTED_REFERENCE: "明确引用",
  DIRECT_RECREATION: "明确引用",
  COMPOSITIONAL_PARALLEL: "视觉平行",
  LIGHTING_PARALLEL: "视觉平行",
  COLOR_PARALLEL: "视觉平行",
  SPATIAL_PARALLEL: "视觉平行",
  THEMATIC_PARALLEL: "解释性关联",
};

export function cinemaRelations(artwork) {
  if (!artwork?.id) return [];
  return referencesForArtwork(artwork.id).map((ref) => ({
    ...ref,
    relationClass: CLASS[ref.relationType] || "解释性关联",
    valid: RELATION_TYPES.includes(ref.relationType),
  }));
}
