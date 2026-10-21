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

/** 以远端作品为起点继续探索（同一个接口，只是换成 hash）。 */
export async function fetchExternalNeighborsByHash(hash) {
  return post("/api/discovery/neighbors", { hash });
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

/** 远端作品的详情（同一个作品页复用，不另建第二套详情）。 */
export async function fetchDiscoveryWork(hash) {
  try {
    const res = await fetch(`/api/discovery/work/${encodeURIComponent(hash)}`, { headers: { accept: "application/json" } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** 后台补货任务的进度。 */
export async function fetchDiscoveryJob(id) {
  try {
    const res = await fetch(`/api/discovery/job/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
    return res.ok ? (await res.json()).job : null;
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
