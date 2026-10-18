# Visual Archive — Case Study

> A local-first personal visual memory system: turn images into a structured
> visual language, find them back by feeling, and read your own aesthetic
> tendencies from what you kept.
>
> **1 张图片 → 视觉语言 → 个人记忆 → 按感觉找回 → 个人视觉倾向**

---

## Problem

创作者的视觉参考会大量积累——电影截图、绘画、随手拍的构图。但参考图存进文件夹之后**就死了**：

- 找回靠记忆和翻找（文件夹是按来源组织的，不是按「感觉」）
- 参考之间没有联系（一张宋代山水和一张 1927 年电影远景共享同一种构图，但文件夹永远把它们隔开）
- 收藏从不产生认知（存了 1000 张，说不出自己偏好什么视觉语言）

传统工具（Eagle/Pinterest/相册）解决「存放」，不解决「记忆」。

## Solution

Personal Visual Archive 把每一次收藏转译成同一种**结构化视觉语言**（25 字段：空间纵深、环境主导、人物尺度、光质、色温、人际疏离…），然后：

```
Image（任意图片：电影截图 / 绘画 / 照片）
  ↓  AI Vision（零手动标签）
Visual Language（25 字段 VisualIntent）
  ↓  Personal Memory（本地存储，失败可见可恢复）
Retrieval（按感觉找回 + 中文理由解释）
  ↓
Profile（个人视觉倾向画像，样本量绑定置信级）
```

三个核心行为（全部实测）：

1. **存**：拖入图片 → 自动转译 → 失败卡片可见、可解释、可重试（无黑盒）
2. **认**：用创作语言查询（「孤独的人站在巨大环境中」→ 空旷+深空间+环境主导+孤立），跨媒介返回电影与绘画，每条带「为什么匹配」
3. **述**：收藏到一定规模后，画像页用「当前样本显示…」的诚实语气描述你的视觉倾向——19 张时绝不说「你的审美是」

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ UI Layer   #memory（档案） / upload / search / :id   │
│            #memory/profile（Visual Identity Page）   │
├─────────────────────────────────────────────────────┤
│ Profile Layer (V2)  visualProfile.js + presenter    │
│   纯计数聚合 · confidence 分级 · 诚实清单            │
├─────────────────────────────────────────────────────┤
│ Retrieval Layer    retrieveVisualMemory（薄层）       │
│   → 冻结 scoreIntent（19 字段权重，唯一评分器）        │
├─────────────────────────────────────────────────────┤
│ Memory Layer       memoryRepository（local-first）   │
│   uploadService（失败闭环：保存→可见→重试）           │
├─────────────────────────────────────────────────────┤
│ Vision Layer       /api/vision bridge → provider     │
│   normalizeVisionIntent → 25 字段 schema             │
└─────────────────────────────────────────────────────┘
```

设计纪律：**单向数据流 + 单一职责层**。Profile 只读 Memory；Retrieval 只 import 冻结评分纯函数；metadata（标题/标签/备注）永远不进入检索与统计——三重 QA 断言（P5.2.1/P5.3.1/P5.4）。V1（图片→记忆→找回）与 V2 Alpha（+画像）两次显式冻结，全部变更走「为什么需要/是否破坏边界/是否新版本」三问。

## Validation Evidence（全部真实数据，无 mock）

| 阶段 | 验证 | 关键数字 |
|------|------|----------|
| P5.1.8 Upload Reliability | 40 张真实上传压测 | 终态 82.5%；15 个失败全部持久化+可见+可重试（闭环 8/15 恢复，恢复率随 provider 波动浮动——诚实记录） |
| P5.2 Retrieval | 创作语言查询 | 5 Case 中 3 个精确命中；检索 0.36ms（40 资产池） |
| **P5.3 Profile** | 画像聚合 | QA 26/26 + 44 项质量断言全过；空池诚实 empty；metadata 污染零影响 |
| **P5.3.2 Scale** | 画像稳定性 | 10 指标跨池增长**全部 stable**（maxΔ≤0.15）——记忆随规模增长保持连续 |
| P5.4 Portfolio | 端到端 | Demo Flow 25/25 · Product Quality 18/18 · 跨媒介 showcase：电影《大都会》时代远景与范宽/雾海漫游者同榜混排，共享「环境压过人物/纵深很深/留白很大」三条语言证据 |

**跨媒介是这个系统的签名能力**：Query「孤独 + 巨大环境 + 低饱和 + 环境主导」同时召回 1927 年电影布景与北宋山水/浪漫主义绘画——因为它们被同一种视觉语言描述。用户存的是素材，找到的是语言。

## Limitations（如实保留）

- **Local-first**：数据只在用户自己的浏览器/本地文件，无账号无云同步（隐私优先，也是边界）
- **No cloud sync**：多设备场景未覆盖
- **Emotion field limitation**：情绪词产出稀疏（冻结 Vision 层已知问题）——画像的「叙事组」由结构字段（孤立/疏离/唤醒度）承载，不含情绪词
- **40 assets validated（100 not completed）**：外部素材源限制（Wikimedia Commons 限流 + AIGC 生成服务不可达）导致规模验证止步 40 张；33 张池上趋势已稳定，100 张是已知的未完成项
- 检索是结构化选择，无自然语言解析（刻意的第一版决策）
- 部分创作语义（梦境/工业城市）在 token 空间中不可完整表达——系统不假装命中

## Tech Notes

- 纯前端 SPA + Node 静态服务（无框架依赖的服务端状态）；视觉分析经同源 bridge 代理调用多模态 LLM（无浏览器端密钥）
- 测试证据链：`qa/memory/*`（13 个测试文件，200+ 断言）+ `qa/portfolio/*`（3 个验收测试）+ 全部阶段报告（`docs/`，10 份）
- 冻结治理：V1 Freeze（29 文件 mtime 基线）→ V2 Alpha Freeze（Profile/Presenter/UI Flow + hash 基线）
