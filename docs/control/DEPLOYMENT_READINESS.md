# DEPLOYMENT_READINESS

**更新日期**：2026-10-08
**依据**：PHASE 0 实测 + `MISSING_EDGE_AUDIT.md`
**只写真实状态**

---

## 状态定义

| 状态 | 含义 |
|---|---|
| `READY` | 已验证可用 |
| `CONDITIONAL` | 可用，有明确前置条件 |
| `BLOCKED` | 被阻塞 |
| `NOT REQUIRED` | 本形态不涉及 |

---

## Readiness 清单

| 组件 | 状态 | 依据 | 阻塞项 |
|---|---|---|---|
| **Product Core** | `READY` | 14 页 + 组件；build exit 0；泄漏扫描 0 违禁 | — |
| **Local Storage** | `BLOCKED` | `memoryRepository.js` 双形态可用 | **MEA-04**：1050 张 = 202.6 MB，超配额 20× |
| **Retrieval** | `READY` | `scoring.js` 冻结；实测 0.13–0.93 ms | — |
| **Profile** | `READY` | 冻结模块；样本门槛已实现 | — |
| **Assistant** | `READY` | 冻结模块；grounding 0 泄漏已验证 | — |
| **External Art Sources** | `READY` | 三源覆盖 11/11 主题 | — |
| **Film Sources** | `CONDITIONAL` | 公版默片可用 | 彩色片仅 1/9；10/30 未硬验证 |
| **Vision Provider** | `BLOCKED` | endpoint 可达、认证 PASS | **E02** 不稳定、**E03** 透传未知 |
| **Reasoning Control** | `BLOCKED` | 官方支持三档 | **E03**：第三方层透传未验证 |
| **Schema Validation** | `BLOCKED` | 浏览器侧有 `normalizeVisionIntent` | **E08** bridge 无校验；**E10** `json_schema` 效力未确认 |
| **Bridge (transport)** | `READY` | 4175 LISTENING（PID 已确认）；契约 `{imageBase64, mimeType}` 稳定；6 MB 上限 → 413；MIME 白名单；base64 校验。**传输层已验证** |
| **Bridge (schema)** | `BLOCKED` | `server.mjs:121` `result.raw` 原样透传，**无 schema 校验**（E08）|
| **Schema Validation** | `BLOCKED` | 浏览器侧有 `normalizeVisionIntent`；**bridge 侧无** | **E08** + **E10** `json_schema` 效力未确认 |
| **Secure Backend** | `BLOCKED` | 本地 server 完整 | **E12**：无公网形态 |
| **Public Deployment** | `BLOCKED` | — | **MEA-06/08/14** + **E15** |
| **Balanced 60** | `BLOCKED` | 平衡集已构建（5/5 通过） | **E13**：依赖 Provider Gate |

### Bridge 的两个维度必须分开评估

「Bridge READY」只覆盖**传输层**，不含 schema 保证：

| 维度 | 状态 | 覆盖内容 | 未覆盖 |
|---|---|---|---|
| transport | `READY` | 端口监听、契约、body 上限、MIME、base64 校验 | — |
| schema | `BLOCKED` | — |字段名白名单、类型校验、失败返回非 200 |

**推论**：`2-asset bridge smoke` 检验的是 **transport + provider 行为**；
若其 PASS，**不等于** schema 保证成立（E08/E10 仍未解决）。
因此 P6.3.2 必须排在其之前，而非之后。

### 汇总

| 状态 | 数量 | 组件 |
|---|---|---|
| `READY` | 6 | Product Core、Retrieval、Profile、Assistant、External Art Sources、Bridge |
| `CONDITIONAL` | 1 | Film Sources |
| `BLOCKED` | 7 | Local Storage、Vision Provider、Reasoning Control、Schema Validation、Secure Backend、Public Deployment、Balanced 60 |

---

## 安全项（公网部署前必须全部解决）

| ID | 项 | 当前状态 | 阻塞范围 |
|---|---|---|---|
| **MEA-06** | API 速率限制 | ❌ 代码中不存在（grep `rateLimit`/`throttle` 无命中） | **公网部署** |
| **MEA-08** | 日志脱敏 | ❌ `openaiProvider.mjs:158` `[vision-debug]` 打印上游响应前 200 字符 | **公网部署** |
| **E15** | 同上（错误清单条目） | ❌ 与 MEA-08 是**同一问题**，非独立项 | **公网部署** |
| **MEA-14** | 公网滥用保护 | ❌ 无鉴权、无限流 | **公网部署** |

### E15 与 MEA-08 的关系（消歧）

**同一问题的两个视角**：
- `MEA-08` 是**按审计项**登记（Log redaction）
- `E15` 是**按错误**登记（`openaiProvider.mjs:158` 未脱敏）

**不重复计数。** 修复一处即同时解决两条。

### 阻塞范围澄清

| 阶段 | E15/MEA-08 是否阻塞 |
|---|---|
| P6.3.1D（当前） | ❌ **不阻塞** —— 单机本地开发，日志仅本机可见 |
| 2-asset smoke | ❌ 不阻塞 |
| Balanced 60 | ❌ 不阻塞 |
| **公网部署** | ✅ **阻塞** —— 日志可能被集中采集或多人可见 |

即：E15 **阻塞公网部署，但不阻塞当前阶段及 Balanced 60 之前的所有 Gate**。

**这4 项安全项全部同属公网部署前置，不阻塞 provider 相关验证。**

---

## 唯一剩余路线

详见 `VALIDATION_GATES.md`。

```
P6.3.1D  reasoning_effort 透传验证
   │失败 → 换 provider（当前路线终点）
   ▼
P6.3.1E  LOW/MAX painting 对照
   │
   ▼
P6.3.2  schema-validation gate（独立，不可跳过）
   │
   ▼
2-asset bridge smoke
   │  → PROVIDER_GATE = READY
   ▼
mini reliability run（不可省：E02 是「时好时坏」）
   │
   ▼
Balanced 60
   │
   ▼
secure public deployment（需先解决 4 项安全 BLOCKER）
```

---

## 可并行项（不依赖主链）

| 项 | 说明 |
|---|---|
| E12 公网后端方案 | 设计与实现可并行 |
| E14 最小测试框架 | 纯函数层，不依赖 provider |
| MEA-15 cache 版本化 | schema 变更前需先建 |
| MEA-10 超时遥测 | mini reliability 依赖此能力 |

---

## 两件不可跳过的事

### 1. P6.3.2 schema gate 不可因 reasoning 修好而跳过

若 **E10** 成立（`json_schema` 在 GLM-5.3 上从未生效），
则 bridge 依赖它保证 22 字段结构的假设**一直是错的** —— 与 reasoning 无关。

### 2. mini reliability run 不可省

**E02 的本质是「时好时坏」**。单次 smoke 成功不构成稳定性证据。
D1 与 D2 都是单次调用，它们已经展示了结果可以在同配置下翻转。

---

## 当前可做 / 不可做

| 可做（无需外部条件） | 不可做（需人工或外部条件） |
|---|---|
| P6.3.2 schema gate 设计 | 任何真实 provider 调用 |
| MEA-06/08/14 安全项修复 | Balanced 60 |
| E14 最小测试框架 | 公网部署 |
| 缓存版本化设计 | — |
| 文档与错误清单维护 | — |