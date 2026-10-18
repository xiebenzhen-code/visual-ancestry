# DECISION_LOG

**记录日期**：2026-10-08
**格式**：Decision / Why / Alternative Rejected / Trade-off / Revisit Condition

---

## D01 · Local-First 架构

| 项 | 内容 |
|---|---|
| **Decision** | 数据与功能默认在浏览器本地（`localStorage["visual-memory:v1"]`）；服务端仅承担 vision bridge |
| **Why** | 个人视觉记忆是**私人数据**；local-first 保证默认不上传。密钥隔离也更自然 |
| **Alternative Rejected** | 服务端数据库 —— 需要鉴权、合规、备份、迁移；与产品规模不匹配 |
| **Trade-off** | ⚠ **localStorage 配额是硬上限**（实测 1050 张 = 202.6 MB，超 20×）。清除浏览器数据会丢失全部记忆 |
| **Revisit Condition** | 用户量增长 / 需要跨设备同步 / 存储需求超配额（MEA-04）|

---

## D02 · 确定性检索

| 项 | 内容 |
|---|---|
| **Decision** | 检索用固定打分（`scoring.js`），同一 intent → 同一结果 |
| **Why** | 视觉记忆的价值在于**可复现的个人化推荐**；随机性会破坏「记忆」的概念 |
| **Alternative Rejected** | 向量化检索 / 语义相似度 —— 需embedding，且引入不可复现性 |
| **Trade-off** | 表达力受限：只能按schema 中的视觉字段匹配，无法理解自由语义 |
| **Revisit Condition** | 用户明确需要语义检索，或 schema 字段不足以区分|

---

## D03 · 不做自主 Agent

| 项 | 内容 |
|---|---|
| **Decision** | 决策链全是确定性函数；唯一交给模型的是「看图」；Assistant 是薄解释层 |
| **Why** | 可debuggable、可复现、成本可控；自主循环的成本随步数线性增长 |
| **Alternative Rejected** | LLM Agent 自主规划 —— 与「可复现的个人化推荐」直接冲突 |
| **Trade-off** | 无法处理开放式需求（如「帮我找类似但更冷色调的」这类模糊指令）|
| **Revisit Condition** | 出现明确的、需要多步推理才能表达的用户需求 |

---

## D04 · 不用 Vector DB / Embedding

| 项 | 内容 |
|---|---|
| **Decision** | 检索基于结构化 VisualIntent 字段，不做向量化 |
| **Why** | 已验证的 `scoreIntent` 足够（0.13–0.93 ms）；引入 embedding 需外部服务 + 成本 |
| **Alternative Rejected** | Pinecone / Qdrant / pgvector —— 增加依赖、成本、运维；且结果不可复现 |
| **Trade-off** | 只能匹配 schema 中显式建模的维度 |
| **Revisit Condition** | schema 无法覆盖用户关心的视觉维度 |

---

## D05 · Metadata 不参与打分

| 项 | 内容 |
|---|---|
| **Decision** | 检索**物理上不读** metadata，只读 intent 字段 |
| **Why** | 保证「视觉相似」而非「标签相同」。避免用元数据偷懒 |
| **Alternative Rejected** | 混合打分（视觉 + 元数据）—— 会让「同流派」冒充「视觉相似」 |
| **Trade-off** | 静态藏品需 `intentFromArtwork()` 规则推导作为起点（非真实视觉读数）|
| **Revisit Condition** | 无 —— 这是产品的核心语义，不应改变 |

---

## D06 · 只分析选中的资产

| 项 | 内容 |
|---|---|
| **Decision** | `search → candidates → analyze selected → cache`，不做批量分析 |
| **Why** | 已验证：三源搜索 16.6–30.5 s vs 冻结评分 0.13–0.93 ms。预下载是一次性付 N×(搜索+下载) 时间 + N×体积 |
| **Alternative Rejected** | 全量下载 + 全量分析 —— 实测 1050 张 = 202.6 MB，**超浏览器配额 20 倍** |
| **Trade-off** | 首次查询有等待（搜索耗时）|
| **Revisit Condition** | cache 命中率过低导致重复搜索成本过高 |

---

## D07 · Provider Adapter 边界

| 项 | 内容 |
|---|---|
| **Decision** | 所有厂商差异隔离在 `openaiProvider.mjs`（**全项目唯一 server 文件**）|
| **Why** | 换 provider 只需改 env，不动上层 |
| **Alternative Rejected** | 各处直接调 provider —— 厂商差异会扩散到全项目 |
| **Trade-off** | ⚠ 该文件已成单点：`buildSchema()`、失败分类、重试都在此|
| **Revisit Condition** | 需要支持多 provider 并存 |

---

## D08 · 服务端密钥边界

| 项 | 内容 |
|---|---|
| **Decision** | `VISION_API_BASE/KEY/MODEL` 仅存在于 server process env；bridge 是唯一出口 |
| **Why** | 浏览器**永远拿不到凭据** |
| **Alternative Rejected** | 前端直连 provider —— 密钥必然泄漏 |
| **Trade-off** | 需要运行本地 server；无 server 时 vision 不可用（诚实失败并回退文本输入）|
| **Revisit Condition** | 无 —— 这是安全底线|

