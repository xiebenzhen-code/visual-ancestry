// vision-search.mjs — P4.15 多模态检索链（实验）
//
// 本地召回（MobileCLIP 向量 + 结构）只负责「找候选」，不负责「决定推荐」。
// 决定权交给一次多图比较：查询图与候选图进同一个上游请求，模型逐张给出
// 构图 / 主体关系 / 色彩光线三类证据与差异，再由这里分档、剔除无关项。
//
// 三条硬约束：
//   1. 一个用户操作最多 1 次上游请求（MAX_UPSTREAM_PER_QUERY），不自动重试。
//   2. 媒介过滤发生在模型之前，且是硬过滤——普通绘画不可能以「动画」身份送出。
//   3. 模型自报与证据矛盾时标 needsReview，不自动当成高度相关。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { compareConfig, compareImages, PROMPT_VERSION, VERDICTS } from "../../server/vision/multimodalCompare.js";
import { budgetStatus } from "../../server/security/budget.mjs";
import { AnalysisCache, cacheKey } from "./analysis-cache.mjs";
import { library, searchCombined, passMedia } from "../../src/services/features/visualSearch.js";

/** 一个用户查询允许的最大上游请求数。 */
export const MAX_UPSTREAM_PER_QUERY = 1;

/** 判定档位中的「可展示」集合：unrelated 一律不进推荐。 */
const SHOWABLE = new Set([VERDICTS.HIGH, VERDICTS.PARTIAL]);

function readPersonalRecord(id, root) {
  const dir = path.join(root, ".rc1-user-library/records");
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return null; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (rec.id === id) return rec;
    } catch { /* 单条坏记录不影响其余 */ }
  }
  return null;
}

/** 取条目对应的真实图片字节。不存在的返回 null，由调用方决定怎么报。 */
function imageBytesFor(entry, root) {
  try {
    if (entry.personal) {
      const rec = readPersonalRecord(entry.id, root);
      if (!rec || !rec.storedName) return null;
      return fs.readFileSync(path.join(root, ".rc1-user-library/images", rec.storedName));
    }
    const dir = entry.kind === "film" ? "film" : "artworks";
    return fs.readFileSync(path.join(root, "public/assets", dir, entry.id, "preview.webp"));
  } catch {
    return null;
  }
}

const b64 = (buf) => buf.toString("base64");
const hashOf = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** 与证据自相矛盾的判定 → 打上待核实，而不是直接采信。 */
export function reviewFlags(j) {
  const flags = [];
  const concrete = j.similarPoints?.length || 0;
  if (j.verdict === VERDICTS.HIGH && !j.borrowableForCreation) flags.push("high 但未给出可迁移方法");
  if (SHOWABLE.has(j.verdict) && concrete === 0) flags.push("可展示档位却没有具体相似点");
  if (j.verdict === VERDICTS.UNRELATED && concrete >= 2) flags.push("判定无关却列出两处以上具体相似点");
  if (j.verdict === VERDICTS.PARTIAL && !j.borrowableForCreation) flags.push("partial 但无可迁移方法");
  if (j.downgraded) flags.push(`模型自报 ${j.verdictFromModel} 被降级为 ${j.verdict}`);
  return flags;
}

/** 把模型判定整理成产品字段（STEP 3 要求的六个）。 */
export function toProductJudgment(j) {
  const flags = reviewFlags(j);
  return {
    relation: j.verdict,
    compositionEvidence: j.compositionEvidence || (j.similarPoints?.find((s) => /构图|骨架|位置|重心|排列|竖向|横向/.test(s)) ?? null),
    subjectRelationEvidence: j.subjectRelationEvidence || j.figureOrganization || null,
    colorLightEvidence: j.colorLightEvidence || [j.borrowableColor, j.borrowableLight].filter(Boolean).join("；") || null,
    importantDifferences: j.majorDifferences || [],
    creativeTransfer: j.borrowableForCreation || null,
    confidenceLimitations: [
      ...(j.unknown?.length ? [`模型自述无法确定：${j.unknown.join("、")}`] : []),
      ...(j.downgradeNote ? [j.downgradeNote] : []),
      "单次模型判断，未经人工复核",
    ],
    needsReview: flags.length > 0,
    reviewFlags: flags,
    verdictFromModel: j.verdictFromModel,
    similarPoints: j.similarPoints || [],
  };
}

