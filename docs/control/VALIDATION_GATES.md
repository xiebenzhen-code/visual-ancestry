# VALIDATION_GATES

**唯一阶段链**。禁止跨 Gate。

```
P6.3.1D → P6.3.1E → P6.3.2 → 2-asset bridge smoke
        → mini reliability → Balanced60 → secure public deployment
```

---

## Gate 定义

### P6.3.1D — reasoning_effort 透传隔离

| 项 | 内容 |
|---|---|
| **Entry Conditions** | harness offline selftest 全 PASS；凭据已注入用户 PowerShell |
| **Test** | E0_INVALID / E1_LOW / E2_MAX 三探针，text-only，各 **1 个请求**，**无 retry**（本 Gate 直连上游，**不经过 bridge**，故不存在 bridge 内部重试层）|
| **Pass Criteria** | `PROVIDER_REASONING_EFFORT_PASSTHROUGH = CONFIRMED` |
| **Failure Action** | 见下方「不明确结果处理」—— **暂停，交人工决策** |
| **Human Operation** | ✅ **是** —— 【人工操作 1】需真实凭据 + 付费调用 |
| **Next Gate** | 仅 `CONFIRMED` → P6.3.1E；其余 → **不自动前进** |

**当前状态**：`open` — harness ready（offline selftest `exit 0`，118 PASS / 0 FAIL）

#### 实际执行结果（2026-10-08T03:58:07Z，人工执行）

| 探针 | HTTP | `finish_reason` | reasoning_len | content_len | 延迟 |
|---|---|---|---|---|---|
| E0（`"__invalid_control__"`）| **200** | stop | 39 | 2 | 6 477 ms |
| E1（`low`）| 200 | stop | 135 | 2 | 11 420 ms |
| E2（`max`）| 200 | stop | 115 | 2 | 5 500 ms |

```
REASONING_EFFORT_PARAMETER_RECOGNIZED = UNCONFIRMED
REASONING_EFFORT_EFFECT_OBSERVED    = NO
REVERSE_DIFFERENCE_OBSERVED         = NO
OUTCOME = PASSTHROUGH_UNCONFIRMED
ratio = 135/115 = 1.174（需 ≤0.6 才算档位效应）
CREDENTIAL_LEAK_CHECK = CLEAN
```

**结论解读**：E0 非法值返回 **HTTP 200** —— 该层**可能静默剥离字段**。
ratio 1.174 不构成档位效应。三探针均为正常 200，无 error code。

**当前状态**：`PASSTHROUGH_UNCONFIRMED` → 依下方流程**暂停**，等待人工决策。

#### P6.3.1D 非 CONFIRMED 结果的统一处置

**所有非 `CONFIRMED` 结果 —— 无论 `PASSTHROUGH_UNCONFIRMED`、
`PARAMETER_SUPPORTED_EFFECT_INCONCLUSIVE` 还是
`PROVIDER_REASONING_EFFORT_UNSUPPORTED` —— 统一执行同一流程：**

```
暂停
  ↓
审查本次响应（error code / message / reasoning 长度 / finish_reason）
  ↓
审查 Provider 文档与协议层说明
  ↓
人工决策
```

**明确禁止**：

| 禁止行为 | 原因 |
|---|---|
| ❌ **自动更换 provider** | 换provider 是重大决策，需人工判断成本/能力/迁移代价 |
| ❌ **自动进入下一 Gate** | 未确认 = 门禁未通过，跨Gate 会使后续验证全部失效 |
| ❌ 自动重试同一 harness | 同一探针重复不会产生新信息 |
| ❌ 把「不明确」乐观假设为「支持」 | 不确定 ≠ 通过 |

**「不明确」的真实含义**：证据不足以判定。
它既不能证明方案成立，**也不能证明方案不成立**——
只说明当前探针无法分辨，需补充信息（响应审查 / 文档审查 / 人工判断）。

**人工决策的三个可能出口**（由人选择，agent 不得代选）：

1. 补充信息后重跑（如发现该层文档有透传说明）
2. 更换 provider（人工决定）
3. 放弃 reasoning 控制方向，转而依赖其他缓解手段

#### 判定分层说明