---

## D09 · 冻结核心

| 项 | 内容 |
|---|---|
| **Decision** | `scoring.js` / `visualIntent.js` / `artworkIntent.js` / `visualProfile.js` / `visualAssistant.js` / `types.js` / `memoryRepository.js` / `openaiProvider.mjs` / `server.mjs` 以 sha256 冻结 |
| **Why** | 这些模块的错误会**静默污染**结果，且难以从UI 察觉 |
| **Alternative Rejected** | 不冻结 —— 改动无法审计，「上次能用」无法验证 |
| **Trade-off** | 修改需显式解冻 + 重跑验证 |
| **Revisit Condition** | schema 变更时（必须同步更新，否则 intent 与检索不匹配）|

---

## D10 · 不在检索中使用 completion token 作为唯一判据

| 项 | 内容 |
|---|---|
| **Decision** | usage 只记录，不作唯一判据 |
| **Why** | 实测 `prompt_tokens` 1499 vs 265（输入字节完全相同，差 5.66×）—— **usage 本身不可信** |
| **Alternative Rejected** | 直接用 `completion_tokens` 判定预算耗尽 —— 会得出错误结论 |
| **Trade-off** | 需要更多探针才能得出结论 |
| **Revisit Condition** | provider 解释 usage 计费口径后 |

---

## 待决策

| 项 | 状态 | 决策点 |
|---|---|---|
| E08 schema validation 严格程度 | `open` | 过严误拒 vs 过松漏过 |
| E12 公网后端形态 | `blocked` | Serverless / 容器 / 现有服务 |
| 存储超配额方案 | `open` | IndexedDB / 分片 / 压缩 |
| 是否引入最小测试框架 | `open` | 仅纯函数层 |
---

## D11 · Bridge 侧 fail-closed 校验（P6.3.2）

| 项 | 内容 |
|---|---|
| **Decision** | 在 bridge 返回 HTTP 200 **之前**执行 VisualIntent V1 严格校验；任一违规返回 502 + 机器可读码 |
| **Why** | `result.raw` 原样透传会让错位 intent 静默流入冻结核心（检索/画像信任 intent 合法性）。**Fail open 是 E08 的根因** |
| **Alternative Rejected** | 依赖浏览器侧 `normalizeVisionIntent` 清洗 —— 它是 fail-open（非法枚举→`""`、缺失→补齐），正是问题本身 |
| **Trade-off** | 上游若漏字段会被**全量拒绝**（误拒风险）。已用真实 raw 样本验证兼容（n=1，见 BLOCKING） |
| **Revisit Condition** | 真实 raw 样本累积到 ≥5 份且全部通过后，可评估是否需要分级拒绝 |

| 项 | 内容 |
|---|---|
| **Decision** | 契约常量在 validator 内独立声明，**不 import 冻结模块** |
| **Why** | 避免触碰 `openaiProvider.mjs` 的冻结状态（导入会形成运行时耦合） |
| **Alternative Rejected** | 从冻结模块导出常量 —— 会破坏冻结完整性 |
| **Trade-off** | 存在漂移风险 → 由 `validator-selftest.mjs` **执行**冻结模块捕获真实 schema 并逐项比对（非正则）|
| **Revisit Condition** | 若冻结策略允许，可改为单一事实源 |

| 项 | 内容 |
|---|---|
| **Decision** | 日志只输出 `{code, ruleCounts, violationCount, rulesTriggered}`；移除三处内容输出 |
| **Why** | `violations[].detail` 含用户上传图派生的值；同时移除 `[vision-debug]` 的 preview / bodyHead / localContext |
| **Alternative Rejected** | 保留内容日志加脱敏 —— 掩码后仍可能残留语义内容 |
| **Trade-off** | 排查时无法直接看到内容，需靠 position/line/column 定位 |
| **Revisit Condition** | 无 —— 这是安全底线 |

---

## D12 · 三层 PASS 严格分离（P6.3.2 / E09）

| 项 | 内容 |
|---|---|
| **Decision** | `SCHEMA_VALID` → `BRIDGE_SMOKE_PASS` → （独立门禁）`PROVIDER_RELIABILITY_PASS` |
| **Why** | E09 把三者混为一谈：曾用 2 张图的成功推出 `PROVIDER_GATE = READY` |
| **Alternative Rejected** | 单次运行输出 `PROVIDER_GATE` —— 2 张图无统计意义 |
| **Trade-off** | 判定结果需分三层阅读，报告更复杂 |
| **Revisit Condition** | 无 —— 层次划分是事实性的 |

---

## D13 · reasoning_effort 控制方向暂停（P6.3.3 / 人工决策出口 3）

