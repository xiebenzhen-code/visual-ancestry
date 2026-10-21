// vision-search.mjs — P4.15 多模态检索链（实验）
//
// 本地召回只负责「找候选」，不负责「决定推荐」。
// 决定权交给一次多图比较：查询图与候选图进同一个上游请求，模型逐张给出
// 构图 / 主体关系 / 色彩光线三类证据与差异，再由这里分档、剔除无关项。
//
// 三条硬约束：
//   1. 一个用户操作最多 1 次上游请求（MAX_UPSTREAM_PER_QUERY），不自动重试。
//   2. 媒介过滤发生在模型之前，且是硬过滤。
//   3. 模型自报与证据矛盾时标 needsReview，不自动当成高度相关。
//
// P4.15.1 新增：
//   · 多路召回（向量 / 结构 / 可观察语义）+ RRF 融合，每条候选带来源与理由
//   · overall-reference 与 specific-reference 分级：只有色彩光线关联的，
//     不得宣称构图相关
//   · 每条响应带 requestId；失败也带 requestId，便于对账
//   · 升提示词后旧缓存仍可回放（标记 stalePrompt，不覆盖历史）

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { compareConfig, compareImages, PROMPT_VERSION, VERDICTS } from "../../server/vision/multimodalCompare.js";
import { budgetStatus } from "../../server/security/budget.mjs";
import { AnalysisCache, cacheKey } from "./analysis-cache.mjs";
import { library, searchCombined, passMedia, mediaLabel } from "../../src/services/features/visualSearch.js";
import { multipathRecall, selectForComparison } from "./recall-multipath.mjs";
import { buildSemanticTable, semanticDiscover } from "./semantics.mjs";

/** 一个用户查询允许的最大上游请求数。 */
export const MAX_UPSTREAM_PER_QUERY = 1;

const SHOWABLE = new Set([VERDICTS.HIGH, VERDICTS.PARTIAL]);

/** 比较集上限：允许 5–6 张候选做后续多图判断。 */
export const MAX_COMPARE_CANDIDATES = 6;

let semanticTableCache = null;
function semanticTable(root) {
  if (semanticTableCache) return semanticTableCache;
  try {
    semanticTableCache = buildSemanticTable({
      cacheDir: path.join(root, ".rc1-audit/p415/cache"),
      statePath: path.join(root, ".rc1-audit/p415/preflight-state.json"),
      fixturesPath: path.join(root, "experiment/p415/fixtures/pinned-cases.json"),
      analysesDir: path.join(root, ".rc1-audit/p415/v2-analyses"),
    });
  } catch {
    semanticTableCache = { profiles: new Map(), derivedQueries: new Map(), stats: {} };
  }
  return semanticTableCache;
}

