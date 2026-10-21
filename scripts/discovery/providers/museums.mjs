// providers/museums.mjs — 四馆适配器 + Openverse 复用既有实现，只做「原始 → 统一记录」映射。
//
// 不重写请求逻辑：AIC/Met/Cleveland/Rijks 的接口细节（v1.1、has_image、typed params）
// 已经在 src/services/adapters 里修过，这里直接调用，避免出现第二份实现。

import { pathToFileURL } from "node:url";
import path from "node:path";
import { normalize, IMAGE_KINDS } from "../normalize.mjs";

const ROOT = process.cwd();
const imp = (r) => import(pathToFileURL(path.join(ROOT, r)).href);

async function museumAdapters() {
  const { aicAdapter } = await imp("src/services/adapters/aicAdapter.js");
  const { metAdapter } = await imp("src/services/adapters/metAdapter.js");
  const { clevelandAdapter } = await imp("src/services/adapters/clevelandAdapter.js");
  const { rijksAdapter } = await imp("src/services/adapters/rijksAdapter.js");
  return [aicAdapter, metAdapter, clevelandAdapter, rijksAdapter];
}

function fromMuseum(raw, query) {
  return normalize(
    {
      providerId: raw.sourceId,
      title: raw.title,
      creator: raw.artist,
      year: raw.year,
      medium: raw.medium,
      imageKind: IMAGE_KINDS.ARTWORK,
      imageUrl: raw.image?.url || raw.image?.tiers?.detail,
      thumbnailUrl: raw.image?.tiers?.preview || raw.image?.tiers?.thumb || raw.image?.url,
      sourceUrl: raw.sourceUrl,
      rightsStatus: raw.rights,
      license: raw.rights,
      width: raw.image?.ratio ? null : null, // 馆方只给比例，不给像素宽高；下面用实际下载的尺寸回填
      height: null,
      origin: raw.museum,
      provider: raw.source,
    },
    { provider: raw.source, query },
  );
}

export const museumsProvider = {
  id: "museums",
  label: "博物馆（AIC / Met / Cleveland / Rijks）",
  capabilities: ["artwork"],
  credentialRequired: false,
  async search(query, { limit = 24, only = null } = {}) {
    const adapters = (await museumAdapters()).filter((a) => !only || only.includes(a.source));
    const results = [];
    for (const adapter of adapters) {
      const started = Date.now();
      try {
        const items = await adapter.search(query, { limit });
        const records = items.map((r) => fromMuseum(r, query)).filter(Boolean);
        results.push({ provider: adapter.source, status: 200, returned: items.length, records, latencyMs: Date.now() - started });
      } catch (e) {
        results.push({ provider: adapter.source, status: Number((String(e.message).match(/\b(\d{3})\b/) || [])[1]) || 0, returned: 0, records: [], latencyMs: Date.now() - started, error: String(e.message).slice(0, 140) });
      }
    }
    return results;
  },
};
