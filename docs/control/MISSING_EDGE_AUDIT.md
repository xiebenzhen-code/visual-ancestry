# MISSING_EDGE_AUDIT

**审计日期**：2026-10-08
**范围**：PHASE 6 指定的 15 项
**性质**：**只审计，不自动实现**

---

## 分类定义

| 分类 | 含义 |
|---|---|
| `BLOCKER` | 阻止部署，必须修 |
| `SHOULD_FIX` | 应修，不阻止当前阶段 |
| `KNOWN_LIMITATION` | 已知限制，暂不修（需文档化）|
| `NOT_REQUIRED` | 本项目形态不需要 |
| `AUDIT_REQUIRED` | 需进一步审计才能定级 |

---

## 审计结果

### MEA-01 · 测试框架

| 项 | 内容 |
|---|---|
| **审计事实** | `package.json` scripts 仅 `dev` / `build` / `preview`；**无 `test`**；**无 `tests/` 目录**；devDependencies 仅 `sharp` |
| 现有替代 | `qa/*.mjs`（30 个验收脚本）、build 泄漏扫描、sha256 冻结校验 |
| **分类** | `SHOULD_FIX` |
| 理由 | 冻结核心是纯函数（`scoring.js`），极易测试；但当前无自动化保护 |
| 建议 | 为纯函数层补最小测试，不追求全覆盖 |

### MEA-02 · Upload size / type validation

| 项 | 内容 |
|---|---|
| **审计事实** | ✅ **已有**：`uploadService.js:28` `MAX_BYTES = 6MB`；`:134` MIME 白名单检查；`server.mjs:47` `VISION_MIME_OK`；`:46` body 上限 6MB → 413 |
| 覆盖 | 浏览器侧 + server 侧**双重校验** |
| **分类** | `NOT_REQUIRED` |

### MEA-03 · Malformed image handling

| 项 | 内容 |
|---|---|
| **审计事实** | `uploadService.js:112` `persistFailed` 记录失败项；`prepareVisionImage` 负责解码；base64 字母表校验（`server.mjs:82`）|
| 缺口 | **未知**：截断的 JPEG / 伪装扩展名的文件行为未实测 |
| **分类** | `AUDIT_REQUIRED` |

### MEA-04 · Storage quota / corruption

| 项 | 内容 |
|---|---|
| **审计事实** | `memoryRepository.js:29` `localStorage.getItem`；`:37/52/75` setItem；`STORE_VERSION = 1`（`:20`）|
| 已知限制 | ⚠ **实测 1050 张 = 202.6 MB，超配额 20倍** |
| 缺口 | JSON 损坏时的恢复路径未验证 |
| **分类** | `BLOCKER`（部署前必须处理 —— 配额问题会导致用户数据丢失）|

### MEA-05 · Cache versioning / schema migration

| 项 | 内容 |
|---|---|
| **审计事实** | `memoryRepository.js:19-20` `BROWSER_KEY = "visual-memory:v1"` + `STORE_VERSION = 1`；`:35/87/122/199` 四处构造 `{version, memories}` |
| 缺口 | ⚠ **无 migration 路径** —— v1→v2 时旧数据如何处理未实现 |
| Intent cache | double-key `(source, sourceId)` + sha256；**环境性失败已标retriable** |
| **分类** | `SHOULD_FIX`（当前仅 v1，暂无迁移需求；引入 v2 前必须先建）|

### MEA-06 · API rate limiting

| 项 | 内容 |
|---|---|
| **审计事实** | ❌ **代码中不存在** —— grep `rateLimit` / `throttle` 无命中 |
| 影响 | bridge 无频率限制 → 单客户端可打满 API 配额 |
| 本地形态 | 影响有限（仅本机使用）|
| 公网形态 | ⚠ **必须加** |
| **分类** | `BLOCKER`（公网部署前）|

### MEA-07 · CORS

| 项 | 内容 |
|---|---|
| **审计事实** | ✅ **无任何 `Access-Control-*` 头**（grep 确认） |
| **本形态分类** | `NOT_REQUIRED` —— 无 CORS 头即最严格的同源约束 |

#### CORS ≠ 鉴权 ≠ 限流（三者互不替代）

这是三个**独立**的安全维度，缺一不可：

| 维度 | 作用 | 当前状态 | 公网形态需求 |
|---|---|---|---|
| **CORS** | 阻止**其他源**的浏览器脚本发请求 | ✅ 无 CORS 头 = 已阻止 | 若前后端分离，需**显式**配置允许的源 |
| **鉴权（Auth）** | 阻止**未授权用户**调用 | ❌ 无 | ✅ 必须有 |
| **限流（Rate limit）** | 阻止**过量请求** | ❌ 无 | ✅ 必须有 |

**关键**：CORS 只约束浏览器发起的跨源请求。它**不能**阻止——
- `curl` / Postman 等非浏览器客户端
- 服务端脚本直接调用
- 已通过 CORS 检查的同源脚本滥用

**所以「无 CORS 头」≠「安全」**。它只关闭了浏览器跨源这一条路径。

| 项 | 内容 |
|---|---|
| **公网形态分类** | `BLOCKER` —— 若前后端分离部署，CORS 需显式配置；鉴权与限流必须新增 |

### MEA-08 · Log redaction

