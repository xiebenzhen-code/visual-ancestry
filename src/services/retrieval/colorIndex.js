// P4.4 — 色彩签名的产品端加载器
//
// 把预计算的 61 张本地资产签名暴露给检索链。
// 只在浏览器/Node 都安全：纯 JSON 读取，无 sharp 依赖。
//
// 重要边界：
//   · 这里只提供「本地已知资产」的签名（按 artwork id 索引）
//   · 上传的陌生图片**不得**从这里取签名 —— 必须由
//     colorSignatureBrowser.js 从它自己的像素计算
//   · 两者在返回对象上用 origin 字段区分，便于测试断言

import raw from "../../data/color-signatures.json" with { type: "json" };

const SIGNATURES = (raw && raw.signatures) || {};

/** 取某件本地资产的签名；不存在返回 null（不伪造） */
export function signatureFor(artworkId) {
  const s = SIGNATURES[artworkId];
  if (!s || s.ok !== true) return null;
  return { ...s, origin: "precomputed-local-asset" };
}

/** 全部签名映射，供 rerank 使用 */
export function allSignatures() {
  return SIGNATURES;
}

/** 索引元信息，便于界面/测试说明这份数据是何时算的 */
export function signatureIndexMeta() {
  return {
    generatedAt: raw.generatedAt || null,
    method: raw.method || null,
    count: raw.count || 0,
    failed: raw.failed || 0,
    buildMs: raw.buildMs ?? null,
    origin: "precomputed-local-asset",
  };
}

/** 上传图签名必须来自像素计算 —— 这里提供一个明确的断言钩子 */
export function assertUploadSignatureOrigin(sig) {
  if (!sig) return { ok: false, reason: "no-signature" };
  if (sig.origin === "precomputed-local-asset") {
    return { ok: false, reason: "upload-signature-must-not-be-a-local-asset-lookup" };
  }
  return { ok: true, reason: "computed-from-uploaded-pixels" };
}
