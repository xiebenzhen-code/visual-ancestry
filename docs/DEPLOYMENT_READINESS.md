# DEPLOYMENT_READINESS

**生成日期**：2026-10-08
**阶段**：P6.3.1D
**只写真实状态**，不写目标状态。

---

## 状态定义

| 状态 | 含义 |
|---|---|
| `READY` | 已验证可用 |
| `CONDITIONAL` | 可用，但有明确前置条件 |
| `BLOCKED` | 被阻塞，无法推进 |
| `NOT REQUIRED` | 本阶段不涉及 |

---

## Readiness 清单

| 组件 | 状态 | 依据 | 阻塞项 |
|---|---|---|---|
| **Product Core** | `READY` | 14 页 + 组件全部构建通过；build exit 0 | — |
| **Local Storage** | `CONDITIONAL` | `memoryRepository.js` 双形态可用 | 浏览器配额：1050 张 = 202.6 MB（**超20×**） |
| **Retrieval** | `READY` | `scoring.js` 冻结（sha256 `7f165e2798…`）；实测 0.13–0.93 ms | — |
| **Profile** | `READY` | 冻结模块；`isProfileEligible` 门槛已实现 | — |
| **Assistant** | `READY` | 冻结模块；grounding 0 泄漏已验证 | — |
| **External Art Sources** | `READY` | 三源覆盖 11/11 主题（Met 11/11、AIC 11/11、Rijks 10/11） | — |
| **Film Sources** | `CONDITIONAL` | 公版默片可用 | 彩色片仅 1/9；用户导入是覆盖现代电影唯一方式 |
| **Vision Provider** | `BLOCKED` | endpoint 可达、认证 PASS、strict schema 曾 PASS | **E02 reasoning 不稳定**、**E03 透传未知** |
| **Reasoning Control** | `BLOCKED` | 官方支持（三档） | **E03**：第三方层是否透传未验证 |
| **Schema Validation** | `BLOCKED` | 浏览器侧有 `normalizeVisionIntent` | **E08**：bridge 侧无校验；**E10**：`json_schema` 效力未确认 |
| **Bridge** | `READY` | 4175监听确认；契约稳定 | — |
| **Secure Backend** | `BLOCKED` | 本地 server 完整 | **E12**：无公网部署形态 |
| **Public Deployment** | `BLOCKED` | — | **E12** + E08 + E02 |
| **Balanced-60 Validation** | `BLOCKED` | 60 张平衡集已构建（5/5 检查通过） | **E13**：依赖 Provider Gate |

### 汇总

| 状态 | 数量 | 组件 |
|---|---|---|
| `READY` | 6 | Product Core、Retrieval、Profile、Assistant、External Art Sources、Bridge |
| `CONDITIONAL` | 2 | Local Storage（配额）、Film Sources（公版限制） |
| `BLOCKED` | 6 | Vision Provider、Reasoning Control、Schema Validation、Secure Backend、Public Deployment、Balanced-60 |
| `NOT REQUIRED` | 0 | — |

---

## 唯一剩余路线

```
P6.3.1D  reasoning_effort 透传验证（当前阶段）
   │  E03：三层透传是否成立
   │  失败 → 换 provider（这是唯一出口，本阶段禁止）
   ▼
P6.3.1E  LOW/MAX painting 对照验证
   │  E02：reasoning 档位是否真能缓解
   │  阴性 → 结构保证必须另建（E08/E10已成必然）
   ▼
P6.3.2  schema-validation gate 独立立项
   │  E08：bridge 侧字段校验
   │  E10：结构保证从 prompt + 客户端校验承担
   ▼
2-asset bridge smoke
   │  painting + film 各1 次，无 retry
   │  通过 → PROVIDER_GATE = READY
   ▼
mini reliability run
   │  小样本重复运行，测稳定性（非单次成功）
   │  这是单次 smoke 无法替代的一步
   ▼
Balanced 60
   │  30 绘画 + 30 电影帧，5/5 平衡检查
   │  E13 解锁
   ▼
public secure deployment
   │  E12：需公网后端 + 密钥管理
   ▼
```

### 关键路径

