# Visual Archive V2 Alpha — Freeze Declaration

Date: 2026-10-02 · 依据：`docs/P5.3.2-product-validation-report.md`（最终判断：通过）
上游：Visual Archive V1（P5.2.3 冻结）→ P5.2.4 Usage Validation PASS → P5.3.0 Audit（决策 A）→ P5.3.1 Aggregator MVP PASS → P5.3.2 Scale & Product Validation PASS

## Product Definition（V2 Alpha）

在 V1「个人视觉记忆系统」（图片→视觉语言→收藏→按感觉找回）之上，V2 Alpha 新增第三种能力：**从积累的个人收藏中提取稳定、诚实的视觉倾向画像**。

```
V1（冻结）：图片 → 视觉语言 → 收藏 → 找回
V2 Alpha：  收藏 → 统计 → 个人视觉倾向（画像）   ← 本冻结
```

## Frozen Components

### 1. Profile（V2 新增冻结）
- `src/services/memory/visualProfile.js`
  - `aggregateVisualProfile()` — 唯一聚合器（纯计数、零权重、零 embedding）
  - `getConfidence()` — 固定阈值 0→empty / 1-19→observation / 20-50→tendency / 50+→pattern
  - `isProfileEligible()` — 准入（status=success && source≠empty/example）
  - `buildVisualProfile()` — async 池入口
  - 数据规则：metadata 永不参与；空池 ratio=0.00 非 NaN；unavailable 从数据动态检测
- `src/components/memory/visualProfilePresenter.js`
  - ratio 措辞阈值（≥0.55 强句 / 0.40–0.55 弱句 / <0.40 无主张→「未显现明显倾向」）
  - confidenceHeadline 四级语气 / atmosphereBlock 覆盖率注记 / unavailableBlock 诚实清单

### 2. UI Flow（V2 扩展冻结）
- 路由：V1 四路由（`#memory` / upload / search / :id）+ `#memory/profile`
- 入口：`#memory` 三 CTA（上传 / 检索 / 画像）
- 页面：`src/pages/memoryProfile.js`（Visual Identity Page——无雷达图/排名/AI 评分）+ memory.js/memory.css 相关段落

### 3. Vision / Memory / Retrieval（沿用 V1 冻结，无任何变更）
visualIntent schema / server bridge / provider / normalizer / scoreIntent / sharedReasons / memoryRepository / uploadService —— V1 冻结继续有效，本声明不重述其组件清单（见 `VISUAL_ARCHIVE_V1_FREEZE.md`）。

## Core Value（V2 Alpha 三核心）

1. **Visual Translation**（V1）— 图片→结构化视觉语言，零手动标签
2. **Visual Retrieval**（V1）— 按感觉找回 + 为什么匹配
3. **Visual Profile**（V2 新增）— 收藏→统计→「当前样本显示…」级别的倾向画像，confidence 与样本量绑定，永远不伪造审美

## Non-goals（继承 V1 全部非目标 + V2 新增）

- ❌ 继承 V1：全球艺术库/向量库/embedding/Agent/多用户/云同步/自动审美分析/自然语言检索（结构化选择是刻意的第一版决策）
- ❌ V2 新增：画像不做审美评分/不做推荐引擎/不做「你应该喜欢什么」/不评价用户/不合并 #eye 浏览行为数据
- ❌ emotion 层可靠性修复（属冻结 Vision 层变更，需显式授权单独立项）

## Freeze 规则（与 V1 相同的三问）

V2 Alpha 冻结后的任何变更必须回答：
1. 为什么需要？
2. 是否破坏 V2 Alpha 边界（上述冻结组件/数据规则/诚实清单）？
3. 是否属于新版本（V2 Beta / V3）？

触碰冻结组件走显式授权解锁；报告/QA/demo 数据/个人层验证数据可自由变更。

## 已知限制（冻结时如实记录，不视为缺陷修复项）

1. emotion 层不可用（3/19→压测池依然稀疏）——画像 narrative 组由结构字段承载
2. composition/geometry 字段 Vision 层零产出——compositionProfile 由 subjectPosition/cameraDistance/motion 承载
3. 部分创作语义（梦境/超现实/工业城市）token 空间不可完整表达——查询侧诚实映射并记录
4. 池同质化时 ratio 区分度有限（无去重机制）
5. provider 波动窗口内批量上传恢复率下降（P5.3.2：62.5% 首传）——产品层「批量重试引导」是冻结外候选改进

## 下一步

**P5.4 Portfolio Productization**（资格门已过）：产品页面 / Demo 视频 / 架构图 / 技术说明 / 使用案例——以展示为目的，不改产品能力。