| 判定 | 含义 | 能否进入 P6.3.1E |
|---|---|---|
| `REASONING_EFFORT_PARAMETER_RECOGNIZED` | 端点是否识别该参数 | 供参考 |
| `REASONING_EFFORT_EFFECT_OBSERVED` | low/max 是否有方向一致差异 | 供参考 |
| **四类 outcome** | 综合结论 | **仅 `CONFIRMED` 可前进** |

`PARAMETER_RECOGNIZED = YES` **单独不足以**进入下一 Gate ——
还需 `EFFECT_OBSERVED = YES`（即outcome 为 `CONFIRMED`）。

---

### P6.3.1E — LOW/MAX painting 对照

| 项 | 内容 |
|---|---|
| **Entry Conditions** | P6.3.1D = `CONFIRMED`（仅此一种结果可进入）|
| **Test** | LOW 与 MAX 各对 painting 一次 |
| **Pass Criteria** | 见下方「单样本 INCONCLUSIVE 规则」 |
| **Failure Action** | 见下方「单样本 INCONCLUSIVE 规则」 |
| **Human Operation** | ✅ **是** —— 【人工操作 2】付费调用 |
| **Next Gate** | P6.3.2（**无论成败** —— E08/E10 独立于 reasoning）|

#### ⚠ 单样本 INCONCLUSIVE 规则（重要）

P6.3.1E 是**每档仅 1 次调用**。单样本**不产生稳定性或有效性结论**。

| 单次观测结果 | 判定 | 说明 |
|---|---|---|
| LOW reasoning ≤ MAX 的 60% 且 content 非空 | `EFFECT_OBSERVED`（**仅本样本**）| 单次观测**不构成**缓解生效的结论 |
| ratio > 0.6（差异不足）| `INCONCLUSIVE` | **可能是抖动**（见下方抖动阈值）|
| 任一档 HTTP 非 200 / content 空 | `INCONCLUSIVE` | 无法比较|
| 任一档返回 500/503 等瞬时错误 | `INCONCLUSIVE` | 需重试（人工授权后）|

**INCONCLUSIVE 的处置**：

```
不自动重试（可能只是抖动）
  ↓
标记 INCONCLUSIVE，进入 P6.3.2
  ↓
若需更多样本 → 人工授权后重复执行
```

**禁止表述**：
- ❌ 「单次差异即证明 reasoning 可控」
- ❌ 「单次无差异即证明 reasoning 不可控」
- ❌ 「INCONCLUSIVE = 通过」或「= 不通过」

**INCONCLUSIVE 不阻塞 P6.3.2** —— E08/E10 独立于 reasoning，
无论本 Gate 结论如何，schema gate 都必须实施。

> **抖动阈值**：单次 reasoning 长度差 < 40% 时视为抖动
> （依据：既有实测中相同配置下 reasoning 长度差可达数倍，
> 但 1.174 这类小幅差异不构成档位效应）。

#### 请求契约：保持生产完整形态

P6.3.1E 的结论**要用于生产决策**，因此请求必须是**生产完整契约**。
唯一变量是 `reasoning_effort`。

| 参数 | 取值 | 说明 |
|---|---|---|
| `model` | `glm-5.3` | 生产值 |
| `endpoint` / key | 与生产同一 | 换层则透传能力不同 |
| `temperature` | `0` | 生产值 |
| `max_tokens` | 生产值（bridge 默认 800）| **直接影响 reasoning 预算** |
| `response_format` | **保留 `json_schema` + `strict` + `buildSchema()`** | **两组都必须带，且完全相同** |
| 图像 | 同一张 painting | 不同图 reasoning 长度不同 |
| `reasoning_effort` | **唯一变量** | `low` vs `max` |

**关键：两组都带完全相同的 `response_format`。**

这样做的理由：
- 结论**直接适用于生产** —— 生产路径本就带 schema
- 若 LOW 档在带 schema 时 reasoning 仍显著更短 → 缓解手段在生产中同样有效
- 若不带 schema，测出的差异无法证明生产场景下的行为

