// remoteDiscovery.js — 受控远程发现（STEP 2 统一发现入口）。
//
// 复用现有架构，不建第二套检索系统：
//   · 网络形状沿用 artSourceAdapter.getJSON 的重试/退避约定
//   · 缓存沿用 artService 的 localStorage + TTL 约定（键名独立，避免污染既有缓存）
//   · 归一化沿用 normalizeArtwork 的「API 事实 vs 我方解读」分离原则
//   · 匹配沿用 retrievalService 的 scoreIntent / sharedReasons，本文件不评分
//
// 严格边界：
//   1. 电影画面只能来自 Commons。实测四家博物馆 API 均不提供可下载影片帧
//      （见 channelMatrix.js CHANNEL_FACTS.noMuseumHasFilmStills）。
//      本文件不新增任何外部 API。
//   2. 只展示经许可核验的图像。Commons 逐张读 extmetadata 判定
//      Copyrighted=False 且 License 模板为 pd；不通过的只保留元数据。
//   3. 无真实 Vision 时不声称图像已被模型理解。远程发现项的 VisualIntent
//      一律标注为「渠道元数据推导」，绝标 live-vision / calibration-cache。

import { parseVisualIntent } from "../retrieval/visualIntentParser.js";

// ---------------------------------------------------------------------------
// 网络：形状与 artSourceAdapter.getJSON 一致（重试、退避、非 JSON 检测）
// ---------------------------------------------------------------------------
const UA = "VisualAncestry-RemoteDiscovery/1.0 (existing channel sources)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 浏览器与 Node 的差别必须在实现里照顾到：MEASURED 实测浏览器下
// Commons 全部失败、Node 下成功，根因是 CORS 预检。
// 浏览器禁止 JS 设置 `User-Agent`（它属于 forbidden header，会被静默丢弃），
// 但我们显式传了它进 headers，触发预检 OPTIONS；而 Commons 的
// Access-Control-Allow-Headers 不含 user-agent，预检失败 → 浏览器根本
// 不发请求。Node 没有同源策略，所以照样成功。
// 「Node 网络成功不能替代浏览器成功」在这里是字面意义的坑。
//
// 修法：浏览器环境不发送自定义 UA（浏览器自带真实 UA，本来也不该由我们指定），
// 只在 Node 侧加 UA 以符合 Wikimedia 的 UA 政策。
const IS_BROWSER = typeof window !== "undefined" && typeof window.document !== "undefined";

// MEASURED 超时与重试参数：实测 Commons 在跨境网络下可耗时 53 秒才失败
  // （单次 45s timeout × 3 次重试）。那意味着用户点一次搜索要等 135 秒
  // 才看到「远程不可用」，本地结果早就显示了，但远程区段长期挂在加载态。
  // 所以：单次 timeout 压到 12s，重试 1 次，总上限约 24s——远程失败要
  // 尽快让用户知道，而不是让加载态耗着。本地检索不受影响，快失败是正解。
async function getJSON(url, { headers = {}, tries = 1, timeoutMs = 12000 } = {}) {
  let lastErr = "";
  const reqHeaders = IS_BROWSER ? { ...headers } : { "User-Agent": UA, ...headers };
  for (let attempt = 0; attempt <= tries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: reqHeaders, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      lastErr = `transport:${String(e?.message || e).slice(0, 60)}`;
      if (attempt === tries) break;
      await sleep(1500 * Math.pow(2, attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = `http-${res.status}`;
      if (attempt === tries) break;
      await sleep(2000 * Math.pow(2, attempt));
      continue;
    }
    if (!res.ok) return { error: `http-${res.status}` };
    const text = await res.text();
    if (!text.trim().startsWith("{")) return { error: "non-json" };
    try { return { data: JSON.parse(text) }; } catch { return { error: "bad-json" }; }
  }
  return { error: lastErr || "exhausted" };
}

// ---------------------------------------------------------------------------
// 缓存：与 artService 同约定（localStorage + TTL），键名独立
// ---------------------------------------------------------------------------
const CACHE_PREFIX = "va-channel-discovery-v1";
const CACHE_TTL = 24 * 60 * 60 * 1000;
const CACHE_MAX = 24;
// 缓存结构版本。实测踩过：加了 concepts/skippedCount 字段之后，浏览器里
// 24 小时前写入的旧缓存仍被命中并原样返回，界面于是显示「本次扫描 未知 条」。
// 只改字段不升版本，等于把旧数据喂给新代码。结构不匹配一律当未命中。
const CACHE_SCHEMA = 2;

function cacheRead(key) {
  try {
    const raw = window.localStorage.getItem(`${CACHE_PREFIX}:${key}`);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || Date.now() - entry.ts > CACHE_TTL) return null;
    // 结构版本不匹配 = 旧版本写入的数据。宁可重新请求，也不要把缺字段的
    // 旧结果当成本次检索的结果返回（实测症状：界面显示「本次扫描 未知 条」）。
    if (entry.schema !== CACHE_SCHEMA) {
      window.localStorage.removeItem(`${CACHE_PREFIX}:${key}`);
      return null;
    }
    return entry.value;
  } catch {
    return null;
  }
}

function cacheWrite(key, value) {
  try {
    const raw = window.localStorage.getItem(`${CACHE_PREFIX}:index`) || "[]";
    const index = JSON.parse(raw);
    index.push({ key, ts: Date.now() });
    // 淘汰过期与超额条目，避免无限增长（STEP 3：避免重复下载完整素材）
    const alive = index.filter((e) => Date.now() - e.ts < CACHE_TTL).slice(-CACHE_MAX);
    for (const e of index) {
      if (!alive.some((a) => a.key === e.key)) window.localStorage.removeItem(`${CACHE_PREFIX}:${e.key}`);
    }
    window.localStorage.setItem(`${CACHE_PREFIX}:index`, JSON.stringify(alive));
    window.localStorage.setItem(`${CACHE_PREFIX}:${key}`, JSON.stringify({ ts: Date.now(), schema: CACHE_SCHEMA, value }));
  } catch {
    // 存储不可用时缓存是尽力而为，不影响发现
  }
}