| 项 | 内容 |
|---|---|
| **Decision** | **采用人工决策出口 3**（用户确认后生效）：放弃 reasoning_effort 作为当前路线的控制手段，不再重复 P6.3.1D 探针，P6.3.1E 当前路线暂停且**不得登记 PASS** |
| **Why** | P6.3.1D 三探针实测 `PASSTHROUGH_UNCONFIRMED`：E0 非法值返回 HTTP 200（该层可能静默剥离字段）、low/max ratio 1.174 不构成档位效应。生产 bridge 的冻结请求体**从不发送** `reasoning_effort`（`openaiProvider.mjs` 仅 `max_tokens:800` + `response_format json_schema strict`），故当前生产路径本就不依赖它；继续调查不产生新信息 |
| **Alternative Rejected** | ① 补充信息后重跑探针 —— 同一 endpoint 的透传行为不会因重跑改变，只消耗付费调用；② 更换 provider —— 重大决策，成本/能力/迁移代价需人工另行评估，本次不启动 |
| **Trade-off** | E02（reasoning 挤占预算）仍 `OPEN`，是 Provider 稳定性的 `BLOCKER`；失去 reasoning 缓解手段后，稳定性只能靠 **P6.3.2 fail-closed 校验 + 分级重试（仅 network/timeout/server）+ 后续 reliability run 实测** 兜底。**风险显式登记**：reasoning 预算问题若导致 `max_tokens:800` 下 content 为空/被吃满，bridge 会返回 502（诚实失败），不伪造成功 |
| **Revisit Condition** | 换 provider / endpoint 升级后重跑 P6.3.1D；或用户明确要求恢复该调查方向 |
| **冻结影响** | ❌ 不改变冻结 Provider 请求参数（`openaiProvider.mjs` 零改动）；✅ P6.3.2 已实施的 fail-closed 校验继续保留 |

---

## D14 · 2-asset bridge smoke 的 attempts 统计口径（P6.3.3，已升级）

| 项 | 内容 |
|---|---|
| **Decision** | client 请求数 = 每资产 **1**（harness 无重试）；provider attempts 由**测试期计数 hook 实测**：`work/p6.3.3/upstream-fetch-counter.mjs` 经 Node `--import` 注入 server 进程，只累加整数 `providerRequests` 写 `work/p6.3.3/upstream-request-count.json`，不读 URL/Key/请求体/图片/响应正文；harness 在 client 请求前后读快照取差值 |
| **Why** | bridge 内部自动重试（`TRANSIENT_REASONS = {network, timeout, server}`）对 client 不可见；**延迟推断（旧口径）不是精确计数**，已被实测方案取代。直接读内部计数器需改冻结 provider（禁止），计数 hook 是唯一不触碰冻结的精确口径 |
| **Alternative Rejected** | ① latency 推断 —— 不精确，已弃用（报告中残留推断一律标 `not-measured`，不得转写为实测）；② 修改 `openaiProvider.mjs` 暴露 attempts —— 触碰冻结文件，禁止 |
| **Trade-off** | hook 通过 `--import` 注入，要求用户以 `node --import ./work/p6.3.3/upstream-fetch-counter.mjs scripts/server.mjs . 4175` 启动 Bridge；计数文件缺失时 attempts 记 `null`+`not-measured`，不猜测 |
| **Revisit Condition** | 冻结面允许在 provider 内加遥测（需显式解冻授权） |

---

## D15 · server.mjs 监听绑定修复（P6.3.3 网络隔离 / 显式解冻授权）

| 项 | 内容 |
|---|---|
| **Decision** | `scripts/server.mjs` 由用户**显式批准解冻**（方案 A，仅监听地址）：`:166` `server.listen(port, () => {` → `server.listen(port, "127.0.0.1", () => {`。不增加 HOST 环境变量；不修改 Provider / Validator / 其他冻结模块；不修改防火墙规则 |
| **Why** | 冻结文件 `server.mjs` 监听无 host 参数 → Windows Node 默认 dual-stack 绑 `0.0.0.0`+`[::]`，叠加 `F:\node.exe` Public Allow 防火墙规则 → 未授权客户端可 POST `/api/vision` 消耗付费额度（STEP 1.4 阻断根因）。显式绑定回环消除暴露面，属安全修复 |
| **Alternative Rejected** | ① 方案 B（`process.env.HOST || "127.0.0.1"`）—— 默认安全但增加可被误配的逃逸开关，与 fail-closed 哲学不符，用户已选 A；② 仅删防火墙规则 —— 用户要求不动防火墙，且 bind 回环是纵深防御的正确第一层 |
| **Trade-off** | 本机只能经 127.0.0.1 访问 Bridge；LAN/公网联调需显式重新解冻。日志 `:167` 本就宣称 127.0.0.1，修复后日志与行为一致 |
| **Revisit Condition** | 需要受信内网/公网访问时，走新的显式解冻授权流程 |
| **冻结影响** | ✅ **显式解冻已授权**（本轮唯一变更）。冻结基线（sha256）：`9F560E6059C26D45E50646F172A1FFEABB0C37D90BD115EC95E006D803157E7D` → `B84EE7BCE159C9D64CB900ECA169C8ABE024BC16C6547285CD57DC6B290E4E94`。零回归：validator 88/88、bridge-e2e 59/59（全 mock 0 真实调用）、build 76 文件 0 违禁、R1–R5 全过 |
