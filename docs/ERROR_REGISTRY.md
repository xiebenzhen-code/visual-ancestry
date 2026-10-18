# ERROR_REGISTRY

**生成日期**：2026-10-08
**阶段**：P6.3.1D
**用途**：单一错误事实源。标记 RESOLVED/FROZEN 者**不再重新调查**，除非出现新证据。

---

## 状态图例

| 状态 | 含义 |
|---|---|
| `OPEN` | 未解决，仍在调查或待验证 |
| `RESOLVED` | 已定位根因并修复 |
| `FROZEN` | 已解决且相关代码冻结，不得回归 |
| `BLOCKED` | 需外部条件（凭据 / 上游行为）才能推进 |
| `REGISTERED` | 已登记，当前无解但需留痕 |

---

## 错误清单

| ID | Layer | Symptom | Root Cause Status | Evidence | Impact | Current Status | Solution | Validation Needed | Do Not Repeat | Blocking Deployment? |
|---|---|---|---|---|---|---|---|---|---|---|
| **E01** | Provider | `max_tokens` 加倍后仍空响应 | **REJECTED**（已证伪） | D2 `max_tokens=1600` → `1600/1600`、`finish_reason=length`、`content_len=0` | 曾误判为根因 | **RESOLVED** | 转向 reasoning 档位（见 E02） | 已由D2 实测闭环 | **不要再把 max_tokens 当单因修复** | No |
| **E02** | Provider | reasoning 挤占输出预算，结果时好时坏 | **STRONG_HYPOTHESIS** | D1 `395/800` 成功；D2 `1600/1600` 全被 reasoning 吃光 | 视觉理解不稳定 | **OPEN** | `reasoning_effort: "low"` | **P6.3.1D 三探针** | 不要再假设「加 token 就能解决」 | **Yes** |
| **E03** | Provider | `reasoning_effort` 是否透传未知 | **UNCONFIRMED** | 官方支持（三档）；第三方层行为未知 | 决定 E02 能否修 | **OPEN** | 透传验证 | **P6.3.1D** | 不要假设文档能力 = 端点能力 | **Yes** |
| **E04** | Harness | `rejected(E1)` 把任意 4xx 当「low 不支持」 | **RESOLVED** | 401/429/5xx 都返回 4xx/5xx | 误判 unsupported | **FROZEN** | 新增 `isReasoningEffortUnsupportedError()` | 9 项 E1 guards | 不要用通用拒绝推断参数语义 | No |
| **E05** | Harness | `low/high/max` 裸出现被当成参数错误 | **RESOLVED** | `"priority supports low and high"` 会误判 | 假阳性 | **FROZEN** | 要求 reasoning 语境 + allowed 语言 + 三值齐全 | 4 项 regex guards | 不要只凭枚举值判断 | No |
| **E06** | Provider | `prompt_tokens` 1499 vs 265（输入字节相同） | **REGISTERED** | D1/D2 差 5.66× | usage 不可作因果证据 | **REGISTERED** | 待provider侧解释 | 需 provider 方说明 | **不要用 usage 当唯一判据** | No |
| **E07** | Provider | `content_len` 与 `reasoning_len` 同为 605 | **REGISTERED** | D1 实测 | 疑为响应形态异常 | **REGISTERED** | 需原始响应体 | 取raw body 比对 | 不要假定两者独立 | No |
| **E08** | Bridge | `result.raw` 原样透传，字段错位也返回 200 | **CONFIRMED** | 1×1 探针返回 10 个错字段但 `ok:true` | 错误 intent 可静默流入冻结核心 | **OPEN** | 独立立项 schema-validation gate | 需单独实现与测试 | 不要在 bridge 层信任上游 JSON | **Yes** |
| **E09** | Harness | `provider-smoke` 要求 `intent.source==="vision"`，但 `buildSchema`不产出该字段 | **CONFIRMED** | `source` 由浏览器侧 `normalizeVisionIntent.js:49` 注入 | 成功也会被判失败 | **OPEN** | 改判定器或依赖浏览器侧归一化 | 重新定义 pass 条件 | 不要用失效判定器决定 GATE | **Yes** |
| **E10** | Provider | `json_schema` 可能从未生效 | **STRONG_HYPOTHESIS** | 多方实测 GLM-5.3 静默忽略 strict schema | 22 字段结构保证失效 | **OPEN** | 结构保证改由 prompt + 客户端校验 | 需单变量验证 | **不要假设 strict:true 有效** | **Yes** |
| **E11** | Provider | film 83,401 ms > 60,000 ms 预算 | **CONFIRMED** | 60,000（超时）+ 23,401（重试）精确吻合 | 重试放大延迟与费用 | **RESOLVED** | 已按真实 attempt 数记录 | 已闭环 | **不要声称「在预算内」** | No |
| **E12** | Deployment | 无公网 Vision 后端 | **CONFIRMED** | 仅 `scripts/server.mjs` 本地 | 公网部署不可用 | **BLOCKED** | 需安全后端方案 | 见 `DEPLOYMENT_READINESS.md` | 不要把本地 server 直接暴露公网 | **Yes** |
| **E13** | Validation | Balanced-60 验证被阻塞 | **BLOCKED** | 依赖 Provider Gate | 无可靠性数据 | **BLOCKED** | 待 E02/E03 解决 | mini reliability run → Balanced 60 | 不要跳过前置 Gate | **Yes** |

