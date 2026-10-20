// candidate.js — P4.14-B3 统一候选契约（最薄的一层）
//
// 现状问题（P4.14-B1 盘点结论）：
//   四个博物馆 adapter 各用一个布尔当许可门——Met `isPublicDomain`、AIC `is_public_domain`、
//   Cleveland `share_license_status === "CC0"`、Rijks 正则命中——四者语义并不等价，
//   上层却在 remoteDiscovery 里统一当 `showable` 消费，且没有任何地方记录
//   「这个结论是谁下的」。
//
// 本模块只做一件事：把「不同来源的候选」翻译成**同一套可核验的说法**。
// 它不是框架，没有注册表、没有插件系统、没有网络请求。
//
// 两条不可让步的规则：
//   1. 许可**不是**一个布尔。图片来源、作品权利、展示许可、缓存再分发许可是四件事，
//      分别记录，未知就写未知。
//   2. 「找到作品标题」≠「找到可推荐画面」。只有图像存在、来源可验证、许可确认、
//      媒介政策通过、且有视觉证据时，才叫 RECOMMENDABLE。

import {
  describeMedia,
  MEDIUM,
  IMAGE_KIND,
  VISUAL_FORM,
  isActualScreenImage,
} from "./mediaTaxonomy.js";

/** 候选的四个状态。互斥，由证据决定，不由调用方指定。 */
export const CANDIDATE_STATE = Object.freeze({
  /** 只有作品信息，没有任何可用图像 */
  METADATA_ONLY: "metadata-only",
  /** 有真实图像且来源可验证，但还没有可用的视觉特征 */
  IMAGE_AVAILABLE: "image-available",
  /** 有视觉特征，但许可或媒介政策不满足，不能推荐 */
  VISUAL_ANALYZED: "visual-analyzed",
  /** 图像 + 许可 + 媒介政策 + 视觉证据同时成立 */
  RECOMMENDABLE: "recommendable",
});

/** 把任意形态的图像验证结果归一。缺省是「未验证」，不是「通过」。 */
export function normalizeImageVerification(v) {
  if (!v || typeof v !== "object") return null;
  if (v.verified === true) {
    return {
      verified: true,
      format: v.format || null,
      width: Number.isFinite(v.width) ? v.width : null,
      height: Number.isFinite(v.height) ? v.height : null,
      bytes: Number.isFinite(v.bytes) ? v.bytes : null,
      checkedAt: v.checkedAt || null,
    };
  }
  if (v.verified === false) {
    return { verified: false, reason: String(v.reason || "unknown") };
  }
  return null;
}

/** 三态：decoded / failed / unverified。 */
export function imageStatusOf(v) {
  const n = normalizeImageVerification(v);
  if (!n) return "unverified";
  return n.verified ? "decoded" : "failed";
}

/** 许可四问的取值。null 表示未知，绝不用 false 冒充「不允许」。 */
const TRISTATE = Object.freeze({
  YES: "yes",
  NO: "no",
  UNKNOWN: "unknown",
});

function tri(value) {
  if (value === true) return TRISTATE.YES;
  if (value === false) return TRISTATE.NO;
  return TRISTATE.UNKNOWN;
}

/**
 * 构造一份许可证据。
 *
 * @param {object} input
 * @param {Array<{field:string,value:any}>} [input.fields]  原始字段证据（来源自己的字段名）
 * @param {"provider-field"|"provider-doc"|"our-inference"|"none"} [input.decidedBy]
 * @param {"runtime"|"build"|"manual"|"unknown"} [input.obtainedAt]
 * @param {boolean|null} [input.imageSourceClear]
 * @param {boolean|null} [input.workRightsClear]
 * @param {boolean|null} [input.displayAllowed]
 * @param {boolean|null} [input.cacheRedistributionAllowed]
 */
