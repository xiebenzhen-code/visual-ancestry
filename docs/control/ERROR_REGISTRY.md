# ERROR_REGISTRY

## P4.14-B/C 来源架构补录（2026-10-20）

本节登记 PHASE B2/B3 与 C1/C2 的结论。阶段报告见 [P4.14-B/C 报告](../P4.14-PHASE-BC.md)。

| ID | 类别 / 状态 | 根因与处置 | 修复提交 / 验证 |
|---|---|---|---|
| LIMIT-P414B-01 | 来源能力局限 / REGISTERED | 四个博物馆 adapter 均输出**真实可解码图像**，但 `analysisLevel = 0`，没有任何视觉特征。它们只能作元数据与图像线索，不能进视觉相似候选池。契约中正确地停在 `IMAGE_AVAILABLE`，**不是被永久排除**。 | 787fe5e 基线；`qa/source/p414-b2-b3.test.mjs` 32/32；`.rc1-audit/p414/step2-contract-verification.md`。 |
| LIMIT-P414B-02 | 许可语义 / REGISTERED | 四个 adapter 不输出 `showable`，只输出 `publicDomain`；`showable` 在 `remoteDiscovery.js:923` 由 `Boolean(publicDomain) && Boolean(image.url)` 算出。四馆的 `publicDomain` 实际是四件不同的事：Rijks=CC PDM 1.0、Cleveland=CC0、Met/AIC=「作品处于公有领域」的布尔（**未对图像再分发作明示授权**）。契约里 Met/AIC 的 `cacheRedistributionAllowed` 记为 `unknown`，`verdict = unconfirmed`，因此不得升到 `RECOMMENDABLE`。 | 未修（需读机构条款）；`src/services/source/candidate.js` 的 `makeRightsEvidence` 四问分离。 |
| BUG-P414B-01 | 图像可用性 / REGISTERED | **AIC 图片返回 HTTP 403**：记录有 `image_id`、URL 拼得出来，但 CDN 拒绝。若只看「有没有 URL」，该候选会被误报成可用图像。契约增加 `imageVerification` / `imageStatus`，明确失败即退回 `metadata-only`。 | 契约已加固；AIC 403 本身未解（未在其 API 文档中找到明确说明）。验收记录见 `.rc1-audit/p414/step2-contract-verification.md`。 |
| LIMIT-P414B-03 | 判据结构局限 / REGISTERED | 双色 Technicolor 的色相天然收缩在 **8–13°**（实测该片四张素材 10.7°/12.3°/13°/8°），`minHueSpread: 25` 对这套工艺**结构性不可达**。此前文档把 Gold Diggers 被排除归因为「16mm 扫描件偏暗、颗粒重」，**该归因是错的**，已改正三处文档。**不降阈值、不补影片事实，维持保守排除。** | 787fe5e 之后的三处文档修订；`qa/find/monochrome-gate.test.mjs` 28/28 仍锁住当前行为。 |
| BUG-P414B-02 | 路径不一致 / REGISTERED | **远程门控不查影片级事实**：`judgeFilmCandidate`（`monochromePolicy.js:238`）会短路，但远程路径 `remoteReferences.js:363` 调的 `gateRemoteFilmByColor`（`filmColorGate.js:140`）直接 `classifyChroma`，从不 import `FILM_COLOR_FACTS`；且远程 id 为 `remote-film:${sourceId}`，与 `film-*` 命名空间对不上。**给 Gold Diggers 补影片事实对远程候选零效果。** | 未修（属设计变更：需让远程门控按片名/QID 接受影片级事实），本轮明确不做。 |
| LIMIT-P414B-04 | 来源缺口 / REGISTERED | **现代日本动漫帧无法合法获取**。五来源实测：Commons 仅公版区（约 1914–1929，且全部黑白）、Openverse 依赖上游、Internet Archive 缩略图仅 160×110、AniList 只有元数据、TMDB 明确 REJECT。结论：不用海报冒充镜头，动漫分类如实留空。 | 调查记录见阶段报告 §5；未接入任何动漫素材。 |
| LIMIT-P414B-05 | 分类局限 / REGISTERED | 影片的 `traditions: ["电影"]` 是媒介名而非创作传统，若原样透传会得到同义反复。`mediaTaxonomy.js` 以 `NON_TRADITION_LABELS` 排除。另：`medium:"film"` **不能**推出 `visualForm:"live-action"`——没有事实的影片一律 `unknown`，防止将来接入动画片被默认错标。 | `qa/source/p414-b2-b3.test.mjs` 32/32。 |

