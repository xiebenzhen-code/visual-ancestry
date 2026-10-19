// remoteReferences.js — 把远程渠道发现接到 FIND 结果里。
//
// 设计约束（不可放宽）：
// 1. 本模块**不改动** retrieveByIntent / scoreIntent / curatedPool。本地检索
//    与评分器的行为必须与接入远程渠道之前逐字节一致——远程只做加法。
// 2. 远程渠道是异步的，而 retrieveByIntent 是同步的。所以远程结果**不进
//    评分器**：它们由渠道自己的查询返回，附带 matchChannelMetadata() 给出的
//    文本匹配分。混进评分器会让「远程件也能被本地 intent 排序」变成假象。
// 3. 证据语义严格分离：远程件 analysisLevel=0，没有视觉分析。
//    matchChannelMetadata() 的依据是馆方分类字段（provenance=
//    channel-metadata-text），与「模型看过这张画」是两回事，标签必须说清。
// 4. 渠道故障时如实返回 degraded，不静默返回空数组——页面要能解释
//    「为什么远程没有结果」，而不是让用户以为远程没有作品。

import { searchRemote, searchRemoteWithStatus } from "../artService.js";
import {
  discoverPaintingReferences,
  discoverCommonsFilmStills,
  matchChannelMetadata,
} from "../source/remoteDiscovery.js";
import { rerankWithVision } from "../source/filmVisionRerank.js";
import { applyCorrections } from "./filmCorrections.js";

// 远程参考的展示上限。本地池仍然优先——远程是补充，不是替代。
const REMOTE_ARTWORK_LIMIT = 8;
const REMOTE_FILM_LIMIT = 6;

// 把一条远程绘画参考转成 FIND 结果项的统一形状。
// 与 retrieveByIntent 返回的 { artwork, retrievalScore, reasons, … } 同形，
// 但 artwork 带 remote 标记，页面据此渲染「馆方分类」而不是「视觉分析」。
function paintingItem(ref, query) {
  const matched = matchChannelMetadata(ref, query);
  return {
    artwork: {
      key: `remote:${ref.channel}:${ref.sourceId}`,
      title: ref.title,
      artist: ref.artist || ref.channelName || "",
      year: ref.year || "",
      image: ref.image || null,
      imageUnavailable: !ref.showable,
      medium: "artwork",
      // analysisLevel 0 + 空 intent 字段：评分器读到的远程件是空的，
      // 这是事实，不靠补值掩盖。
      analysisLevel: 0,
      remote: {
        channel: ref.channel,
        channelName: ref.channelName,
        sourceUrl: ref.sourceUrl,
        rights: ref.rights,
        showable: ref.showable,
      },
    },
    medium: "artwork",
    retrievalScore: matched.score,
    reasons: matched.reasons,
    intent: null,
    intentProvenance: "channel-metadata",
    // 依据来自馆方分类字段，不是模型看过这张图。页面必须原样传达。
    remoteProvenance: matched.provenance,
    remoteNote: matched.note || "",
  };
}

// 电影渠道的相关性依据（STEP 2）。
//
// 不能再用 matchChannelMetadata 来给电影候选打分：它是拿渠道的**英文**文本字段
// 去比用户输入，用户写「冷色、孤独、空旷街道」时恒为 0 分 —— 于是所有候选
// 都被丢掉。这是实测到的第二重零召回原因（第一重是检索与过滤策略互相打架）。
//
// 电影候选的相关性来自「**被哪个检索词召回、命中在什么位置**」，这才是这类渠道
// 真正能给出的依据，并且必须如实分级：描述/类目命中比仅片名撞词可信得多。
const FILM_LOCATION_LABEL = {
  description: "文件描述",
  category: "Commons 类目",
  "description+category": "文件描述与类目",
  "title-only": "仅片名",
  none: "未命中",
};