/** Mock：确定性假判定，用于打通链路。明确标注，不冒充真实结果。 */
function mockJudgments(candidates) {
  return candidates.map((c, i) => {
    const h = crypto.createHash("sha256").update(String(c.id)).digest()[0];
    const bucket = h % 3;
    const verdict = bucket === 0 ? VERDICTS.HIGH : bucket === 1 ? VERDICTS.PARTIAL : VERDICTS.UNRELATED;
    return {
      index: i,
      verdict,
      verdictFromModel: verdict,
      downgraded: false,
      downgradeNote: null,
      similarPoints: verdict === VERDICTS.UNRELATED ? [] : ["[MOCK] 竖向构图，主体占据画面中下部"],
      compositionEvidence: verdict === VERDICTS.UNRELATED ? null : "[MOCK] 竖向并列骨架",
      subjectRelationEvidence: null,
      colorLightEvidence: null,
      figureOrganization: null,
      borrowableLight: null,
      borrowableColor: null,
      borrowableSpace: null,
      majorDifferences: verdict === VERDICTS.UNRELATED ? ["[MOCK] 形制完全不同"] : [],
      borrowableForCreation: verdict === VERDICTS.HIGH ? "[MOCK] 可借鉴竖向构图" : null,
      unknown: ["[MOCK] 全部字段为占位"],
    };
  });
}

/**
 * 主入口。一次调用 = 最多一次上游请求。
 * @param {object} opts
 * @param {object} opts.queryEntry  查询条目（含 vector / structure / id / hash / kind / personal）
 * @param {object[]} [opts.extraEntries] 个人图库条目（参与召回）
 * @param {string} [opts.media] 媒介（all/artwork/film/animation/anime），硬过滤
 * @param {number} [opts.judgeCount] 送进模型比较的候选数（默认 3）
 * @param {number} [opts.recallCount] 本地召回池大小（默认 8）
 * @param {string} opts.root 仓库根
 * @param {string} opts.cacheDir 缓存目录（本地忽略目录）
 * @param {boolean} [opts.mock] 强制 Mock（不联网、不计费）
 */
export async function visionSearch(opts) {
  const {
    queryEntry, extraEntries = [], media = "all", judgeCount = 3, recallCount = 8,
    root, cacheDir, mock = false,
  } = opts;

  const cfg = compareConfig();
  const forceMock = mock || process.env.VISION_MOCK === "1";

  if (!queryEntry || !Array.isArray(queryEntry.vector) || !queryEntry.vector.length) {
    return { ok: false, error: "no-query-vector", detail: "查询图没有可用的视觉向量" };
  }

  // 1) 本地召回 + 媒介硬过滤
  const recalled = searchCombined(queryEntry.vector, queryEntry.structure, {
    media, limit: recallCount, excludeId: queryEntry.id, extraEntries,
  }).results.filter((e) =>
    passMedia(e, media) &&
    // 只有两边都真有 hash 时才按内容去重。基础馆藏条目没有 hash，
    // 直接比 `undefined !== undefined` 会把整个候选池滤空。
    !(queryEntry.hash && e.hash && e.hash === queryEntry.hash)
  );

  if (!recalled.length) {
    return {
      ok: true, mode: forceMock ? "mock" : "vision", query: summarizeEntry(queryEntry),
      accepted: [], rejected: [], judged: [], recallCount: 0,
      reason: media === "all" ? "库里没有可比较的候选" : `「${mediaLabelOf(media)}」下没有可比较的候选`,
      accounting: { upstreamCalls: 0, cacheHit: false, maxUpstreamPerQuery: MAX_UPSTREAM_PER_QUERY },
    };
  }

  const candidates = recalled.slice(0, Math.max(1, judgeCount));

  // 2) 取真实图片字节（上传查询由调用方直接给字节，避免再从磁盘找路径）
  const queryBuf = opts.queryBytes || imageBytesFor(queryEntry, root);
  if (!queryBuf) return { ok: false, error: "query-image-missing", detail: "读不到查询图" };
  const withBytes = candidates.map((c) => ({ entry: c, buf: imageBytesFor(c, root) }));
  const usable = withBytes.filter((x) => x.buf);
  const droppedNoBytes = withBytes.filter((x) => !x.buf).map((x) => ({ id: x.entry.id, title: x.entry.title, reason: "图片文件缺失，未送入比较" }));

  if (!usable.length) {
    return { ok: false, error: "no-candidate-images", detail: "候选图片全部读取失败", rejected: droppedNoBytes };
  }

  // 3) 缓存：同查询同候选同模型同提示版本 → 0 次上游请求
  const cache = new AnalysisCache(cacheDir);
  const key = cacheKey(
    Buffer.concat([queryBuf, ...usable.map((u) => u.buf)]),
    { model: forceMock ? `mock:${PROMPT_VERSION}` : cfg.model, promptVersion: PROMPT_VERSION }
  );
  const hit = cache.get(key);
  if (hit && hit.payload?.ok) {
    return finish(hit.payload, usable, droppedNoBytes, {
      mode: forceMock ? "mock" : "vision", queryEntry, cacheHit: true, callId: hit.callId, upstreamCalls: 0, cfg,
    });
  }

  // 4) 一次上游请求（Mock 则完全不联网）
  let result;
  if (forceMock) {
    result = { ok: true, judgments: mockJudgments(usable.map((u) => u.entry)), usage: null, model: "mock", latencyMs: 0, raw: "[MOCK]" };
  } else {
    if (!cfg.configured) {
      return { ok: false, error: "provider-not-configured", detail: "服务端未配置视觉模型" };
    }
    const budget = budgetStatus(cfg.budget);
    const counters = budget.counters || budget;
    if (cfg.budget.dailyLimit > 0 && counters.daily >= cfg.budget.dailyLimit) {
      return {
        ok: false, error: "budget-exhausted",
        detail: `今日预算已用尽（${counters.daily}/${cfg.budget.dailyLimit}），未发出请求`,
        accounting: { upstreamCalls: 0, maxUpstreamPerQuery: MAX_UPSTREAM_PER_QUERY },
      };
    }
    result = await compareImages({
      queryImage: { b64: b64(queryBuf), mime: "image/webp" },
      candidates: usable.map((u) => ({ b64: b64(u.buf), mime: "image/webp" })),
      config: cfg,
      reserve: true,
      question: "判断每张候选对以这张查询图为构图/光线/空间参考的 AIGC 创作是否有实际借鉴价值。",
    });
  }

  if (!result.ok) {
    return {
      ok: false, error: result.error, detail: result.detail, status: result.status,
      accounting: { upstreamCalls: forceMock ? 0 : 1, maxUpstreamPerQuery: MAX_UPSTREAM_PER_QUERY, latencyMs: result.latencyMs },
    };
  }

  const payload = {
    ok: true,
    model: result.model,
    promptVersion: PROMPT_VERSION,
    usage: result.usage,
    latencyMs: result.latencyMs,
    judgments: result.judgments,
    raw: result.raw,
    mock: forceMock,
  };
  const rec = cache.put(key, {
    kind: "compare", model: payload.model, promptVersion: PROMPT_VERSION,
    imageHash: hashOf(queryBuf), payload, rawText: result.raw,
    meta: { usage: result.usage || null, latencyMs: result.latencyMs || null, candidates: usable.map((u) => u.entry.id) },
  });

  return finish(payload, usable, droppedNoBytes, {
    mode: forceMock ? "mock" : "vision", queryEntry,
    cacheHit: false, callId: rec.callId, upstreamCalls: forceMock ? 0 : 1, cfg,
  });
}