---

## P4.13-F 入口一致性补录（2026-10-20）

本节只登记 P4.13-F 的修复与新增局限，不重写 P4.10 / P4.12 的历史状态。根因审计全文见 `.rc1-audit/P4.13-R-RELEVANCE-AUDIT.md`（该目录被 gitignore，属审计证据区）。

| ID | 类别 / 状态 | 根因与处置 | 修复提交 / 验证 |
|---|---|---|---|
| BUG-P413F-01 | 入口一致性 / RESOLVED | 三个入口各自拼 `enhanced`：上传图传像素签名，作品页与 FIND 选画不传。同一作品因此给出互斥的第一名（作品页 birth-of-venus 31.4 / 上传 utamaro-three-beauties 26.5）。处置：新增 `ENHANCEMENT_EVIDENCE`（`uploaded-pixels` / `archive-signature` / `none`）与 `buildEnhancement()`，三个入口统一走它；证据不同时记录 `querySignatureOrigin` 与 `degradation`，不强行让结果相同。 | a4a9ce3fe4237ff2dff2eb82902f4a6e2e1df08f；`qa/find/p413f-entry-consistency.test.mjs` 28/28；真实 Edge 浏览器验证作品页与 FIND 选画前 4 名逐位一致（18/18），截图见 `.rc1-audit/p413f/shots/`。 |
| BUG-P413F-02 | 缓存串门 / RESOLVED | `intentOf()` 的缓存键是 `` `${artwork.key}|${intentSource}` ``。调用方传 `{id}` 这类缺 key 的对象时，键退化为 `undefined|auto`，**所有作品共用同一缓存槽**：先查的作品把 intent 写给后来者（实测 `{id:"starry"}` 与 `{id:"wanderer"}` 返回完全相同的 Top5）。处置：身份改为「key，否则 id」，无身份时不缓存。 | 同上提交；回归用例「starry 与 wanderer 的 Top3 不相同」「重复查询同一作品结果稳定」。 |
| BUG-P413F-03 | 静默回退 / RESOLVED | `retrieveByArtwork()` 对 null、空对象、未知 key/id 一律走 `intentOf → intentFromArtwork`，产出一份**看似正常但不相关**的榜单，且不报错。处置：新增 `resolveRetrievalArtwork()` 与 `retrieveByArtworkChecked()`，返回 `not-an-object` / `missing-key` / `unknown-artwork` 且 `results: []`；仅靠 id 兜住时 `resolution: "id"` 必须可见。页面改用 checked 并显式渲染错误。 | 同上提交；回归用例 9 类无效输入全部拒绝；浏览器验证 `#artwork/local:does-not-exist` 显示「未找到该作品」且无任何关系行。 |
| LIMIT-P413F-01 | 判别力局限 / REGISTERED | American Gothic 与《维纳斯的诞生》在 19 个加权字段中 **18 个完全相同**（仅 `saturation` 不同），因此 31.4 分不是算错，是字段无法表达差异。离线对照三方案（A 现算法 / B 置零高频常量字段 / C 池内 IDF 频次修正）后，**三者下 birth-of-venus 仍为第一名**；两组向量完全碰撞（`fan-kuan-travelers ≡ shitao-album`、`guo-xi-early-spring ≡ fuchun-mountains`）在任何按字段加权的方案下**都无法解除**。结论：不是权重问题，缺的是画幅方向、构图骨架、人数主次、道具、场景类型等维度。**未上线任何新算法。** | a4a9ce3（仅记录，未改算法）；`.rc1-audit/p413f/step2-report.md`，脚本自证 2070 对比较、与生产偏差 0.000。待用户标注支持后再决定是否调整正式相关性算法。 |
| RISK-P413F-01 | 入口覆盖 / REGISTERED | FIND 的作品选择器只暴露池内前 8 件（`find.js:182` 的 `slice(0, 8)`），American Gothic 在池内第 23 位，两个入口**无法对同一件作品做端到端对照**。浏览器验证因此改用两边都可到达的 `local:wanderer`。这是覆盖限制，不是一致性问题。 | 未修复（超出本轮范围）；一致性结论由单元测试覆盖 5 件作品（含 american-gothic）。 |
| RISK-P413F-02 | 工作区状态 / REGISTERED | 工作区存在**上一轮 P4.13 彩色参考工作**的未提交改动（`src/services/retrieval/monochromePolicy.js`、`qa/find/remote-discovery-wiring-test.mjs`）。该改动使 `qa/find/monochrome-gate.test.mjs` 出现 4 项失败（20/24）。已实测确认：把该文件还原到 HEAD 后为 **24/24 全过**，故这 4 项**与本轮提交无关**，也没有被本轮修复掩盖。 | 本轮未纳入提交、未回退用户未完成的工作；`git status` 中可见。是否继续或回退该实验需用户决定。 |