// 导出供验收脚本读取：让 QA 用**产品同一个函数**判定相关性，而不是复刻一份逻辑。
// 复刻的风险是两边悄悄分叉，然后「验收通过但线上不对」。
// P4.9 收尾 — 展示资格分级。
//
// 任务书的核心约束：**片名查询允许以片名匹配召回；图片与视觉描述查询
// 不能仅因片名命中就获得视觉相似推荐资格。**
//
// 这不是一个布尔开关能解决的事，因为有三类查询 × 两类召回依据：
//   查询侧：proper-noun（片名透传） / multi-concept（视觉概念） / 图片 VisualIntent
//   召回侧：title-only（仅片名撞词）     / description|category（元数据命中）
//
// 分级规则（与 visualStatusFor 的语义对齐，但以展示为目的）：
//   primary   — 可以出现在正式参考列表：
//               · 片名查询的一切结果（用户就是在找这部片）
//               · 视觉查询中**描述/类目命中**的（元数据文字确实描述了该概念）
//   exploratory — 只能进「更多电影线索」收起区：
//               · 视觉查询中**仅片名撞词**的（The Crowd ≠ 画面有人群）
//
// 另外一条硬规则：本产品**从未分析过任何一张远程候选图**（无付费 Vision），
// 所以 primary 也绝不宣称「视觉匹配成功」，只说「元数据匹配」。
export function classifyFilmDisplay(item) {
  const art = item.artwork || {};
  const rb = art.recallBasis || {};
  const strategy = rb.strategy || null;
  const matched = rb.matched || [];
  const titleOnlyOnly = matched.length > 0 && matched.every((m) => m.location === "title-only");
  const visualVerified = art.analysisLevel === 1; // 只有真的分析过图像才可能为 true

  // 图片 VisualIntent 查询永远不算片名查询：它没有「用户输入的片名」。
  const isProperNounQuery = strategy === "proper-noun";

  let tier = "primary";
  let reason = "";
  if (!isProperNounQuery && titleOnlyOnly) {
    tier = "exploratory";
    reason = "仅片名撞词，画面相似性未验证";
  } else if (isProperNounQuery) {
    reason = "片名匹配（你查询了这部电影）";
  } else {
    reason = "元数据命中（描述或类目提到该概念）";
  }

  return {
    tier,
    reason,
    // 一律不宣称视觉匹配成功：没有分析过图像就没有这个资格。
    visualMatchStatus: visualVerified ? "verified" : "unverified",
    isProperNounQuery,
    titleOnlyOnly,
  };
}
export function filmMatchBasis(ref) {
  const rb = ref.recallBasis || {};
  const matched = rb.matched || [];
  if (!matched.length) {
    return { score: 0, reasons: ["未被任何检索词召回"], provenance: "channel-file-name-metadata" };
  }
  const strong = matched.filter((m) => m.location !== "title-only");
  const titleOnly = matched.length - strong.length;
  const parts = matched.map(
    (m) =>
      `「${m.term}」命中${FILM_LOCATION_LABEL[m.location] || m.location}（来源：${m.source}${
        m.matchedToken && m.matchedToken !== m.term ? `，对应你的词「${m.matchedToken}」` : ""
      }）`
  );
  const reasons = [parts.join("；")];
  if (titleOnly) reasons.push(`其中 ${titleOnly} 个仅片名撞词，画面是否如此**未验证**`);
  if ((rb.unmapped || []).length) reasons.push(`未参与检索的词：${rb.unmapped.join("、")}`);
  return {
    // 片名查询（proper-noun）是正常召回，给最高分；视觉描述里描述/类目命中最强，
    // 仅片名撞词只给最低分。
    score: rb.strategy === "proper-noun" ? 3 : strong.length ? 3 : 1,
    reasons,
    provenance: "channel-file-name-metadata",
  };
}