export function makeRightsEvidence(input = {}) {
  const fields = Array.isArray(input.fields) ? input.fields.map((f) => ({
    field: String(f.field),
    value: f.value === undefined ? null : f.value,
  })) : [];

  const parts = {
    imageSourceClear: tri(input.imageSourceClear),
    workRightsClear: tri(input.workRightsClear),
    displayAllowed: tri(input.displayAllowed),
    cacheRedistributionAllowed: tri(input.cacheRedistributionAllowed),
  };

  // 只有四问全部 yes 才算 confirmed。任何一项 unknown 都只能是 unconfirmed。
  const allYes = Object.values(parts).every((v) => v === TRISTATE.YES);
  const anyNo = Object.values(parts).some((v) => v === TRISTATE.NO);

  return {
    verdict: anyNo ? "denied" : allYes ? "confirmed" : "unconfirmed",
    decidedBy: input.decidedBy || "none",
    obtainedAt: input.obtainedAt || "unknown",
    fields,
    ...parts,
  };
}

/** 没有证据时的许可对象。显式表达「我们不知道」，而不是默认放行。 */
export function unknownRights(reason = "该来源未提供可核验的许可字段") {
  return {
    ...makeRightsEvidence({ decidedBy: "none", obtainedAt: "unknown" }),
    verdict: "unconfirmed",
    note: reason,
  };
}

/**
 * 视觉证据。区分「有意图标注」与「有像素签名」——两者不是同一件事。
 */
export function makeVisualEvidence(input = {}) {
  const intent = input.intent || null;
  const signature = input.signature || null;
  const fieldCount = intent
    ? Object.keys(intent).filter((k) => {
        const v = intent[k];
        if (v === undefined || v === null || v === "") return false;
        if (Array.isArray(v)) return v.length > 0;
        return true;
      }).length
    : 0;

  return {
    hasIntent: fieldCount > 0,
    intentFieldCount: fieldCount,
    intentProvenance: input.intentProvenance || null,
    hasSignature: !!(signature && signature.ok),
    signatureOrigin: signature ? signature.origin || null : null,
    // 有标注但没签名 ≠ 有像素证据；这里分开记，避免下游把二者混为一谈。
    level: fieldCount > 0 ? (signature && signature.ok ? "intent+signature" : "intent-only") : (signature && signature.ok ? "signature-only" : "none"),
  };
}

/**
 * 把任意来源的一条记录标准化成统一候选。
 *
 * 不同来源可以缺非必要字段，但**不得伪造**：缺就是 null / UNKNOWN。
 *
 * @param {object} raw
 * @param {string} raw.stableId
 * @param {string} raw.sourceProvider
 * @param {object} [raw.originalWork]   { title, creator, year, mediumLabel }
 * @param {string} [raw.imageURL]
 * @param {string} [raw.sourcePageURL]
 * @param {object} [raw.rights]         makeRightsEvidence() 或 null
 * @param {object} [raw.visual]         makeVisualEvidence() 或 null
 * @param {object} [raw.metadataProvenance] { provider, endpoint, fetchedAt, fieldsFrom }
 * @param {object} [raw.mediaOverrides] 传给 describeMedia 的额外声明（visualForm / tradition / imageKind）
 * @param {boolean} [raw.blackAndWhiteExcluded] 是否被 P4.12 规则排除
 */
