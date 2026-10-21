// discoveryClient.js — 浏览器侧访问自动发现服务的唯一入口。
//
// 全部走后端同源接口：浏览器不直连外部 API，也拿不到任何 Token。
// 后端不可用时静默降级（返回 null），页面继续用本地候选。

const JSON_HEADERS = { "Content-Type": "application/json" };

async function post(path, body) {
  try {
    const res = await fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 某件作品的"外部候选"，已按四条分支归好类。 */
export async function fetchExternalNeighbors(artworkId) {
  return post("/api/discovery/neighbors", { artworkId });
}

/** 主动补货（一般由页面在候选不足时自动调用，用户不必点）。 */
export async function requestHarvest(query, limit = 24) {
  return post("/api/discovery/harvest", { query, limit });
}

export async function fetchDiscoveryStatus() {
  try {
    const res = await fetch("/api/discovery/status", { headers: { accept: "application/json" } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** 首页用的外部发现图（按主题，服务端从缓存里挑）。 */
export async function fetchDiscoveryWall(topic, limit = 8) {
  try {
    const res = await fetch(`/api/discovery/wall?topic=${encodeURIComponent(topic)}&limit=${limit}`, { headers: { accept: "application/json" } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