// Commons 电影画面 → 同一形状。
// MEASURED 契约（读 remoteDiscovery.js 实测确认，不是猜的）：
//   · 导演字段名是 `director`（Commons 元数据本身没有导演；本轮起由 Wikidata
//     具名核实后填入，仍拿不到就是 null），不是 `artist`。
//   · 没有 `thumbnail` 字段，缩略图由 image.url 走 iiurlwidth 在页面层取。
//   · 失败时返回 { error } 而非抛错。
// 导演未知时显示「导演未知」——不拿上传者冒充。
function filmItem(ref, query) {
  const matched = filmMatchBasis(ref);
  const directorLabel = ref.director || "未知（Commons/Wikidata 均未确证）";
  const axes = ref.verification?.axes || [];
  const pickAxis = (name) => axes.find((a) => a.axis === name) || null;
  const still = {
    id: `remote-film:${ref.sourceId}`,
    // 去重键。实测踩过：这里原本没有 key，于是 findRemoteReferences 的
    // 跨渠道去重 `seen.has(item.artwork.key)` 对所有电影候选都拿到 undefined，
    // 第二张卡起全部被当成重复项丢掉 —— 界面上永远只有 1 张电影卡，
    // 而渠道摘要还在报 termTally=5。两处数字对不上就是这个原因。
    key: `remote-film:${ref.channel}:${ref.sourceId}`,
    title: ref.title || ref.sourceId || "",
    year: ref.year || "",
    image: ref.showable ? ref.image || null : null,
    imageUnavailable: !ref.showable,
    medium: "film",
    film: {
      titleZh: ref.title || ref.sourceId || "",
      title: ref.title || ref.sourceId || "",
      director: directorLabel,
      directorZh: directorLabel,
      year: ref.year || "",
      rights: {
        licenseShortName: ref.rights?.licenseShortName || ref.rights?.license || "Commons",
        sourceUrl: ref.sourceUrl || "",
        verified: true,
        verifiedAt: ref.rightsVerifiedAt || null,
      },
    },
    // STEP 2/3：图像性质与三轴核验状态随候选下发，由界面原样显示。
    imageKind: ref.imageKind || "unknown",
    imageKindLabel: ref.imageKindLabel || "图像性质未标注",
    imageKindStatus: ref.imageKindStatus || "unverified",
    // 召回依据与视觉验证状态。没有图像分析时只能是「待视觉核验」，
    // 界面上绝不能出现「已视觉匹配」这类说法。
    recallBasis: ref.recallBasis || null,
    visualStatus: ref.visualStatus || "unverified",
    visualStatusLabel: ref.visualStatusLabel || "未验证（召回依据不足）",
    identity: ref.identity || null,
    verification: ref.verification || null,
    // 图像分析只有在上层真的做了、且成功时才为真值；否则 provenance 明确是元数据。
    intent: ref.intent || null,
    intentProvenance: ref.intentProvenance || "channel-metadata",
    visionError: ref.visionError || null,
    analysisLevel: ref.intent ? 1 : 0,
    remote: {
      channel: ref.channel,
      channelName: ref.channelName,
      sourceId: ref.sourceId,
      sourceUrl: ref.sourceUrl,
      // P4.10 — 内容哈希随候选下发，作为像素特征缓存键（图像变则失效）。
      sha1: ref.sha1 || null,
      byteSize: ref.byteSize || null,
      rights: ref.rights,
      showable: ref.showable,
      verification: ref.verification || null,
      axes: {
        identity: pickAxis("identity"),
        nature: pickAxis("nature"),
        licence: pickAxis("licence"),
      },
      wikidataUrl: ref.identity?.wikidataUrl || null,
      imdbId: ref.identity?.imdbId || null,
    },
    // STEP 4：用户标记过什么（未标记时为空数组）。
    corrections: ref.corrections || [],
  };
  return {
    artwork: still,
    medium: "film",
    retrievalScore: matched.score,
    reasons: matched.reasons,
    intent: ref.intent || null,
    intentProvenance: ref.intentProvenance || "channel-metadata",
    remoteProvenance: matched.provenance,
    remoteNote: matched.note || "",
  };
}

