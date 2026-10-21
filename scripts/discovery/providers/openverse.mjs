// providers/openverse.mjs — 复用已修好的 Openverse 适配器（page_size=20 + 翻页）。
import { pathToFileURL } from "node:url";
import path from "node:path";
import { normalize, IMAGE_KINDS } from "../normalize.mjs";

const ROOT = process.cwd();

export const openverseProvider = {
  id: "openverse",
  label: "Openverse",
  capabilities: ["photograph", "artwork"],
  credentialRequired: false,

  async search(query, { limit = 20 } = {}) {
    const started = Date.now();
    try {
      const { openverseAdapter } = await import(pathToFileURL(path.join(ROOT, "src/services/adapters/openverseAdapter.js")).href);
      const items = await openverseAdapter.search(query, { limit });
      const records = items.map((r) => normalize({
        providerId: r.sourceId,
        title: r.title,
        creator: r.artist,
        year: r.year,
        medium: null,
        imageKind: IMAGE_KINDS.PHOTOGRAPH,
        imageUrl: r.image?.url,
        thumbnailUrl: r.image?.tiers?.thumb || r.image?.url,
        sourceUrl: r.sourceUrl,
        rightsStatus: r.rights,
        license: r.rights,
        width: null,   // Openverse 不保证给像素宽高；由 validate-image 读真实字节回填
        height: null,
        origin: r.museum,
      }, { provider: "openverse", query })).filter(Boolean);
      return [{ provider: "openverse", status: 200, returned: records.length, records, latencyMs: Date.now() - started }];
    } catch (e) {
      return [{ provider: "openverse", status: Number((String(e.message).match(/\b(\d{3})\b/) || [])[1]) || 0, returned: 0, records: [], latencyMs: Date.now() - started, error: String(e.message).slice(0, 140) }];
    }
  },
};