| 项 | 内容 |
|---|---|
| **审计事实** | ⚠ **`openaiProvider.mjs:158-162` 无脱敏**：<br>`console.log("[vision-debug]", { status, contentType, preview: text.slice(0, 200) })`<br>此外 `:316` `logVision`、`:327` `diag` 亦输出 |
| 风险 | 上游响应前 200 字符进日志 —— 可能含模型输出内容 |
| 已有的保护 | ✅ `safeSnippet()`（`:340`）对 ≥40 字符 token 做 `[LONGTOKEN]` 掩码 —— 但 **仅 `diag` 路径使用，`[vision-debug]` 未用** |
| **分类** | `BLOCKER`（部署前必须处理）|

### MEA-09 · Request body limit

| 项 | 内容 |
|---|---|
| **审计事实** | ✅ **已有**：`server.mjs:46` `VISION_BODY_LIMIT = 6 * 1024 * 1024`；`:54-55` 超限返回 413 `payload-too-large` |
| 客户端配合 | `uploadService.js:28` 同为 6MB，两侧一致 |
| **分类** | `NOT_REQUIRED` |

### MEA-10 · Timeout telemetry

| 项 | 内容 |
|---|---|
| **审计事实** | `server.mjs:116` `{ timeoutMs: 60_000 }`；`openaiProvider.mjs:136` 默认 45000；`:270-271` transient 原因重试**一次** |
| 已有观测 | `:274` `logVision` 记录 latencyMs |
| 缺口 | ⚠ **无聚合/上报** —— 只能看单次日志，无法统计成功率 |
| 影响 | 无法回答「provider 稳定吗」—— 这正是 E02 的核心疑问 |
| **分类** | `SHOULD_FIX`（mini reliability run 依赖此能力）|

### MEA-11 · Retry / resume

| 项 | 内容 |
|---|---|
| **审计事实** | `openaiProvider.mjs:134` `TRANSIENT_REASONS = {network, timeout, server}`；`:270-271` **重试恰好一次** |
| 已知问题 | ⚠ `empty-response` **不在**重试列表 → 实测 film 83.4s = 60s 超时 + 23.4s 重试，两次都失败 |
| 用户侧 | `uploadService.js:19` 注释明确「**无自动无限重试** —— 一次人工重试」 |
| **分类** | `KNOWN_LIMITATION`（策略已明确：失败由用户手动重试，不自动放大成本）|

### MEA-12 · Export / delete

| 项 | 内容 |
|---|---|
| **审计事实** | ✅ delete：`memoryRepository.js:188` `deleteMemory(id)`；`archivePortability.js` 存在 |
| 缺口 | 导出功能实现范围未逐项核实 |
| **分类** | `SHOULD_FIX`（数据可携带性；localStorage 数据尤其需要）|

### MEA-13 · Provider image retention assumptions

| 项 | 内容 |
|---|---|
| **审计事实** | ⚠ **未知** —— 第三方 OpenAI 兼容层是否留存上传图片、留存多久、日志中是否记录，均**未确认** |
| 影响 | 用户上传私人图片后可能被第三方留存 |
| 责任边界 | 本项目**无法控制** provider 侧留存策略 |
| **分类** | `AUDIT_REQUIRED`（公网部署前必须查清provider 条款）|

### MEA-14 · Public abuse protection

| 项 | 内容 |
|---|---|
| **审计事实** | 无鉴权、无速率限制、无 CORS 头（本地 server）|
| 本地形态（仅 127.0.0.1）| `NOT_REQUIRED` |
| 公网形态 | ⚠ **必须加**：鉴权 + 限流 + 请求大小限制 + 日志脱敏 |
| **分类** | `BLOCKER`（公网部署前）|

### MEA-15 · Prompt / schema / model cache invalidation

| 项 | 内容 |
|---|---|
| **审计事实** | Intent cache：double-key `(source, sourceId)` + sha256；环境性失败标 `retriable` |
| 缺口 | ⚠ **无 cache 版本号** —— 若 SYSTEM_PROMPT / schema / model 变更，旧 intent **不会自动失效** |
| 风险 | 换模型后继续用旧模型的 intent → 画像与检索结果不可比 |
| **分类** | `SHOULD_FIX`（schema 或 model 变更时必须手动清cache）|

---

## 汇总

| 分类 | 数量 | ID |
|---|---|---|
| `BLOCKER` | **4** | MEA-04（storage 容量）、MEA-06（限流）、MEA-08（日志脱敏）、MEA-14（滥用保护）|
| `SHOULD_FIX` | **5** | MEA-01（测试框架）、MEA-05（cache 版本化）、MEA-10（超时遥测）、MEA-12（导出）、MEA-15（cache 失效）|
| `KNOWN_LIMITATION` | **1** | MEA-11（重试策略）|
| `NOT_REQUIRED` | **3** | MEA-02（上传校验，已有）、MEA-07（CORS，本形态）、MEA-09（body 限制，已有）|
| `AUDIT_REQUIRED` | **2** | MEA-03（畸形图像）、MEA-13（provider 留存）|
| **合计** | **15** | — |

**计数核对**：4 + 5 + 1 + 3 + 2 = 15 ✅

### 4 个 BLOCKER 的阻塞范围

**全部与公网部署或用户数据量相关**，**均不阻塞 P6.3.1D**：

| ID | 何时阻塞 | 是否影响当前阶段 |
|---|---|---|
| MEA-04 storage 容量 | 用户数据量增长前 | ❌ 不影响 |
| MEA-06 速率限制 | **公网部署前** | ❌ 不影响 |
| MEA-08 日志脱敏 | **公网部署前** | ❌ 不影响 |
| MEA-14 滥用保护 | **公网部署前** | ❌ 不影响 |

**本轮未实现任何修复** —— 本文档仅登记。