// 查询远程绘画渠道（AIC/Met/Cleveland/Rijks）。
// 契约：永远返回 { results, degraded, note }，不抛错——远程不可用不能
// 影响本地结果，调用方只需要知道该不该向用户解释一句。
export async function findRemotePaintings(query, { media = "all", limit = REMOTE_ARTWORK_LIMIT } = {}) {
  if (!query || !query.trim()) {
    return { results: [], degraded: false, note: "" };
  }
  try {
    const outcome = await discoverPaintingReferences(query, {
      limit,
      searchRemote,
      searchRemoteWithStatus,
    });
    if (outcome.error || outcome.degraded) {
      return {
        results: [],
        degraded: true,
        note: outcome.note || "博物馆渠道暂时不可用，本地检索不受影响。",
      };
    }
    const references = outcome.references || [];
    // 只保留有匹配依据的候选。
    // MEASURED 缺陷：原先只按 showable 过滤，结果「雾 空旷」查询下展示了两件
    // 「匹配分 0、依据为空」的 AIC 作品（Self-Portrait、Desjardins）——它们与
    // 查询毫无关系，却出现在「远程渠道参考」里。展示零分无依据的候选等于
    // 噪声，也违背「与查询无关的候选不得获得虚假相关性」。
    // 无依据的件仍如实计数（metadataOnlyCount），但不进结果列表。
    const scored = references
      .map((ref) => ({ ref, matched: matchChannelMetadata(ref, query) }))
      .filter((x) => x.matched.score > 0)
      .sort((a, b) => b.matched.score - a.matched.score);

    const results = scored
      .filter((x) => x.ref.showable)
      .slice(0, limit)
      .map((x) => paintingItem(x.ref, query));

    return {
      results,
      degraded: false,
      // Some museums answered, some did not: keep the real results and say which
      // sources are missing. This is NOT degradation — claiming "channels down"
      // would hide works we actually got.
      partial: Boolean(outcome.partial),
      note: outcome.partial
        ? `部分来源本次未响应（${(outcome.failedSources || []).join("、")}）；以上为其余来源的结果。`
        : "",
      // 被过滤掉的件数如实告知：用户知道有多少因无依据未列出。
      unrelatedCount: references.filter((r) => r.showable).length - results.length,
    };
  } catch (e) {
    return {
      results: [],
      degraded: true,
      note: `博物馆渠道错误：${String(e?.message || e).slice(0, 80)}。本地检索不受影响。`,
    };
  }
}

// 查询 Commons 电影画面。
//
// STEP 2/3/4 三件事按顺序发生，且每一步都如实上报：
//   1. 元数据召回（Commons）→ 每条带三轴核验（身份/性质/许可）
//   2. 可选的 Vision 分析与重排：默认**不授权**，覆盖率如实为 0
//   3. 应用用户纠正：被排除的件移出列表并计数，被标记的件仍显示标记与证据
export async function findRemoteFilm(query, { media = "all", limit = REMOTE_FILM_LIMIT, vision = {} } = {}) {
  if (!query || !query.trim()) {
    return { results: [], degraded: false, note: "" };
  }
  try {
    const outcome = await discoverCommonsFilmStills(query, { limit });
    if (outcome.error) {
      return {
        results: [],
        degraded: true,
        note: outcome.note || "Commons 电影画面渠道暂时不可用，本地检索不受影响。",
      };
    }
    // 渠道不支持该查询语义（如中文视觉描述）——这不是「没有素材」，
    // 必须如实说明，不能让用户以为查过了确实没有。
    if (outcome.unsupported) {
      return { results: [], degraded: false, note: outcome.note || "", unsupported: true };
    }
    const references = outcome.references || [];
    // STEP 2：相关性依据改为「被哪个检索词召回、命中在什么位置」，
    // 并按可信度排序（描述/类目命中优先于仅片名撞词）。见 filmMatchBasis()。
    const scored = references
      .map((ref) => ({ ref, matched: filmMatchBasis(ref) }))
      .filter((x) => x.matched.score > 0)
      .sort((a, b) => b.matched.score - a.matched.score);

    // STEP 4：先应用用户纠正。被排除的不再展示，但计数必须上报。
    const corrected = applyCorrections(scored.map((x) => x.ref));
    const byId = new Map(scored.map((x) => [x.ref.sourceId, x.matched]));
    const matchedRefs = corrected.references
      .map((ref) => ({ ref, matched: byId.get(ref.sourceId) }))
      .filter((x) => x.matched);

    // STEP 3：Vision 重排（默认未授权 → 直接返回覆盖率 0 与原因）。
    const visionOutcome = await rerankWithVision(matchedRefs.map((x) => x.ref), {
      authorized: Boolean(vision.authorized),
      maxCandidates: vision.maxCandidates ?? 4,
      queryIntent: vision.queryIntent || null,
    });
    const order = new Map(visionOutcome.results.map((r, i) => [r.sourceId, i]));
    const ordered = matchedRefs.slice().sort((a, b) => (order.get(a.ref.sourceId) ?? 99) - (order.get(b.ref.sourceId) ?? 99));

    const results = ordered
      .filter((x) => x.ref.showable)
      .slice(0, limit)
      .map((x) => ({ ...filmItem(x.ref, query), display: classifyFilmDisplay(filmItem(x.ref, query)) }));
    return {
      results,
      degraded: false,
      note: "",
      unsupported: false,
      unrelatedCount: references.filter((r) => r.showable).length - results.length,
      // STEP 2/3/4 的可解释数据，界面与验收都读它。
      verificationTally: outcome.verificationTally || null,
      natureKinds: outcome.natureKinds || null,
      concepts: outcome.concepts || null,
      queryMapping: outcome.queryMapping || null,
      // scanned 是真实扫描页数（remoteDiscovery 的 outcome.scanned）。
      // 之前只透传 skipped.length，页面于是拿同一个数字同时填「扫描」与「排除」，
      // 写出「本次扫描 65 条、排除 65 条」这种自相矛盾的话。
      scannedCount: outcome.scanned || 0,
      skippedCount: (outcome.skipped || []).length,
      vision: {
        analyzed: visionOutcome.analyzed,
        attempted: visionOutcome.attempted,
        coverage: visionOutcome.coverage,
        reason: visionOutcome.reason,
        provenance: visionOutcome.provenance,
        note: visionOutcome.note || "",
        reranked: visionOutcome.reranked,
        failures: visionOutcome.failures,
      },
      corrections: {
        excluded: corrected.excluded,
        excludedCount: corrected.excluded.length,
        total: corrected.correctionCount,
      },
    };
  } catch (e) {
    return {
      results: [],
      degraded: true,
      note: `Commons 渠道错误：${String(e?.message || e).slice(0, 80)}。本地检索不受影响。`,
    };
  }
}

