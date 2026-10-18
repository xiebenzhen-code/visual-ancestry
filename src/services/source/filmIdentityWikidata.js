// filmIdentityWikidata.js — 用 Wikidata 核实电影身份与导演（浏览器可达实现）。
//
// 为什么需要它：Commons 的 imageinfo **没有导演字段**（实测确认），所以
// discoverCommonsFilmStills 一直只能把导演留空。留空是诚实的，但「电影身份」
// 这一条核验轴因此永远是 partial/unverified。
//
// 为什么是 REST v1 而不是 wbsearchentities：
//   MEASURED（浏览器实测，三条路都试过）
//     · www.wikimedia.org…/w/api.php（action=wbsearchentities）→ **浏览器不可达**
//       （带不带自定义头都是 TypeError: Failed to fetch；Commons 同一个域却正常）
//     · query.wikidata.org/sparql → 浏览器可达，但实测单次 1–50 秒不等、频繁 429，
//       放进页面链路等于让用户等几十秒（不可接受）
//     · www.wikidata.org/w/rest.php/wikibase/v1/{search/items,entities/items} →
//       浏览器可达且快（实测 search 1.5s、entity 0.37s）→ 采用
//
// 边界（与既有代码同一条线）：
//   · 只做**身份核实**，不做图像分析。导演/年份是事实字段，只能来自数据源的
//     具名陈述，绝不由模型推断、绝不由此处「修正」。
//   · 匹不中就如实返回 unverified + 原因，绝不返回「大概是某某导演」。
//   · 「没查成」（限流/网络）与「查无此片」必须分开报告。
//   · 预算受限：调用方给共享预算对象，用尽即停并标记 budget-exhausted。
//   · 结果只进运行时缓存（sessionStorage），不写任何源码文件。

const WD_REST = "https://www.wikidata.org/w/rest.php/wikibase/v1";
const UA = "VisualAncestry-RemoteDiscovery/1.0 (film identity via Wikidata REST)";
const IS_BROWSER = typeof window !== "undefined" && typeof window.document !== "undefined";
const CACHE_PREFIX = "va-film-identity-v1";
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

// 浏览器里不能设置 User-Agent（forbidden header，显式设置会让跨域请求发预检，
// 而对方不放行 user-agent）。只在 Node 侧带 UA。
const requestHeaders = () => (IS_BROWSER ? {} : { "User-Agent": UA });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (v) => String(v || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

function cacheRead(key) {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const hit = JSON.parse(raw);
    if (!hit || Date.now() - hit.at > CACHE_TTL) return null;
    return hit.value;
  } catch {
    return null;
  }
}

function cacheWrite(key, value) {
  try {
    sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), value }));
  } catch {
    /* 隐私模式 / 配额用尽：只是没有缓存，不影响结果 */
  }
}

async function getJSON(url, { timeoutMs = 9000, tries = 1 } = {}) {
  const backoff = [900, 2400];
  for (let attempt = 0; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: requestHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || !res.ok) {
        if (attempt < backoff.length && attempt < tries + 1) {
          await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
          if (attempt >= tries) break;
          continue;
        }
        return { __status: res.status };
      }
      return await res.json();
    } catch {
      if (attempt < tries) {
        await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
        continue;
      }
      return null;
    }
  }
  return null;
}

// REST v1 的 statement 取值形状：{ property:{id}, value:{type:"value", content} }
// content 可能是 "Q51123" / "tt0006864" / {time:"+1916-01-01T00:00:00Z"}。
const statementContent = (statements, prop) => {
  const arr = statements && statements[prop];
  if (!Array.isArray(arr) || !arr.length) return null;
  const content = arr[0]?.value?.content;
  if (content == null) return null;
  return typeof content === "string" ? content : content;
};

const yearOf = (content) => {
  const time = typeof content === "string" ? content : content?.time || "";
  const m = String(time).match(/^[+-]?(\d{4})/);
  return m ? m[1] : null;
};

// 候选必须是影片，而不是同名专辑 / 电视剧集 / 运动员（「The Kid」会先搜到
// 一个篮球运动员）。用数据源自己的 description 做类型与年份的交叉核对。
const screensAsFilm = (description, year) => {
  const desc = clean(description);
  if (!desc) return { ok: false, why: "Wikidata 条目没有描述" };
  if (!/\b(film|movie|silent film)\b/i.test(desc)) return { ok: false, why: `描述「${desc}」未声明是影片` };
  if (year && !desc.includes(String(year))) return { ok: false, why: `描述「${desc}」与年份 ${year} 不符` };
  return { ok: true, why: desc };
};