export function toSourceCandidate(raw = {}) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "not-an-object", candidate: null };
  }
  if (!raw.stableId || typeof raw.stableId !== "string") {
    return { ok: false, error: "missing-stable-id", candidate: null };
  }
  if (!raw.sourceProvider || typeof raw.sourceProvider !== "string") {
    return { ok: false, error: "missing-source-provider", candidate: null };
  }

  const media = describeMedia({
    medium: raw.medium,
    id: raw.stableId,
    traditions: raw.traditions,
    tradition: raw.tradition,
    visualForm: raw.visualForm,
    imageKind: raw.imageKind,
    ...(raw.mediaOverrides || {}),
  });

  const candidate = {
    stableId: raw.stableId,
    sourceProvider: raw.sourceProvider,
    originalWork: raw.originalWork ? {
      title: raw.originalWork.title ?? null,
      creator: raw.originalWork.creator ?? null,
      year: raw.originalWork.year ?? null,
      mediumLabel: raw.originalWork.mediumLabel ?? null,
    } : null,
    medium: media.medium,
    visualForm: media.visualForm,
    tradition: media.tradition,
    imageKind: media.imageKind,
    mediaEvidence: media.evidence,
    imageURL: raw.imageURL || null,
    sourcePageURL: raw.sourcePageURL || null,
    // 图像是否**被真正解码过**。HTTP 200 不算证据。
    //   null        未验证（只知道有 URL）
    //   verified:true  已解码，带 format/width/height
    //   verified:false 明确失败（403、解码报错、内容不是图片）
    imageVerification: normalizeImageVerification(raw.imageVerification),
    imageStatus: imageStatusOf(raw.imageVerification),
    rights: raw.rights || unknownRights(),
    visual: raw.visual || makeVisualEvidence({}),
    metadataProvenance: raw.metadataProvenance ? {
      provider: raw.metadataProvenance.provider ?? raw.sourceProvider,
      endpoint: raw.metadataProvenance.endpoint ?? null,
      fetchedAt: raw.metadataProvenance.fetchedAt ?? null,
      fieldsFrom: raw.metadataProvenance.fieldsFrom ?? "unknown",
    } : { provider: raw.sourceProvider, endpoint: null, fetchedAt: null, fieldsFrom: "unknown" },
    policy: {
      // 黑白排除是产品规则（P4.12），不是许可问题，单独记。
      blackAndWhiteExcluded: raw.blackAndWhiteExcluded === true,
      // 这张图是不是「作品/影片画面本身」。海报、宣传照、性质未标注都不算。
      actualScreenImage: isActualScreenImage({
        medium: media.medium,
        id: raw.stableId,
        imageKind: media.imageKind,
        visualForm: media.visualForm,
        tradition: media.tradition,
      }),
    },
  };

  return { ok: true, error: null, candidate, state: candidateState(candidate) };
}

/**
 * 推导候选状态。**顺序即优先级**：先看有没有图，再看有没有视觉证据，最后才看能不能推荐。
 *
 * 注意「尚未分析的真实馆藏图片」这一档：它停在 IMAGE_AVAILABLE，
 * **不是被永久排除**——等后续算出合法的视觉特征就能往上走。
 */
export function candidateState(candidate) {
  if (!candidate) return CANDIDATE_STATE.METADATA_ONLY;

  const hasImage = !!(candidate.imageURL && String(candidate.imageURL).trim());
  if (!hasImage) return CANDIDATE_STATE.METADATA_ONLY;

  // 明确解码失败（403 / 内容不是图片）→ 我们手上没有可用图像，只是元数据。
  if (candidate.imageStatus === "failed") return CANDIDATE_STATE.METADATA_ONLY;

  const visual = candidate.visual || {};
  const hasVisual = !!(visual.hasIntent || visual.hasSignature);
  if (!hasVisual) return CANDIDATE_STATE.IMAGE_AVAILABLE;

  // 到这里有图也有视觉证据，剩下全看许可与政策。
  if (!isRecommendable(candidate)) return CANDIDATE_STATE.VISUAL_ANALYZED;
  return CANDIDATE_STATE.RECOMMENDABLE;
}

/**
 * 能不能进入 AIGC 推荐。
 *
 * 五个条件缺一不可：
 *   1. 有图像 URL
 *   2. 许可 verdict === "confirmed"（unconfirmed / denied 都不行）
 *   3. 未被 P4.12 黑白规则排除
 *   4. 这张图是作品/影片画面本身（不是海报、不是宣传照、不是性质未标注）
 *   5. 有视觉证据
 */
export function isRecommendable(candidate) {
  if (!candidate) return false;
  const c = candidate;
  if (!(c.imageURL && String(c.imageURL).trim())) return false;
  // 没有真正解码过的图像不得进入推荐——「有 URL」不等于「图能看」。
  if (!(c.imageVerification && c.imageVerification.verified === true)) return false;
  if (!(c.rights && c.rights.verdict === "confirmed")) return false;
  if (c.policy && c.policy.blackAndWhiteExcluded === true) return false;
  if (!(c.policy && c.policy.actualScreenImage === true)) return false;

  const visual = c.visual || {};
  if (!(visual.hasIntent || visual.hasSignature)) return false;

  return true;
}