export function clearDiscoveryCache() {
  try {
    const index = JSON.parse(window.localStorage.getItem(`${CACHE_PREFIX}:index`) || "[]");
    for (const e of index) window.localStorage.removeItem(`${CACHE_PREFIX}:${e.key}`);
    window.localStorage.removeItem(`${CACHE_PREFIX}:index`);
  } catch { /* noop */ }
}

// ---------------------------------------------------------------------------
// 许可判定（逐张，不按年代推定）
// ---------------------------------------------------------------------------
// Commons 的 extmetadata 是本项目唯一逐张核验过的许可来源
// （film-license-audit.mjs 用的是同一个端点同一组字段）。
export function judgeCommonsRights(extmetadata) {
  const m = extmetadata || {};
  const v = (k) => String(m[k]?.value ?? "").trim();
  const license = v("License");
  const shortName = v("LicenseShortName");
  const usageTerms = v("UsageTerms");
  const copyrighted = v("Copyrighted");
  const attribution = v("AttributionRequired");

  // 只放行明确的公共领域。CC-BY-SA 等需要署名/共享的条目不放行图像展示。
  const isPublicDomain = /^(pd|public domain)$/i.test(license)
    || /^public domain$/i.test(shortName)
    || /publicdomain/i.test(usageTerms);
  const notCopyrighted = copyrighted.toLowerCase() === "false";

  return {
    license,
    licenseShortName: shortName || license,
    usageTerms,
    copyrighted: copyrighted || null,
    attributionRequired: attribution || null,
    credit: v("Credit").replace(/<[^>]*>/g, "").trim().slice(0, 120) || null,
    categories: v("Categories"),
    rightsCategory: (v("Categories").split("|").find((c) => /PD-|public domain/i.test(c)) || "").trim() || null,
    // showable：只有许可明确且未被标记版权的条目才允许展示图像
    showable: isPublicDomain && notCopyrighted,
    reason: !isPublicDomain
      ? `许可为 ${shortName || license || "未知"}，非明确公共领域，仅保留元数据`
      : !notCopyrighted
        ? "Commons 标记为受版权保护，仅保留元数据"
        : null,
  };
}

// ---------------------------------------------------------------------------
// 渠道元数据匹配（诚实标注，不是视觉理解）
// ---------------------------------------------------------------------------
// MEASURED GAP: 远程件在 VisualIntent 空间里得分为 0。原因是结构性的，不是
// bug：intentFromArtwork() 只读我方撰写/校准的字段（composition、lighting、
// emotion、atmosphere…），而 normalizeArtwork 给远程件的 analysisLevel=0，
// 这些字段按设计是空的。所以「远程绘画件在 VisualIntent 空间不可匹配」是
// 事实，不能靠给渠道元数据编造情绪来掩盖。
//
// 能诚实做的只有一件：用渠道**真实提供**的文本字段（medium、classification、
// department、culture、subjects、title、year）做受控词表匹配，并明确标注
// provenance = channel-metadata-text。它是「这件作品被馆方归为风景画」这种
// 文本事实，不是「模型看过这张画」。绝不含 image analysis 的含义。
// 渠道字段 → 受控标签。**只做「这件作品被馆方归为什么」的事实标记。**
//
// R5 修正：原实现把题材直接翻译成视觉参数——「战争」推出 emotion:紧张、
// 「日本」推出 atmosphere:克制、「夜景」推出 low-key 光位。这是凭题材编造
// 情绪与光位，正是必须禁止的事。同一件「战争题材」的画可以是一张阳光下的
// 静物，馆方分类无法证明画面里有什么光、什么情绪。
//
// 所以这里**不再产出任何 intentPatch**。intent 字段（景深/机位/光位/情绪）
// 只能来自我方撰写校准的 VisualIntent 或真实 Vision 分析，渠道文本无权填。
// 渠道只提供「媒介与题材标签」，供用户判断这件作品是否相关。
// MEASURED 修正（复数漏匹配）：馆方 classification 的实际值是**复数**形式
// —— "Landscapes" / "Still lifes" / "Portraits" / "Nocturnes"。原先的
// /\blandscape\b/i 有词尾边界，复数形式一律不命中（实测 classification
// "Landscapes" 匹配分为 0）。所以规则一律允许可选的结尾 s。
const CHANNEL_TERMS = [
  // [正则, 标签, 字段名]
  [/\b(landscapes?|paysages?|seascapes?|marines?)\b|风景/i, "风景", "classification"],
  [/\b(portraits?|busts?)\b|肖像/i, "肖像", "classification"],
  [/\b(still lifes?|natures? mortes?)\b|静物/i, "静物", "classification"],
  [/\b(interiors?|rooms?)\b|室内/i, "室内", "classification"],
  [/\b(architectures?)\b|建筑/i, "建筑", "classification"],
  [/\b(nocturnes?)\b|夜景/i, "夜景", "classification"],
  [/\b(reliefs?|sculptures?|bronzes?)\b|雕塑|浮雕/i, "雕塑", "classification"],
  [/\b(wars?|battles?|military)\b|战争/i, "战争题材", "classification"],
  [/\b(portraits?|oil on canvas|photographs?|photogravures?|watercolors?|temperas?|woodcuts?|lithographs?|engravings?)\b|油画|摄影|铜版|版画/i, null, "medium"],
  [/\b(japanese|japan)\b|日本/i, "日本相关", "culture"],
  [/\b(chinese|china)\b|中国/i, "中国相关", "culture"],
];

// 字段名 → 人话标签。命中位置必须能说清是哪个字段给的依据。
const FIELD_LABELS = {
  title: "标题",
  medium: "材质",
  classification: "馆方分类",
  department: "部门",
  culture: "文化",
  subjects: "主题词",
};