### 已解决 · 冻结（不再重新调查）

| ID | Symptom | Resolution | 状态 |
|---|---|---|---|
| **E-OLD-01** | 上游 `API_KEY_DISABLED` | 换用 ENABLED key | **RESOLVED** |
| **E-OLD-02** | Rijks `subject=` 参数直接 400 | 改 `description=` / `title=` | **RESOLVED** |
| **E-OLD-03** | Rijks IIIF 拼接路径 404 | 用顶层 `isShownBy.id` | **RESOLVED** |
| **E-OLD-04** | cache 单 sha256 永不命中 | 双层键 `(source, sourceId)` | **RESOLVED** |
| **E-OLD-05** | 缓存失败不写 ledger → 无法自证 | 每次尝试都记录 | **RESOLVED** |
| **E-OLD-06** | 海报被当彩色电影画面 | `/poster/i` 过滤 + 类别排除 | **RESOLVED** |
| **E-OLD-07** | 码头照片通过剧照分类器 | 按类别排除（非文件名） | **RESOLVED** |
| **E-OLD-08** | `asian-art` 主题仅 33% 真实 | 改用结构化字段核验 | **RESOLVED** |
| **E-OLD-09** | localhost 代理伪造 502 | `net.connect()` 自校准 | **RESOLVED** |
| **E-OLD-10** | 端口被测试进程占用 | 验证前先查端口 | **RESOLVED** |

> 上述 10 项**已修复并验证**。除非出现新证据，**不得重新调查**。

---

## PART F — Solution Matrix

| Problem | Immediate Fix | Long-term Fix | Why | Cost | Risk | Validation Gate |
|---|---|---|---|---|---|---|
| **reasoning instability**<br>(E02) | 验证 `reasoning_effort: "low"` | 若有效 → 纳入 bridge 默认配置 | reasoning 吃满输出预算是唯一被观测到的机制 | 零额外费用 | 低：单参数，不改 schema | P6.3.1D 三探针 → LOW/MAX painting 对照 |
| **schema uncertainty**<br>(E08/E10) | 无（暂不修） | **Server-side schema validation**：字段名 ⊆ schema、类型校验、失败返回非200 | bridge 只透传不校验，错误 intent 会静默流入冻结模块 | 零 | **中**：过严会拒掉可接受偏差 | 独立立项；先定「拒绝阈值」 |
| **provider instability**<br>(E02/E11) | Provider Adapter 隔离 | 加reasoning 控制 + 重试策略分级 | 让provider 差异止于adapter | 零 | 低 | 2-asset bridge smoke |
| **secret exposure** | 已满足（server-only） | 部署时用 env/secret manager，禁止落盘 | 浏览器永远拿不到凭据 | 部署成本 | **高**（公网暴露即泄漏） | 公网部署前必须审计 |
| **API cost** | cache（已实现 double-key） | 只分析**选中**资产，不批量 | 每张图= 一次付费调用 | **直接决定运营成本** | 中：cache 失效逻辑曾多次出错 | cache-proof 8/8 断言 |
| **large corpus** | 按需检索（已验证） | `search → candidates → analyze selected → cache` | 预下载 = N×(搜索+下载) 时间 + N×体积 | 避免 202.6 MB / 20× 超配额 | 低 | 三源11/11 主题覆盖已验证 |
| **usage不可信**<br>(E06) | 不用 usage 作判据 | 找 provider 方核实计费口径 | 差 5.66× 会误导所有量化结论 | 零 | 低 | 需 provider 配合 |
| **Bridge 判定失效**<br>(E09) | 暂不用于 GATE | 重写 pass 条件或依赖浏览器归一化 | 判定器与真实契约不符 | 零 | 中 | 需重新定义 schema-valid |

---

## 关键依赖链

```
E03（透传未知）
  └─决定→ E02（reasoning 不稳定）能否修
       └─决定→ E13（Balanced-60）能否开始

E08 + E10（schema 双重不确定）
  └─独立→ 即使 reasoning 修好，结构保证仍需另建

E12（无公网后端）
  └─独立→ 阻塞所有公网部署，与 provider 无关
```

**结论**：E03 是当前**唯一的关键路径起点**。E12 可并行推进。