---

## P4.10 定向复验补录（2026-10-19）

本节仅更新下列事项，不重写历史 E01–E15 的状态。完整复现与边界见 [P4.10 复验报告](../P4.10-FIX-REVALIDATION.md)。

| ID | 类别 / 状态 | 根因与处置 | 修复提交 / 验证 |
|---|---|---|---|
| BUG-P410-01 | 运行时缺陷 / RESOLVED | filmVisionRerank 的 b.s - s.s 引用未声明 s；仅改拼写仍将 {score,possible} 对象相减产生 NaN。修复读取数值 score，缺失 intent 置后。 | 119e229e48a1c962c3abee63e306f728b8240857；qa/p410-fix-regression.mjs 完整函数新旧对照，所属套件 9/9 PASS；注入 MOCK，无真实 Provider 调用。 |
| BUG-P410-02 | 页面缺陷 / RESOLVED | #find 不渲染上传控件，却无条件绑定监听，null 解引用中断 renderFind；增加控件存在性保护。 | 同上提交；qa/p410-find-edge.mjs 真实 Edge 路由、搜索、预览/移除及历史响应回放 10/10 PASS。旧模块替换可重现 TypeError；未声称旧提交全量 E2E。 |
| LIMIT-P410-01 | 实验算法局限 / REGISTERED | 像素描述子无法可靠区分裁切同图与异图；不是已修复缺陷。 | 不参与排序，只附加旁证；逆序像素距离下 A/B/C 顺序保持，状态 pixel-compared；艺术相关性尚未独立验收。 |
| RISK-P410-01 | 网络测试风险 / REGISTERED | 历史 p49 同基线出现 25/25、23/25、18/25；Commons 限流是历史报告归因，本轮未独立重证。 | 本轮定向测试隔离外网；不得将未重跑的线上套件写为通过。 |
| RISK-P410-02 | QA race 风险 / REGISTERED | 历史多实例 Edge / 端口竞争污染结果。 | 本轮隔离 profile、浏览器串行、端口占用即失败；旧测试框架并未全局修复。 |

以下保留原控制层记录作为历史，不以原文“当前”字样覆盖本节的窄范围实证。

---


**更新日期**：2026-10-08
**规则**：已解决问题**不得删除**，标 `FROZEN`；除非出现新证据，不得重新调查。

---

## 状态枚举

| 状态 | 含义 |
|---|---|
| `OPEN` | 未解决 |
| `RESOLVED` | 已修复并验证 |
| `FROZEN` | 已解决且代码冻结，不得回归 |
| `BLOCKED` | 需外部条件 |
| `REGISTERED` | 已登记留痕，当前无解|

---

## 现行问题