// 统一出口：按媒介筛选取远程参考。
// media 语义与 FIND 现有的检索范围筛选完全一致——用户选「仅电影画面」
// 就不该看到远程绘画，反之亦然。
// P4.9 STEP 3 — 从 VisualIntent 出发的电影发现。
//
// 只允许有客观依据的受控概念进入检索（见 filmIntentConcepts）。
// 返回两个**互相独立**的依据，界面上必须分开显示：
//   metadataRecall : 通过哪个词、命中在什么字段被召回
//   visualVerification : 是否真的对这一张候选图做过视觉核验（当前恒为未做）
//
// 当前没有视觉核验能力（未配 provider），所以 visualVerification 一律如实标注，
// 不允许把「元数据召回」写成「画面相似」。
export async function findRemoteFilmFromIntent(intent, { limit = 6 } = {}) {
  const { searchTermsFromIntent } = await import("../source/filmIntentConcepts.js");
  const mapped = searchTermsFromIntent(intent, { max: 2 });

  if (!mapped.supported) {
    return {
      results: [],
      degraded: false,
      unsupported: true,
      note: mapped.reason,
      concepts: mapped.concepts,
      unmapped: mapped.unmapped,
      terms: [],
    };
  }

  // 逐词检索后合并。每个词单独成条，保留「被哪个词召回」这一层依据。
  // 实测（冷启动，单次 findRemoteFilm）：crowd 8.0s、street 14.1s、night 3.9s。
  // 原来这里是「串行 + 每词 800ms 延迟」：2 个词最坏可到 30s 以上，
  // 用户会以为卡死。改成**有限并发**（最多 2 个词同时跑）。
  // 上限 2 的依据：discoverCommonsFilmStills 内部已有 maxSearches=3、
  // identityBudget=3 的双重限流，外层再限制并发数就不会把渠道打爆。
  const CONCURRENCY = 2;
  const perTerm = new Array(mapped.terms.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < mapped.terms.length) {
      const idx = cursor++;
      const term = mapped.terms[idx];
      try {
        const r = await findRemoteFilm(term, { media: "film", limit });
        perTerm[idx] = { term, ...r };
      } catch (e) {
        perTerm[idx] = { term, results: [], degraded: true, note: String(e?.message || e).slice(0, 80) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, mapped.terms.length) }, worker));
  // 结果顺序仍按 terms 顺序，避免并发导致卡片顺序每次不同。

  const seen = new Set();
  const merged = [];
  for (const bucket of perTerm) {
    for (const item of bucket.results || []) {
      const key = item?.artwork?.key || item?.artwork?.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push({
        ...item,
        // P4.9 收尾 — 每条带展示资格分级（primary / exploratory）
        display: classifyFilmDisplay(item),
        intentConcept: {
          term: bucket.term,
          // 该词来自 VisualIntent 的哪个字段
          field: mapped.concepts.find((c) => c.term === bucket.term)?.field || null,
          basis: mapped.concepts.find((c) => c.term === bucket.term)?.basis || null,
        },
      });
    }
  }

  const anyDegraded = perTerm.some((b) => b.degraded);

  // renderRemoteSection 读 remote.film 的一整套字段来画渠道摘要。
  // 不补齐这些，摘要区会整片显示「未知」——那等于把「本次按什么概念查的」藏起来。
  const termTally = {};
  const locationTally = {};
  const natureKinds = {};
  let skippedCount = 0;
  let scannedCount = 0;
  const termMeta = [];
  for (const bucket of perTerm) {
    termTally[bucket.term] = (bucket.results || []).length;
    skippedCount += bucket.skippedCount || 0;
    scannedCount += bucket.scannedCount || 0;
    const concept = mapped.concepts.find((c) => c.term === bucket.term);
    termMeta.push({ term: bucket.term, source: concept?.basis || "VisualIntent 受控映射" });
    if (bucket.concepts?.locationTally) {
      for (const [k, v] of Object.entries(bucket.concepts.locationTally)) {
        locationTally[k] = (locationTally[k] || 0) + v;
      }
    }
    if (bucket.natureKinds) {
      for (const [k, v] of Object.entries(bucket.natureKinds)) {
        natureKinds[k] = (natureKinds[k] || 0) + v;
      }
    }
  }
  const visionAnalyzed = perTerm.reduce((n, b) => n + (b.vision?.analyzed || 0), 0);
  const visionAttempted = perTerm.reduce((n, b) => n + (b.vision?.attempted || 0), 0);
  // 视觉未核验的**真实原因**来自 rerankWithVision（not-authorized /
  // vision-unavailable / budget-capped …），不是我推测的一句话。
  // 之前这里硬编码「本机未配置视觉 Provider」，那是在把猜测写成事实。
  // 原先拼成 visionReasons（少一个 i），一并修正。
  const visionReasons = [...new Set(perTerm.map((b) => b.vision?.reason).filter(Boolean))];
  const visionProvenance = [...new Set(perTerm.map((b) => b.vision?.provenance).filter(Boolean))];
  // rerankWithVision 同时给了人能读的 note。优先显示它，reason 代码只作兜底：
  // 「原因 not-authorized」对用户是没有意义的内部术语。
  const visionNotes = [...new Set(perTerm.map((b) => b.vision?.note).filter(Boolean))];
  const visionNote = visionAnalyzed > 0
    ? null
    : visionNotes.length
      ? visionNotes.join(" ")
      : visionReasons.length
        ? `未做图像分析（${visionReasons.join("、")}）。`
        : "未做图像分析（调用方未请求，未返回原因）。";

  return {
    results: merged,
    degraded: anyDegraded,
    unsupported: false,
    note: merged.length
      ? `按视觉关键词 ${mapped.terms.map((t) => `「${t}」`).join("、")} 检索到 ${merged.length} 件；画面相似性尚未验证。`
      : `按视觉关键词 ${mapped.terms.map((t) => `「${t}」`).join("、")} 未找到可展示的候选；画面相似性未验证。`,
    concepts: mapped.concepts,
    unmapped: mapped.unmapped,
    terms: mapped.terms,
    // 供 renderRemoteSection 使用的渠道摘要
    film: {
      scannedCount,
      skippedCount,
      concepts: {
        terms: termMeta,
        termTally,
        locationTally: Object.keys(locationTally).length ? locationTally : null,
      },
      natureKinds: Object.keys(natureKinds).length ? natureKinds : null,
      queryMapping: { reason: `检索词来自 VisualIntent：${mapped.reason}` },
      vision: {
        analyzed: visionAnalyzed,
        attempted: visionAttempted,
        coverage: visionAttempted ? visionAnalyzed / visionAttempted : 0,
        reason: visionAnalyzed ? "ok" : (visionReasons[0] || "unknown"),
        provenance: visionProvenance[0] || null,
        note: visionNote,
        reranked: false,
        failures: [],
      },
      corrections: { excluded: [], excludedCount: 0, total: 0 },
    },
    // 两种独立依据，界面必须分开显示
    metadataRecall: { terms: mapped.terms, concepts: mapped.concepts },
    visualVerification: {
      performed: visionAnalyzed > 0,
      analyzed: visionAnalyzed,
      attempted: visionAttempted,
      reason: visionAnalyzed > 0 ? "ok" : (visionReasons[0] || "unknown"),
      statement: "根据元数据发现，画面相似性尚未验证",
    },
  };
}
export async function findRemoteReferences(query, { media = "all" } = {}) {
  const [paintings, films] = await Promise.all([
    media === "film" ? Promise.resolve({ results: [], degraded: false, note: "" }) : findRemotePaintings(query, { media }),
    media === "artwork" ? Promise.resolve({ results: [], degraded: false, note: "" }) : findRemoteFilm(query, { media }),
  ]);

  const results = paintings.results.concat(films.results);
  // 去重：两个渠道可能返回同一件（Commons 也收博物馆开放图像）。
  //
  // 防御性要求：键缺失时**不能**把所有条目当成同一件。缺键就退回条目自身的
  // 标识（id），实在没有才按位置区分 —— 宁可不去重，也不能静默把候选清空。
  const seen = new Set();
  const deduped = results.filter((item, i) => {
    const key = item.artwork.key || item.artwork.id || `${item.medium}:${i}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const notes = [];
  if (paintings.degraded) notes.push(paintings.note);
  if (films.degraded) notes.push(films.note);
  // 部分失败也要透传：用户看到真实结果的同时必须知道少了哪些来源，否则
  // 「四馆检索」会被当成「全部来源都答了」。
  if (paintings.partial && paintings.note) notes.push(paintings.note);
  // 「渠道不支持该查询语义」必须透传。缺了这段，中文查询时用户只会看到
  // 一句笼统的「以下来自博物馆与 Commons 渠道」，完全不知道电影渠道其实
  // 根本没检索——这正是「不得假报无影片素材」要防的情况。
  if (films.unsupported && films.note) notes.push(films.note);
  if (paintings.unsupported && paintings.note) notes.push(paintings.note);

  return {
    results: deduped,
    // unsupported 不是 degraded：渠道没坏，只是语义不支持。此时应显示说明
    // 但不能报「故障」。
    degraded: paintings.degraded || films.degraded,
    unsupported: Boolean(films.unsupported || paintings.unsupported),
    note: notes.join(" "),
    metadataOnlyCount: paintings.metadataOnlyCount || 0,
    // 因与查询无关而未列入的件数。展示为 0 且不说明，会让用户以为远程
    // 「没有内容」；如实计数才不误导。
    unrelatedCount: (paintings.unrelatedCount || 0) + (films.unrelatedCount || 0),
    // STEP 2/3/4 的电影渠道可解释数据（绘画渠道不参与这些概念，这里原样透传）。
    film: {
      // P4.9 收尾 — scannedCount 也要透传，否则文字路径的摘要显示「扫描 未知 条」。
      scannedCount: films.scannedCount || 0,
      verificationTally: films.verificationTally || null,
      natureKinds: films.natureKinds || null,
      concepts: films.concepts || null,
      queryMapping: films.queryMapping || null,
      skippedCount: films.skippedCount || 0,
      vision: films.vision || null,
      corrections: films.corrections || null,
    },
  };
}