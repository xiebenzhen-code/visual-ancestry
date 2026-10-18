# Release Candidate 1 — 候选清单

生成日期：2026-10-18
候选 commit：**`cd4f3fd`**（分支 `master`）
仓库位置：`visual-ancestry/release/visual-ancestry/`（**独立 Git 仓库**，不是外层仓库的分支）

> 外层 `referenced-chatgpt-conversation-…` 仓库只有 8 个已跟踪文件，
> `visual-ancestry/` 整体未被 Git 跟踪，`work/ui-home-find/` 更是被忽略。
> 因此「本地测试通过」并不代表 GitHub 上有这些东西 —— 本轮据此新建独立仓库。

---

## 1. 唯一候选 commit 与历史

```
cd4f3fd  Add job-showcase material: screenshots, architecture diagram, demo script, decisions, acceptance report
5e329ab  Separate 'request succeeded' from 'found hits' in the Skill
3151b17  Poll for the 390px precondition instead of probing once
e753114  Add qa/ui harnesses that the release README promises are runnable
d41a4c3  Add Agent Skill exposing search, VisualIntent read, and plan export
9ba7da5  Add release scaffolding: bilingual README, .env.example, LICENSE, .gitignore
1958657  Add runnable acceptance harnesses (no browser profiles, no evidence dumps)
59863d9  Add architecture and data-flow notes plus stage reports
8539567  Import product source: retrieval, CREATE, memory, vision contract, server
```

- 仓库身份为**仓库内局部设置**（`user.name = Visual Ancestry`），未改动你的全局 Git 配置。
- 工作区干净，无未提交改动。
- **未 push、未创建远端、未发布** —— 等你授权。

---

## 2. 文件变更范围

| 分类 | 内容 | 规模 |
|---|---|---|
| 产品源码 `src/` | 95 个 JS 模块 | 860 KB |
| 服务端 `server/` + `scripts/` | 6 + 22 个模块 | 120 KB |
| 素材 `public/assets/` | 184 个文件（thumb/preview/detail 三档） | 42.6 MB |
| 文档 `docs/` | 96 份文档 + 架构图 + 4 张截图 | 2.1 MB |
| 验收 `qa/` | 75 个脚本（**无** profile、**无**截图证据） | 1.2 MB |
| Skill `skill/` | SKILL.md + 1 个 CLI | 12 KB |
| 根文件 | `index.html`、`package.json`、README 中英双语、`.env.example`、`LICENSE`、`.gitignore` | — |
| **合计** | **549 个文件** | **47.6 MB** |

**被刻意排除的内容**（各 1.8 GB 级）：

| 排除项 | 原因 |
|---|---|
| `qa/**/profile/`、`*-edge-profile/` | 浏览器 profile 含访问历史 |
| `qa/**/*-shots/`、`ui-shots/` | 验收证据，不进产品仓库 |
| `work/` | 一次性诊断与实验产物 |
| `node_modules/`、`dist/` | 可生成 |
| `.env`、日志、账本 | 不存在或不应存在（已扫描确认） |

---

## 3. 能力矩阵

| 能力 | 状态 | 依据 |
|---|---|---|
| 本地档案检索（绘画 + 电影画面，51 件） | **REAL-TESTED** | 命中带评分与理由 |
| 结构化意图解析（中文 → 视觉维度） | **REAL-TESTED** | `parseVisualIntent` |
| 外部来源检索（Wikimedia Commons） | **REAL-TESTED** | E2E 4a/4b/4c |
| 外部来源降级说明 | **REAL-TESTED** | E2E 8a/8b |
| 外部来源缓存（浏览器内 24h） | **INTEGRATED**（仅网页；Node 下不生效，已在 SKILL.md 说明） |
| VisualIntent 分析读取（46 条，含 provenance） | **REAL-TESTED** | `va.mjs intent` |
| 跨页参考传递 TaskContext | **REAL-TESTED** | 参考位于位置 0、选中态正确 |
| Prompt 生成 | **REAL-TESTED** | 每件只贡献真实存在的字段 |
| Markdown 导出 | **REAL-TESTED** | 真实落盘并回读 |
| 记忆（导出 / 再导入） | **IMPLEMENTED** | 随仓库交付 |
| SHOOT 拍摄指导 | **IMPLEMENTED** | 随仓库交付 |
| Agent Skill 三项能力 | **REAL-TESTED** | 另一 Agent 会话实际执行 7 条命令 |
| 静态路径守卫 | **REAL-TESTED** | `.env` / 路径穿越均拒绝 |
| 预算 fail-closed | **IMPLEMENTED** | 逻辑在 `server/security/budget.mjs` |
| **Vision 上传识图** | **BLOCKED** | Provider 未配置；本轮禁止付费调用 |
| **动画本地素材** | **BLOCKED** | 管线支持，档案无动画作品，如实空状态 |
| **Met 馆藏 API** | **BLOCKED** | 上游 `/v1/search` 已于 2026-10-01 退役（HTTP 410） |

> 状态定义：`IMPLEMENTED` 已实现未实测 ｜ `INTEGRATED` 已接入但依赖外部条件 ｜
> `REAL-TESTED` 真实环境验证通过 ｜ `BLOCKED` 明确不可用。
> **没有 Mock PASS。**

---

## 4. 候选与开发树的差异（已核对）

| 项 | 结果 |
|---|---|
| `src` 文件数 | 105 vs 105，**无缺失** |
| `src` 内容差异 | 15 个文件仅换行符不同（CRLF vs LF），语义等价 |
| `index.html` | 完全一致 |
| `server` / `scripts` / `public` | 无实质差异 |
| 差异文件 | 4 个零字节 `.gitkeep`（占位文件，可忽略） |

---

## 5. 本轮不动的边界

- R4.6 冻结树 `work/p6.4-release`：**0 文件改动**
- R4.5 公网部署：未触碰
- Vision Provider 配置：未修改，`VISION_*` 环境变量 **0 个**
- 预算账本：未重置，仍为 2 行
- 云资源：未新增
- **未 push、未公开仓库、未创建 Release**