> **E10（`json_schema` 可能从未生效）不改变此契约。**
> 该问题由 **P6.3.2** 负责；P6.3.1E 的变量是 reasoning，与 schema 效力**是两个独立问题**。
> 把 schema 从实验中移除会引入偏差，而不是消除偏差。

> **一致性判据**：若任何参数偏离上表，结论**不得**用于生产决策，
> 且必须在报告中显式声明偏差。

---

### P6.3.2 — schema-validation gate（独立立项）

| 项 | 内容 |
|---|---|
| **Entry Conditions** | 无（**不依赖** P6.3.1E 结果）—— ✅ 已满足 |
| **Test** | ✅ **已完成**：88 项 validator 离线测试 + 59 项 bridge E2E（mock provider，0 真实 API）|
| **Pass Criteria** | ✅ **已达成**：22 必填齐全 · 类型合法 · 枚举合法 · 额外字段拒绝 · 非对象拒绝 · fail closed |
| **Human Operation** | ✅ 已完成（无需人工，为纯代码变更）|
| **Next Gate** | 2-asset bridge smoke |

#### 必须验证的五类规则

| # | 规则 | 要求 |
|---|---|---|
| 1 | **22 个必填字段齐全** | `buildSchema().required` 的 22 个字段**全部存在**；缺任一 → 拒绝 |
| 2 | **字段类型正确** | enum 字段为 `string \| null`；`emotion`/`atmosphere` 为 `Array` |
| 3 | **枚举值合法** | 非 null 的 enum 值必须属于 `ENUM_FIELDS` 对应列表；列表项必须在 token whitelist 内|
| 4 | **缺失字段处理** | 缺失即拒绝，**不做补齐、不填 null 掩盖** |
| 5 | **额外字段处理** | 出现 schema 外的字段即拒绝（对齐 `additionalProperties: false`）|

#### Fail closed（强制）

**校验失败必须返回错误，不得放行。**

| 情形 | 行为 |
|---|---|
| 字段缺失 / 类型错 / 枚举非法 / 额外字段 | ❌ **拒绝**，返回非 200 + 机器可读错误码 |
| 上游返回非 JSON | ❌ **拒绝** |
| 上游超时 / 网络失败 | ❌ **拒绝** |
| 合法 intent | ✅ 通过 |

**禁止「部分放行」**：
不得因「字段大部分正确」而接受；不得自动丢弃未知字段后返回成功；
不得用默认值填补缺失字段。

> 当前 bridge 的行为（`server.mjs:121` `result.raw` 原样透传）
> 是 **fail open** —— 这是 E08。本Gate 的目标就是改为 fail closed。

#### 不得修改冻结的 V1 schema

| 项 | 约束 |
|---|---|
| `buildSchema()` 的 22 个字段定义 | ❌ **不得修改** |
| `ENUM_FIELDS` 的枚举值 | ❌ **不得增删** |
| `EMOTION_TOKENS` / `ATMOSPHERE_TOKENS` | ❌ **不得修改** |
| 字段数量 | ❌ **保持 22** |

**校验层是schema 的执行者，不是schema 的定义者。**
若认为 schema 本身需要变更，那是独立的架构决策，
须走 `DECISION_LOG` 流程并单独评估对冻结检索链的影响。

**不可跳过**：若 E10 成立（`json_schema` 从未生效），bridge 依赖它保证 22 字段的假设**一直是错的**。

> **本 Gate 已完成（2026-10-08）**。bridge 侧现已独立校验，
> **不再依赖 `json_schema` 是否生效** —— 契约由 validator 强制执行。

---

### 2-asset bridge smoke

| 项 | 内容 |
|---|---|
| **Entry Conditions** | P6.3.2 完成；本地 bridge 运行中（4175 LISTENING）|
| **Test** | painting + film 各 **1 个请求**，**client 侧无 retry** |
| **Pass Criteria** | 两者均 schema-valid → **`BRIDGE_SMOKE_PASS`** |
| **Failure Action** | `BRIDGE_REQUEST_OR_RUNTIME_DIFFERENCE = CONFIRMED` → 进入 request-parity diff；**不得直接归因 provider capability** |
| **Human Operation** | ✅ **是** —— 【人工操作 3】启动带真实 env 的 bridge |
| **Next Gate** | mini reliability run |