function finish(payload, usable, droppedNoBytes, ctx) {
  const judged = [];
  const accepted = [];
  const rejected = [];

  payload.judgments.forEach((j, i) => {
    const entry = usable[i]?.entry;
    if (!entry) return;
    const p = toProductJudgment(j);
    const row = {
      id: entry.id,
      title: entry.title,
      creator: entry.creator,
      year: entry.year,
      image: entry.personal ? `/api/user-media/${encodeURIComponent(entry.id)}` : `/assets/${entry.kind === "film" ? "film" : "artworks"}/${entry.id}/preview.webp`,
      media: mediaLabelOf(entry),
      relation: p.relation,
      ...p,
    };
    judged.push(row);
    if (SHOWABLE.has(p.relation) && !p.needsReview) accepted.push(row);
    else if (SHOWABLE.has(p.relation) && p.needsReview) { row.needsReview = true; accepted.push(row); }
    else rejected.push({ id: row.id, title: row.title, image: row.image, relation: p.relation, reasons: row.importantDifferences, reviewFlags: row.reviewFlags });
  });

  const budget = ctx.cfg ? budgetStatus(ctx.cfg.budget) : null;
  const counters = budget ? budget.counters || budget : null;

  return {
    ok: true,
    mode: ctx.mode,
    mock: payload.mock === true,
    query: summarizeEntry(ctx.queryEntry),
    judged,
    accepted,
    rejected: [...rejected, ...droppedNoBytes.map((d) => ({ ...d, relation: "unknown", reasons: [d.reason], reviewFlags: [] }))],
    accounting: {
      upstreamCalls: ctx.upstreamCalls,
      maxUpstreamPerQuery: MAX_UPSTREAM_PER_QUERY,
      cacheHit: ctx.cacheHit,
      callId: ctx.callId,
      model: payload.model,
      promptVersion: payload.promptVersion,
      latencyMs: payload.latencyMs ?? null,
      usage: payload.usage ?? null,
      budget: counters && ctx.cfg ? { used: counters.daily, limit: ctx.cfg.budget.dailyLimit, totalUsed: counters.total, totalLimit: ctx.cfg.budget.totalLimit } : null,
    },
  };
}

function summarizeEntry(e) {
  if (!e) return null;
  return {
    id: e.id, title: e.title, creator: e.creator, year: e.year,
    media: mediaLabelOf(e),
    image: e.personal ? `/api/user-media/${encodeURIComponent(e.id)}` : `/assets/${e.kind === "film" ? "film" : "artworks"}/${e.id}/preview.webp`,
  };
}

const MEDIA_LABEL = { all: "全部", artwork: "绘画", film: "彩色电影", animation: "动画", anime: "日本动漫" };
export function mediaLabelOf(m) {
  if (typeof m === "string") return MEDIA_LABEL[m] || m;
  if (!m) return "未知";
  const f = m.media?.visualForm;
  if (f === "animation") return "动画";
  if (m.kind === "film" || m.media?.medium === "film") return "彩色电影";
  return "绘画";
}

export { library };
