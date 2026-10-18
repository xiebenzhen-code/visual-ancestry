# CURRENT_STATE

**更新日期**：2026-10-08
**阶段**：P6.3.1D
**盘点依据**：PHASE 0 实测（非聊天记忆）

---

## 状态枚举定义

| 状态 | 含义 |
|---|---|
| `completed` | 已实现且有验证证据 |
| `frozen` | 已完成且代码冻结，不得回归 |
| `open` | 已立项，未完成 |
| `blocked` | 被外部条件阻塞 |
| `not required` | 本阶段不涉及 |
| `audit required` | 需审计才能定状态 |

---

## 组件状态

### Runtime

| 组件 | 状态 | 证据 |
|---|---|---|
| Browser 构建 | `completed` | `scripts/build.mjs` exit 0；泄漏扫描 76 文件 0 违禁 |
| `package.json` scripts | `completed` | `dev` / `build` / `preview` 三项 |
| `devDependencies` | `completed` | 仅 `sharp@^0.35.4` |
| 单元测试框架 | `audit required` | **无 `test` script、无 `tests/` 目录** |

### 视觉理解链

| 组件 | 状态 | 证据 |
|---|---|---|
| `visionService` | `completed` | `src/services/vision/visionService.js` 编排三步 |
| browser `visionProvider` | `completed` | `VISION_BRIDGE = "/api/vision"` |
| `normalizeVisionIntent` | `completed` | 注入 `source: "vision"`（`:49`）|
| `/api/vision` bridge (transport) | `completed` | 4175 LISTENING；契约稳定 |
| `openaiProvider` | `frozen` | sha256 `1f79c0a38d82a28b`（P6.3.2 改：E15 日志脱敏）|
| Provider 可达性 | `completed` | direct C 曾 HTTP 200 |
| Provider 认证 | `completed` | 新 key 通过（`API_KEY_DISABLED` 已解除）|
| Provider 稳定性 | `open` | **E02**：D1 成功 395/800、D2 用尽 1600/1600 |
| Bridge schema 校验 | `frozen` | **E08 RESOLVED** P6.3.2：strict V1 validation，sha256 9f560e6059c26d45
| `json_schema` 效力 | `open` | **E10**：多方实测 GLM-5.3 静默忽略 |
| Reasoning 控制 | `blocked` | **E03**：第三方层透传未验证 |

### 记忆与检索

| 组件 | 状态 | 证据 |
|---|---|---|
| `memoryRepository` | `frozen` | sha256 `53fed33b07feb052` |
| `uploadService` | `completed` | MIME 白名单 + 6 MB 上限 |
| `deleteMemory` | `completed` | `memoryRepository.js:188` |
| `scoring.js` | `frozen` | sha256 `7f165e27983396ca`；0.13–0.93 ms |
| `visualIntent.js` | `frozen` | sha256 `c7feabf0ff95269d` |
| `artworkIntent.js` | `frozen` | sha256 `908d13f094089a32` |
| `visualProfile` | `frozen` | sha256 `550bb8642391619d` |
| `visualAssistant` | `frozen` | sha256 `ed494e82a9c71dd7` |
| `types.js` | `frozen` | sha256 `d2ae2b3bf6e01ad4` |
| `retrievalService` | `completed` | 编排 scoring + artworkIntent |
| 组件 | 状态 | 证据 |
|---|---|---|
| Local Storage | `open` | `memoryRepository.js` 可读写；⚠ **代码中无配额处理、无容量常量、无降级策略**（grep `QUOTA`/`MAX_MEMORIES` 无命中）。实测 1050 张 = 202.6 MB（超 20×）|

**容量目标：未定义。** 代码中不存在任何容量上限常量或超限降级策略。
「1050 张 = 202.6 MB」是**实测推算值**，非代码约束。
补齐容量目标与超限策略前，此项为 `open`（详见 `MISSING_EDGE_AUDIT.md` MEA-04）。

### 外部源

| 组件 | 状态 | 证据 |
|---|---|---|
| Met adapter | `completed` | 主题覆盖 11/11 |
| AIC adapter | `completed` | 主题覆盖 11/11 |
| Rijks adapter | `completed` | 主题覆盖 10/11；参数名已修正 |
| 三源并用 | `completed` | 覆盖 11/11 |
| 候选 cache | `completed` | double-key `(source, sourceId)` + sha256；8/8 断言 |
| 电影来源 | `open` | 公版默片可用；**彩色片仅 1/9** |
| 电影帧溯源 | `open` | **20/30 sha1 内容哈希硬验证**；**10 张 UNRESOLVED**（Commons 无 sha1 相同文件，为再编码衍生物，**不计入已验证**）。来源 `docs/P6.3.1-final-report.md:79,162,168` |
| 电影帧语义正确性 | `open` | 曾抓出 1 张码头群像照假帧（标题含 crowd 通过分类器），已按**类别**排除 |

**证据强度**：20/30 指**内容哈希级**（与 Commons 原始文件逐字节相同），非「分类器判定」。剩余 10 张**不是弱验证通过，而是无法验证**。

### 部署

| 组件 | 状态 | 证据 |
|---|---|---|
| 本地 bridge | `completed` | 4175 LISTENING |
| 公网后端 | `blocked` | **E12**：仅有本地 `scripts/server.mjs` |
| CORS | `not required` | **无 CORS 头** → 强制同源（本地形态）|
| 速率限制 | `open` | **代码中不存在** |
| 密钥边界 | `completed` | `VISION_*` 仅 server 侧；build 扫描 `VISION_API_KEY` |

### 验证

| 门禁 | 状态 |
|---|---|
| A/B/C 隔离 | `completed`（结论见 ERROR_REGISTRY）|
| D1/D2 单变量 | `completed`（结论：单因解释 REJECTED）|
| E0/E1/E2 透传隔离 | `open`（harness ready，等待人工执行）|
| Balanced 60 | `blocked`（E13）|
| mini reliability run | `blocked`（依赖 Provider Gate）|

---

## 快照

```
CURRENT_STAGE     = P6.3.1D
CURRENT_BLOCKERS  =
  E03  reasoning_effort 透传未知（关键路径起点）
  E08  bridge 无 schema 校验
  E10  json_schema 效力未确认
  E12  无公网后端
  E13  Balanced-60 被阻塞（依赖 E03）
NEXT_GATE         = P6.3.1E
NEXT_HUMAN_ACTION = node .\work\p6.3.1d\reasoning-effort-isolation.mjs
```

### 关键路径

```
E03 → E02 可否修 → E13 可否解锁 → mini reliability → Balanced 60
```

### 独立支线（不依赖 E03）

```
E08 + E10（schema 双重不确定）→ P6.3.2 必须做
E12（公网后端）→ 可并行
Local storage 配额 → 可并行
```

**强调**：即使 E03 结论为「透传成立」且 reasoning 被修复，
**E08 + E10 仍必须处理** —— `json_schema` 若从未生效，
bridge 依赖它保证 22 字段结构的假设一直是错的。

---

## 已知不可省步骤

| 步骤 | 为什么不可省 |
|---|---|
| **P6.3.2 schema gate** | 与 reasoning 无关；`json_schema` 可能从未生效 |
| **mini reliability run** | E02 本质是「时好时坏」，**单次成功不构成证据** |