#### Retry / Attempts 验收契约（精确）

**「无 retry」指 client harness 不重试，但 bridge 内部存在自动重试。**

```
work/p6.3.1c/provider-smoke.mjs   ← client harness
        │  每个资产发 1 个 POST /api/vision（自身无 retry 逻辑）
        ▼
scripts/server.mjs → openaiProvider.callVisionProvider
        │
        ├─ attempt() 第 1 次
        │    └─ 若 reason ∈ TRANSIENT_REASONS(network|timeout|server)
        │        → attempt() 第 2 次      ← 内部自动重试
        ▼
    返回结果
```

源码依据：`server/vision/openaiProvider.mjs:134` `TRANSIENT_REASONS`
与 `:269-271` 的 `if (!result.ok && TRANSIENT_REASONS.has(result.reason)) result = await attempt();`

| 层级 | retry 行为 | 上限 |
|---|---|---|
| **client harness** | ❌ **不重试** | **1 请求/资产** |
| **bridge（server）** | ⚠ **自动重试 1 次**，仅限 `network` / `timeout` / `server` | **2 请求/资产** |

**推论**：
- `empty-response` **不在** `TRANSIENT_REASONS` → 只请求 1 次
- 实测 film 83,401 ms = 60,000（首轮超时）+ 23,401（第二轮）→ **该资产实际发了 2 个请求**

**验收要求**：

| 项 | 要求 |
|---|---|
| 记录字段 | 每资产必须记录 `attempts`（实际请求数）与 `latencyMs` |
| attempts > 2 | ❌ 异常，需排查是否存在多重重试 |
| attempts = 2 且 `latencyMs > 60,000` | ⚠ 说明首轮超时，**不得**计入「无 retry」 |
| 报告表述 | 必须同时给出「client 请求数」与「bridge attempts」两个数字 |

> 此前文档把该gate 描述为「各 1 次」，**不准确** ——
> 那是 client 侧请求数，bridge 侧可能为 2 次。

#### 三个 PASS 严格分离，不可互相替代

| 名称 | 产生于 | 证明什么 | **不**证明什么 |
|---|---|---|---|
| **`BRIDGE_SMOKE_PASS`** | 2-asset bridge smoke | 该配置下**至少成功过一次** | ❌ 不证明稳定性 |
| **`PROVIDER_RELIABILITY_PASS`** | mini reliability run | **成功率**与延迟分布 | ❌ 不证明跨媒体效果 |
| **`PROVIDER_GATE_READY`** | 上述**两者都通过**后 | provider 达到可用门槛 | — |

**禁止的表述**：
-❌ 「两张图片成功了，provider 稳定」→ 两张图无统计意义
- ❌ 「`BRIDGE_SMOKE_PASS` = `PROVIDER_GATE_READY`」→ 二者不等价
- ❌ 「单次成功证明 reasoning 不稳定」→ 反之亦然，单次成功不能证明稳定

**`PROVIDER_GATE_READY` 的前置条件（两个都必须满足）**：

```
BRIDGE_SMOKE_PASS          = true
PROVIDER_RELIABILITY_PASS  = true
                            ↓
                   PROVIDER_GATE_READY
```

> **E02 的本质是「时好时坏」**。
> D1（`max_tokens=800`）成功与 D2（`max_tokens=1600`）用尽
> **是不同配置的两次单次调用**（见「D1/D2 配置差异」说明），
> 它们已展示结果可因配置而异 —— 但**都不构成稳定性证据**。

### 付费 API 人工授权

本 Gate 与其后的所有 provider 测试**均产生真实费用**。
必须由人工显式授权执行，coding agent **不得自动运行**。

| Gate | 是否付费 | 规模 | 人工标记 |
|---|---|---|---|
| P6.3.1D 三探针 | ✅ text-only × 3 | 小 | 【人工操作 1】|
| P6.3.1E LOW/MAX | ✅ 含图片 × 2 | 小 | 【人工操作 2】|
| 2-asset smoke | ✅ 含图片 × 2 | 小 | 【人工操作 3】|
| **mini reliability** | ✅ 重复多次 | 中 | **【人工授权后执行】** |
| **Balanced 60** | ✅ **60 次** | 大 | **【人工授权后执行】** |