**P6.3.1D → P6.3.1E → P6.3.2 → smoke → mini run → Balanced 60 → 部署**

其中：
- **P6.3.1D / P6.3.1E** 解锁 Vision Provider 与 Reasoning Control
- **P6.3.2** 解锁 Schema Validation（**即使 reasoning 修好也必须做**）
- **E12 公网后端可与上并行**，但必须先于 Public Deployment

### 不可跳过的两件事

1. **P6.3.2 schema gate 不可因reasoning 修好而跳过**
   `json_schema` 在 GLM-5.3 上可能从未生效（E10）。
   若成立，则 bridge 依赖 schema 保证 22 字段的假设**一直是错的**，
   与 reasoning 无关。

2. **mini reliability run 不可省**
   单次 smoke 成功**不能**代表稳定。E02 的本质是「时好时坏」，
   一次成功不构成证据。

---

## 当前可做与不可做

| 可做（无需外部条件） | 不可做（需人工操作或外部条件） |
|---|---|
| P6.3.2 schema gate 设计（不改bridge） | 任何真实 provider 调用 |
| 错误清单 / 文档完善 | Balanced 60 |
| 本地构建与静态验证 | 公网部署 |
| 分析既有实测数据 | — |

---

## PART H — Human Operations

>以下操作**必须由人执行**。编码 agent **不得自动执行**，原因如下：
> - 需要真实凭据（`VISION_API_KEY` 仅存在于用户的 PowerShell，会话环境变量中不存在）
> - 涉及**付费 API 调用**
> - 需人工判断输出是否符合预期

---

### 【人工操作 1】运行 reasoning-effort 三探针

**目的**：确定第三方层是否识别并透传 `reasoning_effort`（E03）

**前置**：
```powershell
$env:VISION_API_BASE = "https://ciyuan.glmtk.top/v1/chat/completions"
$env:VISION_API_KEY = "<enabled key>"
$env:VISION_MODEL   = "glm-5.3"
```
⚠️ PowerShell 赋值必须带引号，裸写 key 会被当作命令执行。

**执行**：
```powershell
node .\work\p6.3.1d\reasoning-effort-isolation.mjs
```

**成本**：3 次 text-only 调用，无图片

**预期输出四选一**：
| Outcome | 含义 |
|---|---|
| `PROVIDER_REASONING_EFFORT_PASSTHROUGH = CONFIRMED` | 透传成立 → 进入人工操作 2 |
| `PARAMETER_SUPPORTED_EFFECT_INCONCLUSIVE` | 参数被识别但效果未证实 → 需更多样本 |
| `PASSTHROUGH_UNCONFIRMED` | 该层可能静默剥离 → **方案不成立** |
| `PROVIDER_REASONING_EFFORT_UNSUPPORTED` | provider 明确拒绝该参数 |

---

### 【人工操作 2】LOW/MAX painting 对照验证

**前置**：人工操作 1 结果为 `CONFIRMED`

**执行**：LOW 与 MAX 各对painting 一次，不带 response_format

**记录**：`reasoning_content` 长度、content 长度、`finish_reason`

**判定**：LOW 档下 reasoning 显著更短且 content 非空 → E02 缓解成立

---

### 【人工操作 3】启动带真实 env 的 local bridge

**执行**：
```powershell
node .\scripts\server.mjs dist 4175
```

**注意**：
- 先确认 4175 未被占用
- 需**同一 PowerShell** 内已设好三个环境变量

---

### 【人工操作 4】最终公网 / 不同网络测试

**前置**：所有前置阶段完成 +安全后端就绪

**内容**：
- 公网环境连通性
- 密钥管理验证（不得落盘）
- 浏览器 localStorage 配额实测
- 跨网络延迟与超时行为

---

### 操作依赖关系

```
【人工操作 1】P6.3.1D 三探针
      │  CONFIRMED
      ▼
【人工操作 2】LOW/MAX painting
      │
      ▼
【人工操作 3】启动 local bridge
      │
      ▼
   （自动化阶段：2-asset smoke / mini run / Balanced 60）
      │
      ▼
【人工操作 4】公网测试
```