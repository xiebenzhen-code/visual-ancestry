# GLOSSARY

**收录范围**：仅项目实际出现的术语
**格式**：Term / 中文 / 工程含义 / 本项目实例 / 面试表达

---

## 架构与边界

| Term | 中文 | 工程含义 | 本项目实例 | 面试表达 |
|---|---|---|---|---|
| **Boundary** | 边界 |信任级别切换的分界线 | Browser / Server / Provider / Local Storage | 「我们把信任边界画在浏览器和 server 之间，密钥永不过界」 |
| **Bridge** | 桥接层 | 跨信任边界的唯一通道 | `scripts/server.mjs` 的 `POST /api/vision` | 「Bridge 是密钥隔离的唯一屏障，也是所有 provider 调用的收口」 |
| **Same-Origin** | 同源 | 浏览器安全策略，阻止跨域请求 | 无 CORS 头即最严格的同源约束 | 「我们没加 CORS 头，这是特性不是遗漏——强制同源」 |
| **Secret Boundary** | 密钥边界 | 凭据存在的唯一区域 | `process.env.VISION_*`，仅 server 侧 | 「密钥只存在于 server process env，浏览器永远拿不到」 |
| **Trust Boundary Diagram** | 信任边界图 | 标注数据跨越了哪些信任级别 | 见 `ARCHITECTURE_CURRENT.md` §3 | 「画信任边界图能立刻看出哪些数据不该出浏览器」 |

---

## 视觉理解

| Term | 中文 | 工程含义 | 本项目实例 | 面试表达 |
|---|---|---|---|---|---|---|
| **VisualIntent** | 视觉意图 | 结构化的视觉描述，检索的唯一依据 | `visualIntent.js` 的 22 字段 schema | 「检索物理上只读 VisualIntent，不读元数据」 |
| **Multimodal** | 多模态 | 同时处理文本与图像 | 直连 C 携带同一张 painting 图成功 | 「C 探针本身携带图像且成功，这证伪了『不支持多模态』的判断」 |
| **reasoning_content** | 推理内容 | 推理模型返回的思维链 | D2 时长 3462 字符，挤空 content | 「推理 token 与输出共享预算，这是我们最大的成本陷阱」 |
| **Reasoning Effort** | 推理强度 | 控制思考深度的参数 | `reasoning_effort: low/high/max`，默认 `max` | 「GLM-5.3 的思考无法关闭，只能降档位」 |
| **Structured Output** | 结构化输出 | 强制模型返回特定 schema | `response_format: json_schema` | 「我们发现这个 schema 约束可能从未生效，这是个隐蔽缺陷」 |
| **Token Ceiling / Budget** | token 上限/预算 | 单次请求的输出上限 | `max_tokens=800` 曾导致 content 被挤空 | 「加预算不是解法，降reasoning 才是」 |

---

## 检索与记忆

| Term | 中文 | 工程含义 | 本项目实例 | 面试表达 |
|---|---|---|---|---|---|---|
| **Frozen Core** | 冻结核心 | 不允许随意修改的关键模块 | 9 个模块用 sha256 锁定 | 「冻结核心用哈希校验，防止静默漂移」 |
| **Deterministic Scoring** | 确定性打分 | 同输入必定同输出 | `scoring.js` 纯函数，0.13–0.93 ms | 「确定性打分换来可复现性，这是产品概念要求的」 |
| **sharedReasons** | 共享理由 | 「为什么匹配」的说明 | `artworkIntent.js` | 「每条推荐都要能回答『为什么是这个』」 |
| **Visual Profile** | 视觉画像 | 记忆的统计聚合 | `visualProfile.js` 的 `isProfileEligible` | 「画像是聚合结论，需要样本量门槛」 |
| **Repository** | 仓储 | 存储唯一出入口 | `memoryRepository.js` 双形态 | 「Repository 模式让 localStorage 只有一个写入点」 |
| **localStorage Quota** | 本地存储配额 | 浏览器硬上限 | 1050 张 = 202.6 MB，超20× | 「local-first 架构的天花板是浏览器配额，必须提前规划」 |

---

## 外部源与缓存

| Term | 中文 | 工程含义 | 本项目实例 | 面试表达 |
|---|---|---|---|---|---|---|
| **Source Adapter** | 源适配器 | 外部 API 的厂商差异隔离层 | `artSourceAdapter.js`（Met/AIC/Rijks） | 「适配器模式让新增博物馆源不影响核心链路」 |
| **Candidate Discovery** | 候选发现 | 搜索阶段，不产生费用 | `search → candidates` | 「搜索和付费分析必须分离」 |
| **Content Addressing** | 内容寻址 | 用文件哈希做身份 | sha1 反查 Commons 原始文件 | 「sha1 内容寻址帮我们抓出了码头假照片」 |
| **Double-Key Cache** | 双键缓存 | 稳定键 + 内容哈希 | `(source, sourceId)` + sha256 | 「外部搜索排序不稳定，单用哈希永不命中」 |
| **Retriable Failure** | 可重试失败 | 环境性失败不占缓存主键 | provider 未配置标 `retriable:true` | 「环境性失败若被永久缓存，凭据到位后会被永久跳过」 |
| **IIIF** | 国际图像互操作框架 | 图像服务标准 | Met 的 `iiif/2/{id}` | 「IIIF 路径拼接极易出错，要用源返回的完整 URL」 |

---

## 验证与工程

| Term | 中文 | 工程含义 | 本项目实例 | 面试表达 |
|---|---|---|---|---|---|---|
| **Gate** | 门禁 | 阶段间的硬性通过条件 | P6.3.1D → 1E → P6.3.2 → smoke → ... | 「禁止跨 Gate，否则后续验证全部失效」 |
| **Bridge Request Parity** | 桥接请求一致性 | 对比直连与经bridge 的请求差异 | 15/15 参数一致但结果相反 | 「请求参数全一致时，问题就不在参数上」 |
| **Capability Isolation** | 能力隔离 | 单变量实验定位能力边界 | E0/E1/E2 三探针 | 「用非法值做对照，才能区分『透传』与『静默丢弃』」 |
| **Reasoning Ratio** | 推理长度比 | 低档/高档 reasoning 长度之比 |阈值 ≤ 0.6 才算档位效应 | 「差5 个字符是抖动，差 10 倍才是效应」 |
| **Provenance** | 溯源 | 资产来源可追溯 | 20/30 电影帧 sha1 硬验证 | 「免费许可不等于可用，『是不是一张电影画面』才是」 |
| **Build Leak Scan** | 构建泄漏扫描 | 产物中禁止出现凭据 | `build.mjs` 的 `FORBIDDEN_HARD` | 「密钥不进构建产物是硬要求，靠自动扫描保证」 |
| **Hardening** | 加固 | 收紧判定条件 | harness 三轮：阈值、方向、错误语义 | 「判定器本身要有守卫，否则会给出假阳性」 |

---

## 反模式（值得记住的教训）

| Term | 中文 | 本项目实例 |
|---|---|---|
| **False Positive Verdict** | 假阳性判定 | 5 个字符的 reasoning 抖动被当成档位效应 |
| **Silent Ignore** | 静默忽略 | `json_schema` 被接受但不执行，比报错更危险 |
| **Parameter Error ≠ Any 4xx** | 参数错误不等于任意 4xx | 401/429/500 都返回 4xx/5xx，但证明请求没进参数校验 |
| **Proxy-Fabricated Failure** | 代理伪造故障 | localhost 代理返回假 502，绕过需 `net.connect()` |
| **Report/Disk Divergence** | 报告与磁盘脱节 | 曾报告「已删除」但旧分支仍在代码里 |