**授权含义**：用户在有凭据的 PowerShell 手动执行 = 显式授权。
Coding agent 仅负责准备 harness 与解读结果，**不得自行发起调用**。

---

### mini reliability run【人工授权后执行】

| 项 | 内容 |
|---|---|
| **Entry Conditions** | `BRIDGE_SMOKE_PASS = true` |
| **Test** | 小样本**重复**运行，测成功率与延迟分布 |
| **Pass Criteria** | 成功率与延迟达到阈值（阈值需标定）→ **`PROVIDER_RELIABILITY_PASS`** |
| **Failure Action** | 成功率不足 → 暂停，交人工决策（同 P6.3.1D 流程）|
| **Human Operation** | ✅ **【人工授权后执行】** —— 重复调用产生累计费用，**不得自动消耗额度** |
| **Next Gate** | Balanced 60 |

**前置**：Entry Conditions 是 `BRIDGE_SMOKE_PASS`（不是 `PROVIDER_GATE_READY`——
后者需要本Gate 通过后才能得出，逻辑上不能作为自己的前置）。

**不可省**：E02 本质是「时好时坏」。**两张图片单次成功不构成稳定性证据。**

---

### Balanced 60【人工授权后执行】

| 项 | 内容 |
|---|---|
| **Entry Conditions** | `PROVIDER_RELIABILITY_PASS = true`；60 张平衡集已构建（5/5 检查通过）|
| **Test** | 30 绘画（met14/aic14/rijks2）+ 30 电影帧 |
| **Pass Criteria** | 跨媒体检索 ≥ 9/10 |
| **Failure Action** | 不达标 → 分析失败维度（intent 质量 / 覆盖度 / 类别正确性）|
| **Human Operation** | ✅ **【人工授权后执行】** —— **60 次付费调用**，成本可观，**不得自动消耗额度** |
| **Next Gate** | secure public deployment |

**成本提示**：60 次调用是本项目最大的单次支出项。
执行前应确认 provider 额度与计费方式。

**前置**：不可跳过前序任何 Gate。

---

### secure public deployment

| 项 | 内容 |
|---|---|
| **Entry Conditions** | **`PROVIDER_GATE_READY = true`**（smoke 与 reliability 均通过）**且 Balanced 60 已通过** |
| **Test** | 见下方六项验收清单 |
| **Pass Criteria** | 六项**全部**通过 |
| **Failure Action** | 任一项失败 → **阻止部署**，退回对应整改 |
| **Human Operation** | ✅ **是** —— 【人工操作 4】公网 / 不同网络测试 |
| **Next Gate** | — |

#### ⛔ 公网部署必须以 Balanced 60 通过为前置

**Balanced 60 是部署的硬前置，不可跳过。**

| 条件 | 要求 |
|---|---|
| **Balanced 60 通过** | ✅ 必须（跨媒体检索 ≥ 9/10）|
| Balanced 60 未通过 | ❌ **阻止部署** |
| 「60 张测试成本太高」 | ❌ 不是理由 —— 本地部署同样适用该 Gate |

理由：60 张平衡集是**唯一覆盖绘画 + 电影帧双模态**的验证。
仅 2 张 smoke 的覆盖面不足以支撑部署决策。

**即使 E12/MEA-06/08/14 四项安全项全部完成，
Balanced 60 未通过仍不得部署。**

#### 公网部署六项验收清单

| # | 项 | 具体要求 | 对应 |
|---|---|---|---|
| 1 | **鉴权** | 服务端验证调用者身份；未授权请求被拒 | MEA-14 |
| 2 | **限流** | 按用户/IP 限制频率；超限返回 429 | MEA-06 |
| 3 | **日志脱敏** | 移除 `[vision-debug]` 等原始响应输出；统一脱敏层 | MEA-08 / E15 |
| 4 | **存储保护** | 容量上限 + 超限策略 + 损坏恢复；防localStorage 溢出丢数据 | MEA-04 |
| 5 | **Provider 数据留存核查** | 查清第三方是否留存上传图片、留存多久、日志是否记录 | MEA-13 |
| 6 | **公网 E2E** | 公网环境端到端连通性、跨网络延迟与超时行为、密钥零落盘验证 | E12 |