// MEASURED（踩过）：entities/items 的 labels 是**扁平字符串表** {"en":"D. W. Griffith"}，
// 而 search/items 的 display-label 是对象 {"language":"en","value":"..."}。
// 两者形状不同，统一按字符串读，必要时再退回对象形状。
const labelOf = (labels, lang = "en") => {
  const v = labels && labels[lang];
  if (typeof v === "string") return v;
  if (v && typeof v.value === "string") return v.value;
  return null;
};

export async function resolveFilmIdentity({ title, year = null, budget = null } = {}) {
  const name = clean(title);
  const now = new Date().toISOString();
  if (!name) {
    return { status: "unverified", reason: "Commons 未提供可用的片名，无法核实身份", checkedAt: now };
  }
  if (budget && budget.remaining <= 0) {
    return {
      status: "budget-exhausted",
      reason: "本次查询的身份核实预算已用尽，未再请求 Wikidata",
      checkedAt: now,
    };
  }

  const key = `${name}|${year || ""}`;
  const cached = cacheRead(key);
  if (cached) return { ...cached, fromCache: true };
  if (budget) budget.remaining -= 1;

  const searchUrl = `${WD_REST}/search/items?${new URLSearchParams({
    q: name,
    language: "en",
    limit: "8",
  })}`;
  const search = await getJSON(searchUrl);

  if (!search || search.__status) {
    return {
      status: "unverified",
      transportFailed: true,
      reason: `Wikidata 核实请求失败（${search?.__status ? `HTTP ${search.__status}` : "未取得响应"}），「${name}」的身份与导演仍未核实`,
      checkedAt: now,
    };
  }

  const results = Array.isArray(search.results) ? search.results : [];
  if (!results.length) {
    const value = {
      status: "unverified",
      reason: `Wikidata 确实没有「${name}」的条目（请求成功，0 命中）`,
      checkedAt: now,
    };
    cacheWrite(key, value);
    return value;
  }

  const described = results.map((r) => ({
    r,
    id: String(r.id || ""),
    description: r.description?.value || r["display-label"]?.value || "",
    ...screensAsFilm(r.description?.value || "", year),
  }));
  const filmish = described.filter((x) => x.ok);
  if (!filmish.length) {
    const value = {
      status: "unverified",
      reason: `Wikidata 有 ${results.length} 个同名条目，但没有影片：例如「${clean(results[0]?.description?.value).slice(0, 60)}」`,
      checkedAt: now,
    };
    cacheWrite(key, value);
    return value;
  }

  const qid = filmish[0].id;
  const entity = await getJSON(`${WD_REST}/entities/items/${qid}`);
  if (!entity || entity.__status) {
    return {
      status: "unverified",
      transportFailed: true,
      reason: `Wikidata 条目 ${qid} 的详情请求失败，身份与导演未核实`,
      checkedAt: now,
    };
  }

  const statements = entity.statements || {};
  const directorQid = statementContent(statements, "P57");
  const imdbId = statementContent(statements, "P345");
  const wdYear = yearOf(statementContent(statements, "P577"));

  let director = null;
  if (typeof directorQid === "string" && /^Q\d+$/.test(directorQid)) {
    await sleep(120);
    const d = await getJSON(`${WD_REST}/entities/items/${directorQid}`, { timeoutMs: 6000, tries: 1 });
    director = labelOf(d?.labels);
  }

  // 证据措辞必须区分两种完全不同的情况：
  //   · P57 根本没有声明 → 「该条目未声明导演」
  //   · P57 有值但标签没取到 → 「导演条目标签未取到（Q51123）」
  // 把后者写成前者，就是用一句假的「无声明」掩盖一次取数失败。
  const directorEvidence = director
    ? ` · P57 ${director}`
    : directorQid
      ? ` · P57 ${directorQid}（导演标签未取到）`
      : " · 该条目无 P57 导演声明";

  const value = {
    status: director ? "verified" : "partial",
    qid,
    title: labelOf(entity.labels) || name,
    year: wdYear || year || null,
    yearConflict:
      wdYear && year && wdYear !== String(year)
        ? `Commons 文件名推断 ${year}，Wikidata P577 为 ${wdYear}`
        : null,
    director,
    directorQid: typeof directorQid === "string" ? directorQid : null,
    directorStatus: director ? "verified" : directorQid ? "label-unavailable" : "unverified",
    imdbId: typeof imdbId === "string" ? imdbId : null,
    wikidataUrl: `https://www.wikidata.org/wiki/${qid}`,
    evidence: `Wikidata ${qid}${directorEvidence}${wdYear ? ` · P577 ${wdYear}` : ""}`,
    checkedAt: now,
  };
  cacheWrite(key, value);
  return value;
}