| ID | Layer | Symptom | Root Cause Status | Evidence | Impact | Status | Fix | Validation | Do Not Repeat | Deployment Blocking |
|---|---|---|---|---|---|---|---|---|---|---|
| **E01** | Provider | `max_tokens` 加倍后仍空响应 | **REJECTED**（已证伪） | D2 `max_tokens=1600` → `1600/1600`、`finish_reason=length`、`content_len=0` | 曾被误当根因 | `FROZEN` | 转向 reasoning 档位（E02） | 已由 D2 实测闭环 | 不要再把 max_tokens 当单因修复 | No |
| **E02** | Provider | reasoning 挤占预算，结果时好时坏 | **STRONG_HYPOTHESIS** | D1 `395/800` 成功；D2 `1600/1600` 全被 reasoning 吃光 | 视觉理解不稳定 | `OPEN` | `reasoning_effort: "low"` | P6.3.1D 三探针 → P6.3.1E | 不要再假设「加 token 就能解决」 | **Yes** |
| **E03** | Provider | `reasoning_effort` 是否透传未知 | **UNCONFIRMED** | 官方支持三档；第三方层行为未知 | 决定 E02 能否修 | `OPEN` | 透传验证 | P6.3.1D | 不要假设文档能力 = 端点能力 | **Yes** |
| **E04** | Harness | `rejected(E1)` 把任意 4xx 当「low 不支持」 | **RESOLVED** | 401/429/5xx 都返回 4xx/5xx | 误判 unsupported | `FROZEN` | `isReasoningEffortUnsupportedError()` | 20 项 E1 guards | 不要用通用拒绝推断参数语义 | No |
| **E05** | Harness | `low/high/max` 裸出现被当参数错误 | **RESOLVED** | `"priority supports low and high"` 会误判 | 假阳性 | `FROZEN` | 要求 reasoning 语境 + allowed 语言 + 三值齐全 | 16 项 regex guards | 不要只凭枚举值判断 | No |
| **E06** | Provider | `prompt_tokens` 1499 vs 265（输入字节相同） | **REGISTERED** | D1/D2 差 5.66× | usage 不可作因果证据 | `REGISTERED` | 需 provider 方解释 | provider 侧说明 | **不要用 usage 当唯一判据** | No |
| **E07** | Provider | `content_len` 与 `reasoning_len` 同为 605 | **REGISTERED** | D1 实测 | 疑响应形态异常 | `REGISTERED` | 需原始响应体 | 取 raw body 比对 | 不要假定两者独立 | No |
| **E08** | Bridge | `result.raw` 原样透传，字段错位也返回 200 | **RESOLVED** | 1×1 探针返回 10 个错字段但 `ok:true` | 错误 intent 静默流入冻结核心 | `FROZEN` | P6.3.2 接入 strict V1 validator（fail closed）| 88 项离线 + 59 项 bridge E2E | 不要在 bridge 层信任上游 JSON | No |
| **E09** | Harness | `provider-smoke` 要求 `intent.source==="vision"`，但 `buildSchema` 不产出该字段 | **RESOLVED** | 同上 | 成功也会被判失败 | `FROZEN` | P6.3.2 改为判定 raw 22 字段契约 | SCHEMA_VALID / BRIDGE_SMOKE_PASS 分层 | 不要用失效判定器决定 GATE | No |
| **E10** | Provider | `json_schema` 可能从未生效 | **STRONG_HYPOTHESIS** | 多方实测 GLM-5.3 静默忽略 strict schema | 22 字段结构保证失效 | `OPEN` | 结构保证改由 prompt + 客户端校验 | P6.3.2 | **不要假设 `strict:true` 有效** | **Yes** |
| **E11** | Provider | film 83,401 ms > 60,000 ms 预算 | **CONFIRMED** | 60,000（超时）+ 23,401（重试）精确吻合 | 重试放大延迟与费用 | `FROZEN` | 已按真实 attempt 数记录 | 已闭环 | **不要声称「在预算内」** | No |
| **E12** | Deployment | 无公网 Vision 后端 | **CONFIRMED** | 仅 `scripts/server.mjs` 本地 | 公网部署不可用 | `BLOCKED` | 需安全后端方案 | 见 `DEPLOYMENT_READINESS.md` | 不要把本地 server 直接暴露公网 | **Yes** |
| **E13** | Validation | Balanced-60 被阻塞 | **BLOCKED** | 依赖 Provider Gate | 无可靠性数据 | `BLOCKED` | 待 E02/E03 解决 | mini reliability → Balanced 60 | 不要跳过前置 Gate | **Yes** |
| **E14** | Toolchain | 无单元测试框架 | **CONFIRMED** | `package.json` 无 `test` script；无 `tests/` 目录 | 回归靠人工 | `OPEN` | 见 MEA-01 | — | 不要假设有测试保护 | No |
| **E15** | Provider | `openaiProvider.mjs:158` 打印上游响应前 200 字符 | **RESOLVED** | 三处已移除：`preview`、`bodyHead`、`localContext/carets` | 泄漏已消除 | `FROZEN` | 改为仅记结构事实（status/bytes）| grep 确认无内容输出 | 不要在生产打印原始响应 | No |

---

## 已解决 · FROZEN（不得重新调查）