**六项必须全部通过。任一项缺失即阻止部署。**

> **注意第 5 项的特殊性**：这是**外部依赖**，本项目无法控制 provider 的留存策略，
> 但**必须查清**才能让用户知情。这是合规前提，不是可选项。

#### 密钥要求（贯穿全部六项）

| 要求 | 验证方式 |
|---|---|
| 密钥不落盘 | build 泄漏扫描 + 检查 env 配置 |
| 浏览器拿不到凭据 | 网络面板检查请求头 |
| 密钥不进日志 | 日志审查 |

---

## 附录：D1/D2 的配置差异（重要澄清）

**D1 与 D2 的 `max_tokens` 不同，因此它们不是同配置重复实验。**

| 探针 | `max_tokens` | 结果 |
|---|---|---|
| **D1** | **800** | HTTP 200 · `finish_reason=stop` · `completion_tokens=395/800` · reasoning_len 605 · content_len 605 · schema-valid |
| **D2** | **1600** | HTTP 200 · `finish_reason=length` · `completion_tokens=1600/1600` · reasoning_len 3462 · **content_len 0** |

**正确表述**：
> 在 `max_tokens=800` 与 `max_tokens=1600` **两种不同配置**下各做了一次调用，
> 结果分别是成功与预算用尽。

**禁止表述**：
> ❌ 「同配置下结果翻转」
> ❌ 「重复实验证明不稳定」
> ❌ 「D1 和 D2 是同配置的两次尝试」

**为什么重要**：D1/D2 证明的是**「预算与 reasoning 长度存在交互」**，
**不证明**「同配置下结果会随机翻转」。
后者需要 **mini reliability run**（同配置重复）才能验证。

因此：
- 「提高 max_tokens 不可靠」——✅ 可由 D1/D2 得出（已证伪单因解释）
- 「provider 不稳定」——❌ **不能**由 D1/D2 得出，需 reliability run

---

## 门禁规则

### 禁止跨 Gate

- **不得**在 P6.3.1D 未 `CONFIRMED` 时自动进入 P6.3.1E（须人工决策）
- **不得**在 smoke 未 PASS 时跑 reliability run
- **不得**在 reliability 未 PASS 时跑 Balanced 60
- **不得**在 Balanced 60 未 PASS 时部署
- **不得**跳过 P6.3.2（即使 reasoning 修好）
- **不得**自动更换 provider（人工决策）
- **不得**自动执行任何付费 Gate

### PASS 名称对应

| Gate | 产出 | 不能产出 |
|---|---|---|
| 2-asset bridge smoke | `BRIDGE_SMOKE_PASS` | `PROVIDER_RELIABILITY_PASS` / `PROVIDER_GATE_READY` |
| mini reliability run | `PROVIDER_RELIABILITY_PASS` | `PROVIDER_GATE_READY` |
| smoke + reliability 均通过 | **`PROVIDER_GATE_READY`** | — |

### 允许的并行

| Gate | 可与之并行 |
|---|---|
| P6.3.1D | P6.3.2 实现（不涉及 provider）、E12 后端方案设计 |
| P6.3.1E | — |
| P6.3.2 | E14 测试框架、E15 日志脱敏 |
| Balanced 60 | E12 后端实现 |

### 人工操作标记

| 编号 | Gate | 内容 | 付费 |
|---|---|---|---|
| 【人工操作 1】| P6.3.1D | reasoning-effort 三探针 | ✅ |
| 【人工操作 2】| P6.3.1E | LOW/MAX painting 对照 | ✅ |
| 【人工操作 3】| 2-asset smoke | 启动带真实env 的 local bridge | ✅ |
| **【人工授权后执行】** | mini reliability | 小样本重复运行 | ✅ 累计 |
| **【人工授权后执行】** | Balanced 60 | 60 张平衡集 | ✅ 60 次 |
| 【人工操作 4】| 部署 | 公网 E2E（含六项验收） | — |

**原因**：需要真实凭据、涉及付费 API、需人工判断输出。
Coding agent **不得自动执行**。