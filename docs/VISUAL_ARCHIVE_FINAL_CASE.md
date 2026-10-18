# Visual Archive — Final Case

> **Personal Visual Archive transforms images into searchable visual memory.**
>
> Visual Archive V2 Alpha · Portfolio Release · validated 2026-10

---

## 1. Overview

Personal Visual Archive 是一个 **local-first 的个人视觉记忆系统**，面向创作者。每一次收藏——电影截图、绘画、随手拍的构图——被 AI 转译成 25 字段的结构化视觉语言（空间纵深、环境主导、光质、人际疏离…），由此：按**感觉**找回参考（每条带「为什么匹配」的可解释证据）、跨媒介发现共享构图语言（1927 年电影布景 × 浪漫主义绘画）、并从收藏中读出诚实的个人视觉倾向（置信级与样本量绑定）。

全程零手动标签；全部数据留在本地设备；无账号、无云。

**角色**：独立项目——产品设计、架构、实现、测试策略、验证数据全部单人完成。技术栈：Vanilla JS SPA + Node 静态服务 + 多模态 LLM Vision（同源 bridge，无浏览器端密钥）。

## 2. Why

> **Reference accumulation ≠ visual memory.**

创作者的参考会大量积累，但文件夹只记得文件、不记得视觉关系：

- **找回靠翻找**——文件夹按来源组织，不按感觉组织
- **参考之间无联系**——一张宋代山水和一张 1927 年电影远景共享同一构图，却永远被隔开
- **收藏不产生认知**——存了 1000 张，说不出自己偏好什么视觉语言

传统工具（Eagle / Pinterest / 相册）解决「存放」，不解决「记忆」。Visual Archive 的答案是：把每一次收藏转译成同一种视觉语言，让收藏变成可检索、可解释、可反思的记忆。

## 3. Technical Approach

**Vision Understanding** — 图片经同源 bridge 代理调用多模态 LLM，输出结构化构图关系而非分类标签。25 字段 VisualIntent schema 覆盖：空间（纵深/留白）、主体（尺度/位置）、环境主导度、光（方向/质量）、色彩（色温/饱和/对比）、叙事（人际距离/唤醒度/忧郁度）。失败不静默：failed 条目持久化、可见、可重试（真实 40 张压测验证闭环）。

**Structured Intent** — 检索与统计只用结构化枚举 + 受控 token 词表（氛围/情绪中文 token），metadata（标题/标签/备注）**永不**进入检索与统计——由三重 QA 断言固定，不靠自觉。部分创作语义（梦境/超现实）在 token 空间中不可完整表达时，系统诚实映射并记录，不假装命中。

**Personal Memory** — local-first 存储（浏览器 / 本地文件双分支），纯前端 SPA + Node 静态服务，无服务端状态、无框架依赖。

**Retrieval Evidence** — 按视觉语言查询，返回 score / matchedFields / reasons 全链路证据。唯一评分器是冻结的 `scoreIntent`（19 字段权重纯函数）；检索层是薄封装。签名能力是**跨媒介共享语言**：query「孤独 + 巨大环境 + 低饱和」同时召回电影布景与绘画，因为它们被同一种语言描述。

**Profile Aggregation** — 唯一聚合器纯计数、零权重、零 embedding。Confidence 固定阈值绑定样本量（0→empty / 1–19→observation / 20–50→tendency / 50+→pattern），展示层永远说「based on N visual memories」；空池诚实 empty；unavailable 清单从数据动态检测（覆盖率不足/单值无区分度）。禁止项写入架构：无雷达图、无评分、无推荐、无「你的审美是」。

**架构纪律** — 五层单向数据流（Vision → Intent Schema → Memory → Retrieval | Profile），两次显式冻结（V1：29 文件 mtime 基线；V2 Alpha：5 文件 sha256 基线），任何变更必须回答三问：为什么需要 / 是否破坏边界 / 是否新版本。

## 4. Validation

全部真实数据、真实 provider 调用，无 mock：

| 能力 | 结果 | 证据 |
|------|------|------|
| Upload | **PASS** | 40 张真实 provider 压测：终态 82.5%（20 张池 95%）；15 个失败全部持久化+可见+可重试 |
| Memory | **PASS** | repository 11/11 · 浏览器持久化 6/6 · metadata 隔离断言通过 |
| Retrieval | **PASS** | 创作语言查询 3/5 精确命中（首轮验证）；每条带 score/matchedFields/reasons；40 资产池 0.43ms |
| Profile | **PASS** | QA 26/26 + 18/18；空池诚实 empty；跨池增长 19→26→33 十项指标全部 stable（maxΔ≤0.15） |
| Cross Media | **Partial PASS** | 「孤独人物+巨大环境」主题：电影×绘画同榜混排、共享 ≥2 条语言证据（showcase 3 主题中 1 项 READY——池构成限制，如实记录） |
| Performance | **PASS** | archive 0.02ms · search 0.43ms · profile 0.14ms（avg，阈值 50ms） |

**测试规模**：13 个 QA 套件、200+ 断言全绿（P5.5 新增 release-showcase 12/12：完整链路真实上传 10.2s / 跨媒介混排 / 不存在语言诚实返回 No strong match）；构建泄漏扫描 72 文件 0 token；冻结双基线核验通过。

## 5. Limitations

如实保留，不作淡化：

- **Local-first**：数据只在用户设备，无账号（隐私优先，也是产品边界）
- **Single user**：多用户/协作场景未覆盖
- **40 assets validated（100 not completed）**：外部素材源限制（Wikimedia Commons 持续限流 + AIGC 生成服务不可达）导致规模验证止步 40 张；33 张池上画像趋势已稳定，100 张是已知未完成项
- **Emotion field limitation**：情绪词产出稀疏（4/34，12%）——冻结 Vision 层的已知问题；画像叙事组由结构字段（孤立/疏离/唤醒度）承载
- **No cloud sync**：多设备场景未覆盖
- 检索为结构化选择，无自然语言解析（刻意的第一版决策）

---

*证据链：`docs/`（P5.1.8 → P5.5 共 15 份阶段报告）· `qa/memory/*` + `qa/portfolio/*`（全部可复现）· `portfolio/visual-archive/demo/evidence.json`（本案例全部数字的机器可读版本）*