export const newRequestId = () => `req-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;

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

/**
 * 参考作用域：整体参考 vs 局部方法参考。
 *
 * P4.15.4 修正：不再用 compositionEvidence / subjectRelationEvidence /
 * colorLightEvidence 判断“覆盖了哪些维度”——这三个字段描述的是**某一张图的样子**
 * （有时是查询、有时是候选），不是「两张图共享什么」。拿它们当证据会导致
 * 每个候选都“有证据”，从而永远 partial。
 * 现在只认 positiveDims：由相似点经差异证伪后剩下的维度（见 relationTier.js）。
 */
export function referenceScope(j) {
  const dims = Array.isArray(j.positiveDims) ? [...j.positiveDims] : deriveDimsFallback(j);
  if (dims.includes("composition") && (dims.includes("subject") || dims.includes("space"))) {
    return { scope: "overall", dims, limitation: null };
  }
  if (dims.length === 1 && dims[0] === "colorLight") {
    return { scope: "specific", dims, limitation: "只有色彩光线关联，不构成构图或人物关系依据" };
  }
  if (dims.length === 0) return { scope: "none", dims, limitation: "没有经得起差异核对的可迁移证据" };
  return { scope: "partial", dims, limitation: "只覆盖部分维度，不可当作整体构图参考" };
}

/** 老数据没有 positiveDims 时，只按 relation 给一个保守的作用域，不再读描述字段。 */
function deriveDimsFallback(j) {
  // 连一条相似点都没有，就不能凭档位凭空造出维度
  if (!(Array.isArray(j.similarPoints) && j.similarPoints.length)) return [];
  const rel = j.relation || j.verdict || null;
  if (rel === "high") return ["composition", "subject"];
  if (rel === "partial") return ["composition"];
  if (rel === "specific") return ["colorLight"];
  return [];
}

/** 把模型判定整理成产品字段。 */
export function toProductJudgment(j) {
  const flags = reviewFlags(j);
  const scope = referenceScope(j);
  return {
    relation: j.verdict,
    referenceScope: scope.scope,
    scopeDimensions: scope.dims,
    scopeLimitation: scope.limitation,
    compositionEvidence: j.compositionEvidence || (j.similarPoints?.find((s) => /构图|骨架|位置|重心|排列|竖向|横向/.test(s)) ?? null),
    subjectRelationEvidence: j.subjectRelationEvidence || j.figureOrganization || null,
    colorLightEvidence: j.colorLightEvidence || [j.borrowableColor, j.borrowableLight].filter(Boolean).join("；") || null,
    importantDifferences: j.majorDifferences || [],
    creativeTransfer: j.borrowableForCreation || null,
    // 证据裁决留痕：档位是怎么来的、哪些维度被差异推翻
    relationDerived: j.relationDerived || null,
    positiveDimensions: j.positiveDims || null,
    contradictedDimensions: j.contradictedDims || null,
    evidenceNotes: j.evidenceNotes || [],
    confidenceLimitations: [
      ...(j.unknown?.length ? [`模型自述无法确定：${j.unknown.join("、")}`] : []),
      ...(j.downgradeNote ? [j.downgradeNote] : []),
      ...(scope.limitation ? [scope.limitation] : []),
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
    const onlyLight = bucket === 1;
    return {
      index: i,
      verdict,
      verdictFromModel: verdict,
      downgraded: false,
      downgradeNote: null,
      similarPoints: verdict === VERDICTS.UNRELATED ? [] : ["[MOCK] 竖向构图，主体占据画面中下部"],
      compositionEvidence: onlyLight || verdict === VERDICTS.UNRELATED ? null : "[MOCK] 竖向并列骨架",
      subjectRelationEvidence: onlyLight || verdict === VERDICTS.UNRELATED ? null : "[MOCK] 两人正面并立",
      colorLightEvidence: verdict === VERDICTS.UNRELATED ? null : "[MOCK] 低饱和冷调，左前方柔光",
      figureOrganization: null,
      borrowableLight: null, borrowableColor: null, borrowableSpace: null,
      majorDifferences: verdict === VERDICTS.UNRELATED ? ["[MOCK] 形制完全不同"] : [],
      borrowableForCreation: verdict === VERDICTS.UNRELATED ? null : "[MOCK] 可借鉴低饱和冷暖组织",
      unknown: ["[MOCK] 全部字段为占位"],
    };
  });
}

/**
 * 主入口。一次调用 = 最多一次上游请求。
 */
export async function visionSearch(opts) {
  const {
    queryEntry, extraEntries = [], media = "all", judgeCount = 3, recallCount = 12,
    root, cacheDir, mock = false, recallMode = "multipath",
  } = opts;

  const requestId = opts.requestId || newRequestId();
  const cfg = compareConfig();
  const forceMock = mock || process.env.VISION_MOCK === "1";
  const base = { ok: true, requestId, mode: forceMock ? "mock" : "vision" };

  if (!queryEntry || !Array.isArray(queryEntry.vector) || !queryEntry.vector.length) {
    return { ...base, ok: false, error: "no-query-vector", detail: "查询图没有可用的视觉向量" };
  }

  // 1) 召回（多路融合 / 单路旧模式）
  let recalled = [];
  let recallPaths = null;
  if (recallMode === "legacy") {
    recalled = searchCombined(queryEntry.vector, queryEntry.structure, {
      media, limit: recallCount, excludeId: queryEntry.id, extraEntries,
    }).results.filter((e) => passMedia(e, media) && !(queryEntry.hash && e.hash && e.hash === queryEntry.hash));
  } else {
    const mp = multipathRecall({
      queryEntry, extraEntries, media, root,
      limit: recallCount, perPath: Math.max(8, recallCount),
    });
    recallPaths = mp.paths;
    recalled = mp.candidates.map((m) => ({
      ...m.entry, fused: m.fused, sources: m.sources, fromPaths: m.fromPaths, vectorTwinOf: m.vectorTwinOf || null,
    })).filter((e) => passMedia(e, media) && !(queryEntry.hash && e.hash && e.hash === queryEntry.hash));
  }

  const recallInfo = {
    mode: recallMode,
    paths: recallPaths,
    returned: recalled.length,
    limit: recallCount,
    candidates: recalled.map((e) => ({
      id: e.id, title: e.title, media: mediaLabel(e),
      fused: e.fused ?? null, fromPaths: e.fromPaths ?? ["combined"], sources: e.sources ?? [],
      vectorTwinOf: e.vectorTwinOf ?? null,
    })),
  };

  // 1b) V2 语义发现：不进 RRF 权重，只负责把「有核实画像且能对上」的候选
  //     重新带回比较集，并标明是哪条路发现的。
  const table = semanticTable(root);
  const queryProfile = table.profiles.get(queryEntry.id) || null;
  const allPool = library().concat(extraEntries).filter((e) => passMedia(e, media) && e.id !== queryEntry.id);
  const candidateProfiles = new Map();
  for (const e of allPool) {
    const p = table.profiles.get(e.id);
    if (p) candidateProfiles.set(e.id, p);
  }
  const disc = queryProfile
    ? semanticDiscover(queryProfile, candidateProfiles, queryEntry.id)
    : { hits: [], skipped: "查询没有已核实的 V2 语义画像" };

  const semanticInfo = {
    queryProfile: queryProfile
      ? {
          available: true, kind: queryProfile.kind, source: queryProfile.source, tokens: queryProfile.tokens,
          // A=独立单图分析；C=从差异文本反推（不得当成看图结论）
          evidenceTier: queryProfile.evidenceTier || null, tierNote: queryProfile.tierNote || null,
        }
      : { available: false, reason: "查询未做过单图 V2 分析，也没有可归因的历史比较" },
    tableStats: table.stats,
    hits: disc.hits || [],
    skipped: disc.skipped || null,
    skippedTierC: disc.skippedTierC || 0,
    skippedTierB: disc.skippedTierB || 0,
    promotionRule: "只有 A 级独立单图画像可跨查询提升；B 级仅限原始查询-候选对；C 级不参与",
    // 候选侧证据等级：只有 A 才算「这张图自己的属性」，B 只是关系描述
    tierSummary: (disc.hits || []).reduce((acc, h) => {
      const k = h.candidateEvidenceTier || "B";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    unanalyzed: allPool.filter((e) => !table.profiles.has(e.id)).map((e) => e.id),
  };

  // 语义发现到的候选：标记后并入池尾（不参与 RRF 权重）
  // 两种情形都要处理：
  //   a) 完全没被召回 → 作为发现项补入
  //   b) 被召回了但排在 top-N 之外 → 作为「提升项」补入，否则永远比不到
  const judgeN = Math.max(1, judgeCount);
  const fusedIds = new Set(recalled.map((e) => e.id));
  const topIds = new Set(recalled.slice(0, judgeN).map((e) => e.id));
  const semanticOnly = [];
  const promoted = [];
  for (const h of semanticInfo.hits) {
    if (fusedIds.has(h.id)) {
      const r = recalled.find((e) => e.id === h.id);
      r.semanticDiscovery = {
        matchedDimensions: h.matchedDimensions, evidence: h.evidence,
        candidateEvidenceTier: h.candidateEvidenceTier || "B",
        candidateAnalysisUnavailable: !!h.candidateAnalysisUnavailable,
        limitation: h.limitation || null,
      };
      // 召回内低位：只有 A 级独立画像才允许提升（只改比较集，不改融合名次）
      if (!topIds.has(h.id) && h.eligibleForPromotion) {
        r.semanticDiscovery.promotion = {
          tier: h.candidateEvidenceTier,
          reason: "A 级独立画像与查询在多个维度共享强证据",
          originalRank: recalled.findIndex((e) => e.id === h.id) + 1,
          matchedDimensions: h.matchedDimensions,
        };
        promoted.push(r);
      }
      continue;
    }
    const e = allPool.find((x) => x.id === h.id);
    if (!e) continue;
    semanticOnly.push({
      ...e, fused: null, fromPaths: ["semantic"], sources: [{ path: "semantic", rank: semanticOnly.length + 1, score: h.matchedDimensions.length, reason: h.evidence.map((x) => `${x.dim}:${x.tokens.join("/")}`).join("；") }],
      semanticDiscovery: {
        matchedDimensions: h.matchedDimensions, evidence: h.evidence,
        candidateEvidenceTier: h.candidateEvidenceTier || "B",
        candidateAnalysisUnavailable: !!h.candidateAnalysisUnavailable,
        limitation: h.limitation || null,
      },
    });
  }
  semanticInfo.broughtIn = semanticOnly.map((s) => s.id);
  semanticInfo.promotedFromRecall = promoted.map((s) => s.id);
  semanticInfo.promotionLog = promoted.map((s) => ({
    id: s.id,
    tier: s.semanticDiscovery?.promotion?.tier || null,
    reason: s.semanticDiscovery?.promotion?.reason || null,
    originalRank: s.semanticDiscovery?.promotion?.originalRank ?? null,
    matchedDimensions: s.semanticDiscovery?.promotion?.matchedDimensions || [],
  }));

  if (!recalled.length) {
    return {
      ...base, query: summarizeEntry(queryEntry), accepted: [], rejected: [], judged: [],
      recall: recallInfo, semantic: semanticInfo, recallCount: 0,
      reason: media === "all" ? "库里没有可比较的候选" : `「${mediaLabelOf(media)}」下没有可比较的候选`,
      accounting: { requestId, upstreamCalls: 0, cacheHit: false, maxUpstreamPerQuery: MAX_UPSTREAM_PER_QUERY },
    };
  }

  const candidates = recallMode === "legacy"
    ? recalled.slice(0, judgeN)
    : selectForComparison(recalled, judgeN, [...promoted, ...semanticOnly]);

  recallInfo.compared = candidates.map((c) => c.id);
  for (const p of semanticInfo.promotionLog || []) p.finalSlot = recallInfo.compared.indexOf(p.id);
  recallInfo.selection = recallMode === "legacy"
    ? "top-n"
    : `fused-top-${judgeN}` + (candidates.some((c) => c.semanticDiscovery) ? "+语义发现" : "");

  // 2) 取真实图片字节
  const queryBuf = opts.queryBytes || imageBytesFor(queryEntry, root);
  if (!queryBuf) return { ...base, ok: false, error: "query-image-missing", detail: "读不到查询图" };
  const withBytes = candidates.map((c) => ({ entry: c, buf: imageBytesFor(c, root) }));
  const usable = withBytes.filter((x) => x.buf);
  const droppedNoBytes = withBytes.filter((x) => !x.buf)
    .map((x) => ({ id: x.entry.id, title: x.entry.title, reason: "图片文件缺失，未送入比较" }));

  if (!usable.length) {
    return { ...base, ok: false, error: "no-candidate-images", detail: "候选图片全部读取失败", rejected: droppedNoBytes, requestId };
  }

  // 3) 缓存：内容键不含模型/提示版本，便于升级后回放旧结果
  const cache = new AnalysisCache(cacheDir);
  const contentKey = hashOf(Buffer.concat([queryBuf, ...usable.map((u) => u.buf)]));
  const modelKey = forceMock ? `mock:${PROMPT_VERSION}` : cfg.model;
  const key = `${contentKey}|${modelKey}|${PROMPT_VERSION}`;

  const hit = cache.get(key);
  if (hit && hit.payload?.ok) {
    return finish(hit.payload, usable, droppedNoBytes, {
      ...base, queryEntry, cacheHit: true, callId: hit.callId, upstreamCalls: 0, cfg, recallInfo, semanticInfo,
      promptVersionUsed: hit.promptVersion,
    });
  }

  // 旧版本回放：内容相同、模型相同、提示版本更旧 → 明确标记后再用
  const fallback = cache.findByContent(contentKey, { model: modelKey, excludePromptVersion: PROMPT_VERSION });
  if (fallback && fallback.payload?.ok) {
    return finish(fallback.payload, usable, droppedNoBytes, {
      ...base, queryEntry, cacheHit: true, callId: fallback.callId, upstreamCalls: 0, cfg, recallInfo, semanticInfo,
      promptVersionUsed: fallback.promptVersion, stalePrompt: true,
    });
  }

  // 4) 一次上游请求（Mock 则完全不联网）
  let result;
  if (forceMock) {
    result = { ok: true, judgments: mockJudgments(usable.map((u) => u.entry)), usage: null, model: "mock", latencyMs: 0, raw: "[MOCK]", finishReason: "stop" };
  } else {
    if (!cfg.configured) {
      return { ...base, ok: false, error: "provider-not-configured", detail: "服务端未配置视觉模型", requestId };
    }
    const budget = budgetStatus(cfg.budget);
    const counters = budget.counters || budget;
    if (cfg.budget.dailyLimit > 0 && counters.daily >= cfg.budget.dailyLimit) {
      return {
        ...base, ok: false, error: "budget-exhausted",
        detail: `今日预算已用尽（${counters.daily}/${cfg.budget.dailyLimit}），未发出请求`,
        accounting: { requestId, upstreamCalls: 0, maxUpstreamPerQuery: MAX_UPSTREAM_PER_QUERY },
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
      ...base, ok: false, error: result.error, detail: result.detail, status: result.status, requestId,
      // 失败也把请求上下文带上，便于对账（不含图片与密钥）
      context: { queryId: queryEntry.id, media, candidates: usable.map((u) => u.entry.id), model: cfg.model, promptVersion: PROMPT_VERSION },
      accounting: { requestId, upstreamCalls: forceMock ? 0 : 1, maxUpstreamPerQuery: MAX_UPSTREAM_PER_QUERY, latencyMs: result.latencyMs },
    };
  }

  const payload = {
    ok: true,
    model: result.model,
    promptVersion: PROMPT_VERSION,
    usage: result.usage,
    latencyMs: result.latencyMs,
    finishReason: result.finishReason || null,
    judgments: result.judgments,
    raw: result.raw,
    mock: forceMock,
  };
  const rec = cache.put(key, {
    kind: "compare", model: payload.model, promptVersion: PROMPT_VERSION,
    contentKey, imageHash: hashOf(queryBuf), payload, rawText: result.raw,
    meta: {
      usage: result.usage || null, latencyMs: result.latencyMs || null,
      finishReason: payload.finishReason,
      candidates: usable.map((u) => u.entry.id),
    },
  });

  return finish(payload, usable, droppedNoBytes, {
    ...base, queryEntry, cacheHit: false, callId: rec.callId, upstreamCalls: forceMock ? 0 : 1, cfg, recallInfo, semanticInfo,
    promptVersionUsed: PROMPT_VERSION,
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
      media: mediaLabel(entry),
      relation: p.relation,
      referenceScope: p.referenceScope,
      scopeDimensions: p.scopeDimensions,
      scopeLimitation: p.scopeLimitation,
      recall: {
        fused: entry.fused ?? null,
        fromPaths: entry.fromPaths || [],
        sources: entry.sources || [],
        vectorTwinOf: entry.vectorTwinOf || null,
      },
      ...p,
    };
    judged.push(row);
    if (SHOWABLE.has(p.relation)) accepted.push(row);
    else rejected.push({
      id: row.id, title: row.title, image: row.image, relation: p.relation,
      reasons: row.importantDifferences, reviewFlags: row.reviewFlags,
      recall: row.recall,
    });
  });

  const budget = ctx.cfg ? budgetStatus(ctx.cfg.budget) : null;
  const counters = budget ? budget.counters || budget : null;

  return {
    ok: true,
    requestId: ctx.requestId,
    mode: ctx.mode,
    mock: payload.mock === true,
    query: summarizeEntry(ctx.queryEntry),
    recall: ctx.recallInfo || null,
    semantic: ctx.semanticInfo || null,
    judged,
    accepted,
    rejected: [...rejected, ...droppedNoBytes.map((d) => ({ ...d, relation: "unknown", reasons: [d.reason], reviewFlags: [] }))],
    accounting: {
      requestId: ctx.requestId,
      upstreamCalls: ctx.upstreamCalls,
      maxUpstreamPerQuery: MAX_UPSTREAM_PER_QUERY,
      cacheHit: ctx.cacheHit,
      callId: ctx.callId,
      promptVersion: ctx.promptVersionUsed || payload.promptVersion,
      stalePrompt: ctx.stalePrompt === true,
      model: payload.model,
      finishReason: payload.finishReason ?? null,
      latencyMs: payload.latencyMs ?? null,
      usage: payload.usage ?? null,
      budget: counters && ctx.cfg ? {
        used: counters.daily, limit: ctx.cfg.budget.dailyLimit,
        totalUsed: counters.total, totalLimit: ctx.cfg.budget.totalLimit,
      } : null,
    },
  };
}

function summarizeEntry(e) {
  if (!e) return null;
  return {
    id: e.id, title: e.title, creator: e.creator, year: e.year,
    media: mediaLabel(e),
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