/**
 * 跨来源去重键。
 *
 * 同一件作品可能从两个渠道各来一条（例如本地绘画与某馆 API 命中同一幅画）。
 * 用「规范化作品身份」做键，而不是 URL——URL 会变，作品身份不会。
 */
export function dedupeKey(candidate) {
  if (!candidate) return "";
  const work = candidate.originalWork || {};
  const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const title = norm(work.title);
  const creator = norm(work.creator);
  if (!title) return `${candidate.sourceProvider}:${candidate.stableId}`;
  // 有标题时用 标题+作者+年份 作身份；年份缺失就不参与键，避免把同年份噪声当区分。
  return [title, creator, work.year ?? ""].filter(Boolean).join("|");
}

/**
 * 对一组候选去重。保留**信息更全**的那一条（可推荐 > 有分析 > 仅有图 > 仅有元数据）。
 */
export function dedupeCandidates(candidates) {
  const rank = {
    [CANDIDATE_STATE.RECOMMENDABLE]: 4,
    [CANDIDATE_STATE.VISUAL_ANALYZED]: 3,
    [CANDIDATE_STATE.IMAGE_AVAILABLE]: 2,
    [CANDIDATE_STATE.METADATA_ONLY]: 1,
  };
  const best = new Map();
  const dropped = [];
  for (const c of candidates || []) {
    const key = dedupeKey(c);
    const state = candidateState(c);
    const prev = best.get(key);
    if (!prev) {
      best.set(key, { candidate: c, state });
      continue;
    }
    if (rank[state] > rank[prev.state]) {
      dropped.push({ key, dropped: prev.candidate.stableId, kept: c.stableId });
      best.set(key, { candidate: c, state });
    } else {
      dropped.push({ key, dropped: c.stableId, kept: prev.candidate.stableId });
    }
  }
  return {
    candidates: [...best.values()].map((x) => x.candidate),
    dropped,
  };
}

/**
 * 把一条**已存在的产品记录**（本地绘画 / 本地影片）桥接成统一候选。
 *
 * 这层的意义：让「本地素材」和「远程候选」用同一种说法描述自己，
 * 而不是让远程那边单独长出一套。
 *
 * 许可由调用方传入——本模块不替任何来源下许可结论。
 */
export function bridgeLocalRecord(record, options = {}) {
  if (!record || !record.id) {
    return { ok: false, error: "missing-record", candidate: null };
  }
  const isFilm = record.medium === MEDIUM.FILM;
  return toSourceCandidate({
    stableId: record.id,
    sourceProvider: options.sourceProvider || (isFilm ? "local-film-still" : "local-curated-artwork"),
    medium: isFilm ? MEDIUM.FILM : MEDIUM.ARTWORK,
    traditions: record.traditions,
    visualForm: record.visualForm,
    tradition: record.tradition,
    imageKind: record.imageKind,
    originalWork: {
      title: record.titleZh || record.title || null,
      creator: record.artist || record.director || null,
      year: record.year ?? null,
      mediumLabel: isFilm ? "film" : "artwork",
    },
    imageURL: options.imageURL || null,
    sourcePageURL: options.sourcePageURL || null,
    imageVerification: options.imageVerification || null,
    rights: options.rights || unknownRights("本地记录未附带许可证据"),
    visual: makeVisualEvidence({
      intent: record.visualIntent || options.intent || null,
      signature: options.signature || null,
      intentProvenance: options.intentProvenance || null,
    }),
    metadataProvenance: {
      provider: options.sourceProvider || (isFilm ? "local-film-still" : "local-curated-artwork"),
      endpoint: "local-data",
      fetchedAt: options.fetchedAt || null,
      fieldsFrom: "build-time",
    },
    blackAndWhiteExcluded: options.blackAndWhiteExcluded === true,
  });
}