| ID | Layer | Symptom | Resolution | 状态 |
|---|---|---|---|---|
| **E-OLD-01** | Provider | 上游 `API_KEY_DISABLED` | 换用ENABLED key | `FROZEN` |
| **E-OLD-02** | Source | Rijks `subject=` 直接 400 | 改 `description=` / `title=` | `FROZEN` |
| **E-OLD-03** | Source | Rijks IIIF 拼接路径 404 | 用顶层 `isShownBy.id` | `FROZEN` |
| **E-OLD-04** | Cache | 单 sha256 永不命中 | 双层键 `(source, sourceId)` | `FROZEN` |
| **E-OLD-05** | Cache | 失败不写 ledger → 无法自证 | 每次尝试都记录 | `FROZEN` |
| **E-OLD-06** | Film | 海报被当彩色画面 | `/poster/i` 过滤 + 类别排除 | `FROZEN` |
| **E-OLD-07** | Film | 码头照片通过剧照分类器 | 按类别排除（非文件名）| `FROZEN` |
| **E-OLD-08** | Source | `asian-art` 主题仅 33% 真实 | 改用结构化字段核验 | `FROZEN` |
| **E-OLD-09** | Toolchain | localhost 代理伪造 502 | `net.connect()` 自校准 | `FROZEN` |
| **E-OLD-10** | Toolchain | 端口被测试进程占用 | 验证前先查端口 | `FROZEN` |
| **E-OLD-11** | Cache | 仓库脚本精度不足（3 源）| 修正参数与字段路径 | `FROZEN` |
| **E-OLD-12** | Retrieval | 关键词命中 ≠ 类别正确（8 例）| 改用结构化字段 + 内容哈希 | `FROZEN` |

> **12 项已修复并验证。** 除非出现新证据，**不得重新调查**。

---

## Solution Matrix

| Problem | Immediate Fix | Long-term Fix | Why | Cost | Risk | Validation Gate |
|---|---|---|---|---|---|---|
| **reasoning instability** (E02) | 验证 `reasoning_effort: "low"` | 有效则纳入 bridge 默认配置 | reasoning 吃满输出预算是唯一被观测到的机制 | 零 | 低：单参数 | P6.3.1D → P6.3.1E |
| **schema uncertainty** (E08/E10) | 无（暂不修） | Server-side schema validation：字段名 ⊆ schema、类型校验、失败返非 200 | bridge 只透传不校验 | 零 | **中**：过严会拒掉可接受偏差 | P6.3.2 |
| **provider instability** (E02/E11) | Provider Adapter 隔离 | reasoning 控制 + 分级重试 | 让 provider 差异止于 adapter | 零 | 低 | 2-asset smoke |
| **secret exposure** | 已满足 | 部署时用 secret manager，禁止落盘 | 浏览器永远拿不到凭据 | 部署成本 | **高** | 公网前必须审计 |
| **API cost** | cache（已实现） | 只分析选中资产 | 每张图 = 一次付费调用 | **决定运营成本** | 中 | cache-proof 8/8 |
| **large corpus** | 按需检索（已验证） | search → candidates → analyze selected → cache | 预下载 = N×(搜索+下载) | 避免 202.6 MB / 20× 超配额 | 低 | 三源 11/11 已验证 |
| **usage 不可信** (E06) | 不用 usage 作判据 | 找 provider 核实计费口径 | 差 5.66× 会误导量化结论 | 零 | 低 | 需 provider 配合 |
| **Bridge 判定失效** (E09) | 暂不用于 GATE | 重写 pass 条件或依赖浏览器归一化 | 判定器与真实契约不符 | 零 | 中 | 重新定义 schema-valid |
| **无测试框架** (E14) | 继续用 `qa/*.mjs` + sha256 冻结 | 为纯函数层补最小测试 | `scoring.js` 等是纯函数，易测 | 低 | 低 | MEA-01 |
| **日志泄漏** (E15) | 部署前移除 `[vision-debug]` | 统一日志脱敏层 | 上游响应可能含敏感内容 | 零 | 中 | MEA-08 |

---

## 关键依赖链

```
E03（透传未知）── 关键路径起点
  └─→ E02 能否修 ─→ E13 能否解锁 ─→ mini reliability ─→ Balanced 60

E08 + E10（schema 双重不确定）── 独立支线
  └─→ 即使 reasoning 修好也必须做

E12（无公网后端）── 可并行
E14（无测试框架）── 可并行
E15（日志泄漏）── 部署前必须处理
```

**结论**：E03 是当前唯一关键路径起点。E12/E14/E15 可并行且不依赖 E03。