// 查询词 → 渠道检索用的受控词。
//
// R5 实测修正：中文视觉描述（"雾 空旷"）不能直接作为 Commons 文件名的
// 字面子串——Commons 是英文文件名，`hay.includes("雾 空旷")` 恒为 false，
// 会把「渠道不支持中文语义」谎报成「没有该片素材」。
// 这里做**有界转换**：只映射我们确实知道对应英文的受控词，其余一律返回
// null，由调用方明确告知「此渠道不支持该查询语义」，不假装检索过。
const QUERY_TERM_MAP = [
  [/\b(landscape|paysage|seascape|marine)\b|风景|空旷|辽阔|山|海/i, "landscape"],
  [/\b(portrait)\b|肖像|人物|脸/i, "portrait"],
  [/\b(still life)\b|静物/i, "still life"],
  [/\b(night|nocturne)\b|夜|夜色|黑暗/i, "night"],
  [/\b(war|battle)\b|战争/i, "war"],
  [/\b(interior)\b|室内|房间/i, "interior"],
  [/\b(snow|winter)\b|雪|冬/i, "snow"],
  [/\b(city|street)\b|城市|街/i, "city"],
];

// 把用户查询转成渠道可用的检索词。返回 null 表示「无有界映射」，
// 调用方必须据此说明渠道不支持，而不是当成零结果。
//
// STEP 2 补充：explainChannelTerm() 在同一份映射表上多给出「哪些词没被用上」。
// 之前「冷色 孤独 空旷街道」会被整条映射成 landscape，界面看不出「冷色/孤独」
// 根本没参与检索——用户会以为渠道理解了整句。漏掉的词必须一起报出来。
export function explainChannelTerm(query) {
  const q = String(query || "").trim();
  if (!q) return { term: null, supported: false, unusedTokens: [], reason: "空查询" };

  // 中文按顿号/逗号/空格切词；英文片名整体保留。
  const tokens = q.split(/[、,，\s]+/).map((t) => t.trim()).filter(Boolean);
  let matchedRule = null;
  let matchedToken = null;
  for (const [re, term] of QUERY_TERM_MAP) {
    const hit = tokens.find((t) => re.test(t));
    if (hit) {
      matchedRule = term;
      matchedToken = hit;
      break;
    }
  }
  if (matchedRule) {
    // 整句里没被任何规则认领的词 = 未参与检索的语义。
    const unusedTokens = tokens.filter((t) => t !== matchedToken);
    return {
      term: matchedRule,
      supported: true,
      matchedToken,
      unusedTokens,
      reason: unusedTokens.length
        ? `仅「${matchedToken}」映射为受控词「${matchedRule}」；${unusedTokens.join("、")} 未参与本次渠道检索`
        : `「${matchedToken}」映射为受控词「${matchedRule}」`,
    };
  }

  // 已是英文专名（如片名 Intolerance）时原样透传，让渠道自己检索。
  if (/^[A-Za-z][A-Za-z\s'.-]{2,}$/.test(q)) {
    return { term: q, supported: true, matchedToken: q, unusedTokens: [], reason: `英文片名原样透传：「${q}」` };
  }
  return { term: null, supported: false, unusedTokens: tokens, reason: "无有界映射" };
}

export function queryToChannelTerm(query) {
  return explainChannelTerm(query).term;
}

// 字段分两类，这是整个相关性判定的核心：
//
//   主体字段（描述「这件作品画的是什么」）：title / classification / subjects / department
//   归属字段（描述「这件作品是谁的、用什么做的」）：culture / medium / 年代
//
// MEASURED 缺陷（本轮任务书点名）：原实现把 culture 命中也计 2 分，于是查询
// 「量子纠缠与孤独」会因为《Bathing of the Buddha Festival》的 culture=Chinese
// 而得到相关性分——「作品来自中国」与「用户想找量子纠缠」毫无关系。
// 同理「媒介是油画」「年代是 1880」都不能说明画面内容。
//
// 所以：**只有主体字段能产生相关性分**。归属字段一律只作事实展示（facts），
// 计分恒为 0。这不是调权重，是字段性质的分界。
const SUBJECT_FIELDS = ["title", "classification", "subjects", "department"];
const ATTRIBUTIVE_FIELDS = ["culture", "medium"];

// 逐字段判断元数据相关性。
// 返回 { score, reasons, tags, facts, queryRelated, provenance, note }。
//   score      仅由「查询词命中主体字段」产生——与查询无关的候选必为 0。
//   facts      归属字段的客观陈述，只展示不计分。
export function matchChannelMetadata(ref, query = "") {
  const fields = {
    title: String(ref.title || ""),
    medium: String(ref.medium || ""),
    classification: String(ref.classification || ""),
    department: String(ref.department || ""),
    culture: String(ref.culture || ""),
    subjects: (ref.subjects || []).join(" "),
  };

  // 查询词先做有界转换：中文视觉描述（"雾 空旷"）映射成英文受控词
  // （"landscape"）后才能与馆方英文字段比对；映射不出则用原文（片名
  //  Intolerance 这类专名原样透传）。映射既不出、原文又不是可匹配内容时，
  // 任何字段都不可能命中，相关性自然为 0——如实返回，不编造。
  const channelTerm = queryToChannelTerm(query);
  const q = (channelTerm || String(query || "").trim()).toLowerCase();

  // ---- 1. 查询相关性：只在主体字段里找 ----
  let queryField = "";
  if (q) {
    for (const f of SUBJECT_FIELDS) {
      if (fields[f].toLowerCase().includes(q)) {
        queryField = f;
        break;
      }
    }
  }
  const queryRelated = Boolean(queryField);
  const queryScore = queryRelated ? 3 : 0;

  // ---- 2. 主体字段的题材标签（描述画面内容，可作辅助依据）----
  const tags = [];
  const reasons = [];
  for (const [re, label, fieldName] of CHANNEL_TERMS) {
    // CHANNEL_TERMS 里混有 medium 规则（label 为 null 的那条），
    // medium 是归属字段，不在这里计分。
    if (fieldName === "medium") continue;
    if (!SUBJECT_FIELDS.includes(fieldName)) continue;
    const value = fields[fieldName] || "";
    if (!value || !re.test(value)) continue;
    if (!label) continue;
    tags.push(label);
    reasons.push(`${FIELD_LABELS[fieldName] || fieldName}含「${label}」`);
  }

  // ---- 3. 归属字段：只作事实，永不参与计分 ----
  const facts = [];
  for (const f of ATTRIBUTIVE_FIELDS) {
    const v = fields[f];
    if (!v) continue;
    const label = FIELD_LABELS[f] || f;
    facts.push(`${label}：${v.length > 40 ? v.slice(0, 40) + "…" : v}`);
  }

  const score = queryScore;

  if (!score) {
    return {
      score: 0,
      reasons: [],
      tags: [],
      facts,
      provenance: "channel-metadata-text",
      queryRelated: false,
      note: "馆方主体字段未提供与本查询相关的线索",
    };
  }

  if (queryRelated) {
    reasons.unshift(
      `${FIELD_LABELS[queryField] || queryField}包含你的查询词「${query}」${channelTerm && channelTerm !== query ? `（按「${channelTerm}」检索）` : ""}`
    );
  }

  return {
    score,
    reasons: reasons.slice(0, 4),
    tags,
    facts,
    // 无 intentPatch：渠道文本无权填视觉参数（见上方说明）。
    intentPatch: null,
    provenance: "channel-metadata-text",
    queryRelated,
    note: "依据馆方主体字段的文本匹配，非模型视觉分析",
  };
}

import { classifyFrameNature, filmIdentityFromCommons, verificationFor } from "./filmFrameEvidence.js";
import { resolveFilmIdentity } from "./filmIdentityWikidata.js";
import { conceptTerms, locateTerm, describeConcepts } from "./filmConceptTerms.js";

// ---------------------------------------------------------------------------
// Commons 电影画面发现
// ---------------------------------------------------------------------------
// 只接受图像 mime：搜索结果里混有 application/pdf（扫描杂志）与
// application/ogg（视频），它们不是「画面」。
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/jpg"]);

// 「这是不是影片的一帧」的可判定信号。
//
// MEASURED 教训：只靠 Categories 含 "Film stills" 会误判。实测条目
// "File:A pile of photos on the blanket.jpg" 的 Categories 确实含 Film stills，
// 但 ImageDescription 是「Collection of seven photos, piled up on the blanket」
// —— 是一堆普通照片，且带 Commons 自身的
// "Media needing category review as of 30 June 2015" 标记，即分类本身存疑。
// 所以分类命中只是候选，必须再有**独立的正面证据**：文件名/描述里有
// screenshot / film still / 影片名+年份，或该分类带 review 标记时直接拒绝。
const FILM_FRAME_STRONG = /(film\s*still|movie\s*still|screenshot|frame\s+from)/i;
// Commons 自己标注「该分类需要复查」，这类条目一律不收。
const CATEGORY_DOUBT = /Media needing category review/i;
const FILM_FRAME_HINT = /(film\s*still|movie\s*still|screenshot|frame from|cinema|stills? from)/i;

function looksLikeFilmFrame(page, rights) {
  const info = page.imageinfo?.[0] || {};
  const mime = String(info.mime || "");
  if (!IMAGE_MIMES.has(mime.toLowerCase())) return { ok: false, why: `mime=${mime || "unknown"} 非单帧图像` };

  const categories = String(info.extmetadata?.Categories?.value || "") || String(rights?.categories || "");
  const description = String(info.extmetadata?.ImageDescription?.value || "").replace(/<[^>]*>/g, "");
  const objectName = String(info.extmetadata?.ObjectName?.value || "");

  // Commons 明确标注分类存疑 → 不收，宁缺勿滥。
  if (CATEGORY_DOUBT.test(categories)) {
    return { ok: false, why: "Commons 标注该条目分类需要复查（Media needing category review）" };
  }
  // 照片堆、拼图、相册等明显不是单帧的描述
  if (/\b( pile of photos?|collection of .*photos?|contact sheet|montage|collage)\b/i.test(description)) {
    return { ok: false, why: "描述表明是多张照片集合，非单帧画面" };
  }

  const haystack = `${page.title} ${objectName}`;
  const weak = `${categories} ${description}`;
  // 强证据：标题/对象名自身声明是截图或影片帧。
  if (FILM_FRAME_STRONG.test(haystack)) return { ok: true };
  // 弱证据：分类命中且描述里也提到影片，才接受。
  if (FILM_FRAME_HINT.test(weak) && /\b(film|cinema|movie)\b/i.test(description)) return { ok: true };
  return { ok: false, why: "元数据未提供独立的影片帧证据（仅分类命中不足以采信），不收为电影画面" };
}

// 从 Commons 文件名/ObjectName 里尽力提取片名与年份；提取不到就留空，
// 绝不编造。
function filmMetaFromCommons(page) {
  const raw = String(page.title || "").replace(/^File:/, "").replace(/\.(jpg|jpeg|png|tif|tiff|pdf)$/i, "");
  const year = raw.match(/\b(18|19|20)\d{2}\b/)?.[0] || null;
  // 去掉扩展名式后缀与扫描件命名噪声，保留可读部分
  let title = raw
    // 扫描序列号后缀必须在 [_-]→空格**之前**去掉：实测
    // "Intolerance (1916) - 2.jpg" 若先转空格就变成 "Intolerance ( ) 2"，
    // 片名多出一个 2，Wikidata 按 "Intolerance 2" 检索必然查无此片。
    .replace(/\s+[-–]\s*\d+\s*$/, "")
    .replace(/\b(18|19|20)\d{2}\b/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Commons 上影片帧的常见命名："Title (year) screenshot 2" → "Title"
  title = title.replace(/\b(screenshot|still|frame|stills?)\b\s*\d*$/i, "").replace(/\s+/g, " ").trim();
  return { title: title || raw, year };
}

// 一次请求拿到的字段就是全部依据：分类/许可/尺寸/URL 都来自 imageinfo。
//
// MEASURED 设计缺陷（本轮实测修掉）：原实现只走
// `generator=categorymembers` + `gcmlimit=50`，即「Category:Film stills 的
// 前 50 个文件」，再用 query 做关键词过滤。实测 `intolerance` 命中 0 件——
// 因为分类枚举的前 50 条与具体片名几乎不重合，交集趋近于零。这不是「Commons
// 没有该片画面」，而是召回策略的假阴性。
//
// 修法：双路召回后合并去重。
//   路径 A分类枚举（已有）——泛查询如「电影截图」仍能命中。
//   路径 B Commons 全文搜索 + `incategory:"Film stills"` —— 具体片名能命中。
// 两条路都受同一套 looksLikeFilmFrame() 硬过滤，召回变多不会放宽判据。
export async function discoverCommonsFilmStills(
  query,
  { limit = 8, category = "Category:Film stills", identityBudget: identityBudgetLimit = 3, maxSearches = 3 } = {}
) {
  const cacheKey = `commons-film:${category}:${query}:${limit}`;
  const cached = cacheRead(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  // 路径 A：按分类枚举。泛查询的入口。
  //
  // iiurlwidth 两条路径都必须带：实测只加在搜索路径上时，分类枚举来的条目
  // 没有 thumbnailurl，tiers 为空 → FIND 直接加载原始大文件（Commons 单图
  // 可达数 MB）。缩略图由 Commons 服务端生成，不是拼 URL 猜的。
  const params = new URLSearchParams({
    action: "query", format: "json", formatversion: "2",
    generator: "categorymembers", gcmtitle: category, gcmtype: "file",
    gcmlimit: "50",
    prop: "imageinfo|categories",
    // STEP 2：结构化类目是「图像性质」与「电影身份」最可靠的证据来源。
    // 实测 Intolerance (1916) 的剧照被归在
    // "Category:Triangle Film Corporation publicity photos" 与
    // "Category:Fall of Babylon (Intolerance)" 下——只看标题与描述会漏掉这两条。
    cllimit: "200",
    iiprop: "url|extmetadata|size|mime",
    iiurlwidth: "960",
    // MEASURED：`origin=*` 让 Commons 返回 Access-Control-Allow-Origin: *，
    // 浏览器直连才可能成功。实测不带此参数时浏览器 fetch 直接
    // `TypeError: Failed to fetch`（Node 却正常——正是"Node 成功不能
    // 替代浏览器成功"）。
    origin: "*",
  });
  const { data, error } = await getJSON(`https://commons.wikimedia.org/w/api.php?${params}`);

  let pages = data?.query?.pages || [];

  // 路径 B：Commons 全文搜索。具体片名的入口。
  //
  // MEASURED：不能用 `incategory:"Film stills"` 收敛。实测该分类在 Commons
  // 全文搜索里返回 **0 条**（四种写法对照：incategory+filetype 0 条、仅
  // incategory 0 条、纯关键词 20 条、单词 20 条）——分类名对不上检索索引。
  // 所以这里只发关键词，质量由同一套 looksLikeFilmFrame() 硬过滤保证：
  // 召回变宽不等于判据放宽，「一堆照片」与「分类需复查」仍会被剔除。
  //
  // 中文查询处理：`q` 是用户输入的中文视觉描述（"雾 空旷"）时，直接拿它当
  // Commons 文件名字面串必然零命中（Commons 是英文文件名），那会把「渠道
  // 不支持中文语义」谎报成「没有该片素材」。所以先用 queryToChannelTerm()
  // 做**有界映射**；映射不出来（unsupported=true）就直接如实返回，
  // 不发注定零结果��请求，更不谎报无素材。
  const rawQuery = String(query || "").trim();

  // STEP 2：多概念召回词。每个词带来源与可信度；映射不出来的词原样报告为
  // unmapped，绝不替换成「差不多」的词（不把「孤独」推断成某种构图、
  // 不把「冷色」断定为夜景）。检索词只用于文件名/类目匹配，不构成画面结论。
  const concepts = conceptTerms(rawQuery);
  const unsupportedReason = "";

  if (rawQuery && !concepts.terms.length) {
    return {
      channel: "commons",
      references: [],
      skipped: [],
      scanned: 0,
      unsupported: true,
      concepts,
      note: `远程电影渠道只支持英文片名或受控词检索，无法把描述「${rawQuery}」转成文件名匹配${
        concepts.unmapped.length ? `（未映射的词：${concepts.unmapped.join("、")}）` : ""
      }。`,
    };
  }

  if (!error && concepts.terms.length) {
    // 每个受控词各发一次检索，逐词召回而不是只发一个词。
    // 上限 maxSearches（默认 3，与 MAX_TERMS 对齐），避免一次查询打爆渠道。
    for (const concept of concepts.terms.slice(0, maxSearches)) {
      const searchParams = new URLSearchParams({
        action: "query", format: "json", formatversion: "2",
        generator: "search",
        gsrsearch: `${concept.term} film still`,
        gsrnamespace: "6",
        gsrlimit: "20",
        prop: "imageinfo|categories",
        cllimit: "200",
        // iiurlwidth 请求服务端真实缩略图。实测 Commons 会返回真实 thumburl
        //（w=320→330px），不是拼 URL 猜测——这避免了 FIND 直接加载原始大图。
        iiprop: "url|extmetadata|size|mime",
        iiurlwidth: "960",
        origin: "*",
      });
      const { data: searchData } = await getJSON(
        `https://commons.wikimedia.org/w/api.php?${searchParams}`
      );
      const found = searchData?.query?.pages || [];
      const seenTitles = new Set(pages.map((p) => p.title));
      for (const p of found) {
        if (seenTitles.has(p.title)) continue;
        pages.push(p);
      }
      await sleep(150);
    }
  }

  if (error) return { error, channel: "commons", references: [] };

  const references = [];
  const skipped = [];
  // 身份核实与三轴重算需要原始 page / nature，循环结束后才用；
  // 它们不进返回值也不进缓存（缓存只需要 references 里那一份）。
  const pageOf = [];
  const natureOf = [];

  // STEP 2：按**命中位置**判定召回依据，并据此区分两件完全不同的事：
//   · 描述/类目命中 → 渠道元数据声称这件与该概念有关（仍不是画面分析）
//   · 仅片名命中   → 大概率只是片名撞词（例如《Saturday Night》不是夜晚画面）
// 两者都**不等于**视觉匹配：没有做图像分析之前，一律是「待视觉核验」。
const matchesFor = (page, meta, terms) => {
  if (!terms || !terms.length) return [];
  const out = [];
  for (const concept of terms) {
    const loc = locateTerm(page, meta, concept.term);
    if (loc.matched) {
      out.push({ ...concept, ...loc });
    }
  }
  return out;
};

// visualStatus 的取值与界面措辞一一对应（组件 remoteFilmCard.js 使用）：
//   film-title-match    片名/影片身份匹配（片名查询的正常召回）
//   metadata-concept    描述或类目提到该概念 —— 待视觉核验
//   title-only          仅片名撞词 —— 画面未验证，风险最高，排在最后
function visualStatusFor(conceptMatches, properNoun) {
  if (properNoun) {
    return { status: "film-title-match", label: "片名/影片身份匹配（待视觉核验）" };
  }
  if (!conceptMatches.length) {
    return { status: "unverified", label: "未验证（召回依据不足）" };
  }
  const strong = conceptMatches.some((m) => m.location !== "title-only");
  if (strong) {
    return { status: "metadata-concept", label: "描述/类目提到该概念（待视觉核验）" };
  }
  return { status: "title-only", label: "仅片名撞词，画面未验证（待视觉核验）" };
}

for (const page of pages) {
    const ii = (page.imageinfo || [])[0] || {};
    const rights = judgeCommonsRights(ii.extmetadata);
    const frame = looksLikeFilmFrame(page, rights);
    const meta = filmMetaFromCommons(page);

    if (!frame.ok) { skipped.push({ title: page.title, why: frame.why }); continue; }
    // STEP 2 关键词闸门：按**被召回的那个检索词**判定，不再要求用户所有词都命中。
    // 上一轮把两个策略搞成了互相打架（只发一个检索词，却要求三个词全中），实测必然 0 结果。
    // 现在：文件被哪个词召回，就用哪个词校验它；一个都没召回（只来自分类枚举）则不收。
    const conceptMatches = matchesFor(page, meta, concepts.terms);
    if (concepts.terms.length && !conceptMatches.length) {
      skipped.push({
        title: page.title,
        why: `未被任何检索词命中（本次检索：${concepts.terms.map((c) => `「${c.term}」`).join("、")}）`,
      });
      continue;
    }
    const visual = visualStatusFor(conceptMatches, concepts.properNoun);

    // STEP 2 三轴核验：身份 / 图像性质 / 许可。单独成文件是为了让「性质未标注」
    // 与「性质确认为海报」成为两种不同的可解释状态——上一轮的错误正是把明信片、
    // 宣传照、剧照统统说成「剧照」。
    const nature = classifyFrameNature(page);
    const identity = filmIdentityFromCommons(page, { title: meta.title, year: meta.year });
    const verification = verificationFor({ page, rights, nature, identity });
    // 印刷品（海报 / 明信片 / lobby card / 书插画）不进候选，并留下原因。
    if (nature.reject) {
      skipped.push({ title: page.title, why: nature.label });
      continue;
    }

    const base = {
      channel: "commons",
      channelName: "Wikimedia Commons",
      sourceId: page.title,
      // 展示与检索用的片名取**清洗后**的身份字段，不是文件名推断值。
      // 实测两处后果：① 界面上显示 "Intolerance ( )" 这种带括号残渣的串；
      // ② 拿它去 Wikidata 检索必然查无此片，导演核实整条失效。
      title: identity.title || meta.title,
      // 文件名推断的原值保留为证据链的一环（界面不显示，JSON 里可查）。
      fileDerivedTitle: meta.title,
      year: meta.year,
      // Commons 元数据里没有导演。留空，不拿摄影者/上传者冒充导演。
      director: null,
      // STEP 2：图像性质与身份不再藏在评论里，而是随候选一起下发。
      imageKind: nature.kind,
      imageKindLabel: nature.label,
      imageKindStatus: nature.status,
      // STEP 2：召回依据与视觉验证状态随候选下发。
      // 没有做图像分析之前，这里**不可能**是「已视觉匹配」。
      recallBasis: {
        query: rawQuery || null,
        strategy: concepts.strategy,
        terms: concepts.terms.map((t) => ({ term: t.term, source: t.source, confidence: t.confidence, matchedToken: t.matchedToken })),
        unmapped: concepts.unmapped,
        matched: conceptMatches.map((m) => ({
          term: m.term,
          source: m.source,
          confidence: m.confidence,
          matchedToken: m.matchedToken,
          location: m.location,
          inTitle: m.inTitle,
          inDescription: m.inDescription,
          inCategories: m.inCategories,
        })),
      },
      visualStatus: visual.status,
      visualStatusLabel: visual.label,
      identity,
      verification,
      rights,
      rightsVerifiedAt: "2026-10-14",
      image: {
        type: "external",
        // detail 用 iiurlwidth 返回的真实缩略图（实测 960px 档可用），
        // url 保留原图作为回退。不这样做的后果是 FIND 直接加载原始
        // 大文件——Commons 单图可达数 MB。
        url: ii.url,
        width: ii.width || null,
        height: ii.height || null,
        ratio: ii.width && ii.height ? ii.height / ii.width : null,
        // MEASURED 字段名是 `thumburl`（无 "n"），不是 `thumbnailurl`。原先读错
        // 字段名导致tiers 永远为 null，FIND 于是在浏览器里直接加载原始大文件。
        // 实测响应字段全集：size,width,height,thumburl,thumbwidth,thumbheight,
        // thumbattribs,url,descriptionurl,extmetadata,mime
        thumbnailUrl: ii.thumburl || null,
        thumbnailWidth: ii.thumbwidth || null,
        thumbnailHeight: ii.thumbheight || null,
        tiers: ii.thumburl
          ? {
              // 只有一档真实缩略图时，三档都指向它——宁可重复请求同一张小图，
              // 也不加载原图。
              thumb: ii.thumburl,
              preview: ii.thumburl,
              detail: ii.thumburl,
            }
          : null,
      },
      sourceUrl: ii.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
    };
    references.push(rights.showable ? { ...base, showable: true } : { ...base, showable: false });
    pageOf.push(page);
    natureOf.push(nature);
    if (references.filter((r) => r.showable).length >= limit) break;
    await sleep(120);
  }

  // STEP 2：身份核实（Wikidata）。Commons 没有导演字段，这里做**有界**补全：
  // 只对已通过画面性质与许可判据的候选，最多 identityBudget 次请求；
  // 预算用尽就把剩下的标记为 budget-exhausted —— 如实说明，不静默跳过。
  //
  // 仍然是元数据核实，不是图像分析：它回答「这是哪部片、谁导的」，
  // 不回答「画面里有什么」。图像维度仍为 0，见下方 visionAnalyzed。
  const identityBudget = { remaining: identityBudgetLimit };
  // 同一部片只查一次：实测三条 Intolerance 候选共享同一片名，逐条查等于把
  // 请求量放三倍，也更容易撞上 Wikidata 的间歇性限流。
  const identityMemo = new Map();
  for (let i = 0; i < references.length; i++) {
    const ref = references[i];
    const baseIdentity = ref.identity || {};
    if (!ref.showable) continue;
    const wantTitle = baseIdentity.title || ref.title;
    const wantYear = baseIdentity.year || ref.year || null;
    const memoKey = `${String(wantTitle || "").toLowerCase()}|${wantYear || ""}`;
    let resolved = identityMemo.get(memoKey);
    if (!resolved) {
      resolved = await resolveFilmIdentity({ title: wantTitle, year: wantYear, budget: identityBudget });
      identityMemo.set(memoKey, resolved);
    }
    ref.identity = {
      ...baseIdentity,
      // Commons 侧的身份核验与 Wikidata 侧合并：任一侧有证据即写明来源。
      commonsStatus: baseIdentity.status || "unverified",
      commonsEvidence: baseIdentity.evidence || "",
      wikidataStatus: resolved.status,
      wikidataEvidence: resolved.evidence || resolved.reason || "",
      // 「没查成」与「没查到」必须能区分：实测 Wikidata 会间歇性返回空响应，
      // 不标出来的话界面会把一次网络失败显示成「导演未知」这一事实判断。
      wikidataTransportFailed: Boolean(resolved.transportFailed),
      wikidataUrl: resolved.wikidataUrl || null,
      qid: resolved.qid || null,
      imdbId: resolved.imdbId || null,
      director: resolved.director || null,
      directorStatus: resolved.directorStatus || "unverified",
      year: resolved.year || baseIdentity.year || null,
      yearConflict: resolved.yearConflict || null,
      // 三轴里的身份状态：Commons 类目或 Wikidata 任一确证即为 verified。
      status: resolved.status === "verified" ? "verified" : baseIdentity.status || "unverified",
      identitySource: resolved.qid ? "commons-category+wikidata" : "commons",
    };
    // 导演一旦被 Wikidata 确证，就把它填进候选的 director 字段；
    // 未确证时保持 null（不拿摄影者/上传者冒充）。
    ref.director = resolved.director || null;
    // 三轴状态要在导演核实之后重算，否则界面会显示「导演未知」而数据里其实有。
    ref.verification = verificationFor({
      page: pageOf[i],
      rights: ref.rights,
      nature: natureOf[i],
      identity: ref.identity,
    });
    await sleep(150);
  }

  const value = {
    channel: "commons",
    references,
    skipped,
    scanned: pages.length,
    // 实际使用的检索词（可能由中文转换而来）。留痕以便核对。
    usedQuery: concepts.terms.map((t) => t.term).join(" ") || null,
    originalQuery: rawQuery || null,
    // STEP 2：多概念召回的可解释数据 —— 每个词是什么、从哪来、可信度多少、
    // 实际贡献了几件候选。未映射的词也要一并报出，绝不静默丢弃。
    concepts: {
      strategy: concepts.strategy,
      terms: concepts.terms,
      unmapped: concepts.unmapped,
      searchesIssued: Math.min(concepts.terms.length, maxSearches),
      // 每个检索词实际召回多少件（通过全部闸门、进入候选）。
      termTally: concepts.terms.reduce((acc, t) => {
        acc[t.term] = references.filter((r) => (r.recallBasis?.matched || []).some((m) => m.term === t.term)).length;
        return acc;
      }, {}),
      // 命中位置分布：description/category 命中的才算元数据支撑，仅 title 的是撞词。
      locationTally: references.reduce(
        (acc, r) => {
          for (const m of r.recallBasis?.matched || []) acc[m.location] = (acc[m.location] || 0) + 1;
          return acc;
        },
        {}
      ),
      visualStatusTally: references.reduce((acc, r) => {
        acc[r.visualStatus] = (acc[r.visualStatus] || 0) + 1;
        return acc;
      }, {}),
    },
    // 电影渠道用自己的多概念说明，不能复用绘画渠道的单词解释器（见 describeConcepts）。
    queryMapping: rawQuery ? { ...explainChannelTerm(rawQuery), reason: describeConcepts(concepts) } : null,
    verificationTally: {
      identityVerified: references.filter((r) => r.verification?.axes?.[0]?.status === "verified").length,
      natureVerified: references.filter((r) => r.verification?.axes?.[1]?.status === "verified").length,
      licenceVerified: references.filter((r) => r.verification?.axes?.[2]?.status === "verified").length,
      directorVerified: references.filter((r) => r.director).length,
      identityBudgetUsed: identityBudgetLimit - identityBudget.remaining,
      identityBudgetLimit,
      // 「没核实成」的原因要能上报：Wikidata 间歇性 429/超时时，若不计数，
      // 界面上的「未核实」会被读成「这部片子没有可核实的身份」，而事实是
      // 「这次没查成」。验收脚本据此决定 SKIP 还是 FAIL，而不是靠猜。
      identityTransportFailed: references.filter((r) => r.identity?.wikidataTransportFailed).length,
      fullyVerified: references.filter((r) => r.verification?.showable).length,
      total: references.length,
    },
    natureKinds: references.reduce((acc, r) => {
      const k = r.imageKind || "unknown";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    // 图像分析覆盖率。动态发现的候选一律 0 —— 本渠道只做元数据召回，
    // 除非上层显式接入真实 Vision 并完成重排（见 filmVisionRerank.js），
    // 否则这个数字永远是 0，不允许被乐观估计。
    visionAnalyzed: 0,
    visionProvenance: "none",
    unsupported: Boolean(unsupportedReason),
    licenseRule: "extmetadata: Copyrighted=False 且 License/UsageTerms 明确为 public domain",
    attributionNote: "Commons 为已知来源渠道（数据文件长期引用），但此前无发现适配器；本轮补的是发现层，未新增外部 API。",
  };
  cacheWrite(cacheKey, value);
  return { ...value, fromCache: false };
}

// ---------------------------------------------------------------------------
// 绘画远程发现：复用现有 artService，不重写
// ---------------------------------------------------------------------------
// artService.searchRemote 已经把 AIC/Met/Cleveland/Rijks 归一化并缓存。
// 本文件只做两件新增的事：把结果并入统一 Reference 契约，以及在渠道完全
// 不可用时如实返回降级标记（而不是静默返回空数组）。
export async function discoverPaintingReferences(query, { limit = 8, searchRemote, rawIndex = null } = {}) {
  if (typeof searchRemote !== "function") {
    return { error: "searchRemote not provided", references: [], channel: "museums" };
  }
  try {
    const works = await searchRemote(query, { limit });
    // artService may return either raw adapter records or normalized works.
    // When it returns normalized ones the channel text is already gone, so the
    // original raw record (same sourceId) is looked up when the caller passed
    // a `rawIndex`. Nothing is fabricated when neither has it.
    const references = (works || []).map((w) => {
      // normalizeArtwork() OVERWRITES `source` with an object
      // {name,url,rightsStatus} and keeps the channel id only inside `key`
      // (`${source}:${sourceId}`). Reading `w.source` as the channel id yields
      // an object, so the id is taken from the key prefix — otherwise every
      // reference claims to be an object.
      //
      // artService hands us normalizeArtwork() output, and that normalizer
      // DROPS the channel classification fields: `medium`, `classification`,
      // `department` and `subjects` are all undefined after normalization
      // (MEASURED: only culture and museum survive). Those fields are the only
      // honest signal a remote work carries, so when they are present we use
      // them; when they are not, the reference simply has no channel text and
      // matchChannelMetadata() returns 0. Nothing is invented to fill the gap.
      const src = typeof w.source === "object" && w.source ? w.source : {};
      const channelId = String(w.key || "").split(":")[0] || "";
      // normalizeArtwork() puts the institution + rights statement INSIDE
      // `source` and keeps `publicDomain` as its own boolean. There is no
      // top-level `rights` after normalization — reading one yields undefined
      // and silently drops the licence, so the real fields are read below.
      const raw = (rawIndex && rawIndex.get(String(w.sourceId ?? ""))) || null;
      return {
        channel: channelId,
        channelName: w.museum || src.name || channelId,
        sourceId: String(w.sourceId ?? ""),
        mediumKind: "artwork",
        title: w.title || "",
        // A painting's creator is the artist; only a film still says director.
        artist: w.artist || "",
        year: w.year || "",
        image: w.image || null,
        // Surviving channel text, if the normalizer kept any.
        medium: w.medium || raw?.medium || "",
        classification: w.classification || raw?.classification || "",
        department: w.department || raw?.department || "",
        culture: w.culture || raw?.culture || "",
        subjects: raw?.subjects || [],
        rights: {
          text: src.rightsStatus || "",
          publicDomain: Boolean(w.publicDomain),
        },
        // showable gates what may be rendered as an image at all: a remote
        // work with no licence confirmation or no image URL must NOT become a
        // card with a broken picture.
        showable: Boolean(w.publicDomain) && Boolean(w.image?.url),
        sourceUrl: src.url || "",
        // API facts vs our interpretation stay separated: remote works are
        // analysisLevel 0 with empty analysis arrays. We never fabricate one.
        analysisLevel: w.analysisLevel ?? 0,
        provenance: "channel-metadata",
      };
    });
    return { channel: "museums", references, count: references.length };
  } catch (e) {
    return {
      channel: "museums",
      error: String(e?.message || e).slice(0, 120),
      references: [],
      degraded: true,
      note: "博物馆渠道不可用；本地检索不受影响。",
    };
  }
}