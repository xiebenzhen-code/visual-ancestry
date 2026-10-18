# CONTROL LAYER — INDEX

**建立日期**：2026-10-08
**阶段**：P6.3.1D
**性质**：Engineering Control Layer（工程控制层）

---

## 这是什么

本目录是项目的**单一事实源**（single source of truth）。
记录当前真实状态、架构、错误、验证门禁与决策依据。

## 这不是什么

- **不是产品代码** —— `src/`、`server/`、`scripts/` **不依赖** `docs/control`
- **不是未来计划** —— 只记录已有代码/测试/证据支持的状态
- **不是聊天记录** —— 结论必须能追溯到源码或实测数据

---

## 文档清单

| 文档 | 内容 | 何时更新|
|---|---|---|
| [INDEX.md](INDEX.md) | 本页，目录与使用规则 | 文档结构变化时 |
| [CURRENT_STATE.md](CURRENT_STATE.md) | 阶段、阻塞项、下一步 | **每个阶段结束时** |
| [ARCHITECTURE_CURRENT.md](ARCHITECTURE_CURRENT.md) | 运行时架构、数据流、信任边界 | 架构变化时 |
| [ERROR_REGISTRY.md](ERROR_REGISTRY.md) | 全部错误（含已解决） | 发现/解决错误时 |
| [VALIDATION_GATES.md](VALIDATION_GATES.md) | 阶段链与通过标准 | 门禁变化时 |
| [DEPLOYMENT_READINESS.md](DEPLOYMENT_READINESS.md) | 部署就绪度 | 状态变化时 |
| [DECISION_LOG.md](DECISION_LOG.md) | 架构决策与推翻条件 | 决策变更时 |
| [GLOSSARY.md](GLOSSARY.md) | 术语表 | 术语稳定后 |
| [MISSING_EDGE_AUDIT.md](MISSING_EDGE_AUDIT.md) | 边界缺口审计 | 审计时 |

---

## 使用规则

### 必须遵守

1. **状态词只用枚举值**：`completed` / `frozen` / `open` / `blocked` / `not required` / `audit required`
   —— **禁止**「基本完成」「差不多」这类模糊表述
2. **每条状态必须有证据** —— 源码行号、sha256、或实测输出
3. **已解决错误不得删除** —— 标 `FROZEN`，防止回归后重复调查
4. **不得跨 Gate** —— 见 `VALIDATION_GATES.md`

### 禁止事项

- 不得让产品代码 import `docs/control/`
- 不得基于本文档直接改代码而不做 Phase 0 盘点
- 不得在本文档中记录任何凭据

---

## Canonical Inventory（PHASE 0 实测）

盘点时间：2026-10-08，**依据真实文件系统**

| 项 | 实测值 |
|---|---|
| `src/` | 83 files |
| `server/` | **1 file**（`vision/openaiProvider.mjs`）|
| `scripts/` | 21 files |
| `public/` | 152 files |
| `docs/` | 90 files（+本控制层 9份）|
| `work/` | 15 568 files（实验产物，非产品）|
| `qa/` | 250 files（30 个 `.mjs` 验收脚本）|
| `dist/` | 237 files（构建产物）|
| `package.json` scripts | `dev` / `build` / `preview` —— **无 `test`** |
| devDependencies | **仅 `sharp`** |
| `tests/` 目录 | **不存在** |
| `git diff` | **空**（无未提交的产品代码改动）|
| git HEAD | `f20be51` |

### 重要结论：测试基础设施现状

**项目没有单元测试框架。** 质量保障依靠：

| 机制 | 实现 |
|---|---|
| 构建期泄漏扫描 | `scripts/build.mjs` 的 `FORBIDDEN_HARD` / `FORBIDDEN_CONTEXT` |
| 验收脚本 | `qa/*.mjs`（30 个，Playwright 类）|
| 冻结校验 | sha256 逐模块比对 |
| 一次性验证脚本 | `work/p6.3.x/*.mjs` |

**这是已登记的缺口**（见 `MISSING_EDGE_AUDIT.md` · MEA-01）。

---

## 当前快照

```
CURRENT_STAGE    = P6.3.1D
CURRENT_BLOCKERS = E03（reasoning_effort 透传未知）
                   E08 + E10（schema 双重不确定）
                   E12（无公网后端）
NEXT_GATE        = P6.3.1E
NEXT_HUMAN_ACTION= node .\work\p6.3.1d\reasoning-effort-isolation.mjs
```

详见 [CURRENT_STATE.md](CURRENT_STATE.md)。