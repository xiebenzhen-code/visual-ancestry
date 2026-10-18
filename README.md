# Visual Ancestry · 视觉参考工具

> 用电影的眼睛找画，用画的结构写镜头。
> A visual research desk that searches public-domain paintings and film stills,
> reads verifiable analysis of them, and turns a selection into a creation brief.

[English](./README.en.md) · [架构与数据流](./docs/ARCHITECTURE.md) · [验收报告](./docs/ACCEPTANCE-REPORT.md) · [演示脚本](./docs/DEMO-SCRIPT.md) · [Agent Skill](./skill/visual-ancestry/SKILL.md)

![首页「画册」界面：1440×900 首屏 15 件作品，图像占首屏 73%](./docs/media/album-1-home.png)

<p align="center">
  <img src="./docs/media/album-2-search-results.png" width="49%" alt="搜索结果：命中带评分与理由">
  <img src="./docs/media/album-4-create-picks.png" width="49%" alt="CREATE 参考选择：TaskContext 参考排在最前并处于选中态">
</p>

<p align="center">
  <img src="./docs/media/album-1-home-mobile.png" width="32%" alt="390px 手机双列">
</p>

---

## 它是什么

一个零前端框架的 Web 应用 + 一个 Node Agent Skill，共用同一份检索与分析代码。

- **FIND** —— 在 51 件公共领域绘画与电影画面档案里检索；可选叠加 Wikimedia Commons 的实时检索。
- **CREATE** —— 选 2–4 件参考，生成 Prompt，并导出 Markdown。
- **SHOOT** —— 把选中的视觉原则翻成可执行的拍摄指导。
- **MEMORY** —— 视觉记忆与审美记忆，可导出成可移植档案。
- **Vision（可选）** —— 上传图片做视觉分析。**未配置 Provider 时明确不可用，不会伪装成功。**

## 运行要求

| 项目 | 要求 |
|---|---|
| Node.js | **≥ 20**（用到内置 `fetch`、`node:crypto`） |
| 运行时依赖 | **无**。只用 Node 内置模块，不需要 `npm install` |
| 可选依赖 | `sharp` —— 仅 `npm run build` 需要 |

## 启动（Windows PowerShell）

```powershell
# 1. 进目录
cd <解压后的目录>

# 2. 启动（直接跑源码树，不需要先构建）
$env:PORT = 5173
npm start
```

或者不经过 npm：

```powershell
node scripts/server.mjs . 5173
```

然后打开 <http://127.0.0.1:5173>。

> 服务端的默认静态根是 `dist/`（构建产物）。`node scripts/server.mjs .` 是**显式选择**
> 直接服务源码树 —— 这是有意的：项目目录里有 `.env`，默认指向错误目录正是历史上
> `GET /.env` 泄漏的原因。白名单守卫两种方式都拦得住。

## 配置 Vision（可选）

不配置也能完整使用检索、分析、CREATE、SHOOT、MEMORY。只有「上传图片 / 以图搜图」不可用。

```powershell
Copy-Item .env.example .env
# 编辑 .env 填入 VISION_API_BASE / VISION_API_KEY（仅服务端生效）
$env:VISION_API_BASE = "https://.../v1/chat/completions"
$env:VISION_API_KEY = "..."
node scripts/server.mjs . 5173
```

安全默认：Provider 已配置但**没配预算账本时，服务端拒绝调用**（fail-closed），
不会因为「忘记设预算」而放开付费 Key。完整变量说明见 [`.env.example`](./.env.example)。

## Agent Skill

```bash
node skill/visual-ancestry/scripts/va.mjs search "孤独 夜晚" --limit 5
node skill/visual-ancestry/scripts/va.mjs intent bahram-gur-karg
node skill/visual-ancestry/scripts/va.mjs plan --refs bahram-gur-karg,the-kiss --out plan.md
node skill/visual-ancestry/scripts/va.mjs vision-status
```

Skill **直接 import 网页用的那份检索与分析模块**，不另写一套电影搜索算法。
没有 Vision Provider 时它会明确报告不可用，不会把本地检索结果包装成「识图结果」。
详见 [`skill/visual-ancestry/SKILL.md`](./skill/visual-ancestry/SKILL.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `index.html` | 入口；默认皮肤是「画册」A 方案 |
| `src/pages/` | 路由级页面：`find` / `create` / `shoot` / `memory` |
| `src/services/retrieval/` | 检索与打分（Skill 与网页共用） |
| `src/services/source/` | 外部来源：Commons 检索、电影概念拆分、许可判定 |
| `src/services/vision/` | 视觉分析契约与归一化 |
| `src/data/` | 档案数据（作品、电影画面、VisualIntent 记录） |
| `server/security/` | 访问控制、预算账本、静态路径守卫 |
| `scripts/server.mjs` | 静态服务 + Vision API |
| `public/assets/` | 本地图片素材（thumb / preview / detail 三档） |
| `qa/` | 可运行的验收脚本（不含浏览器 profile 与截图证据） |
| `docs/` | 架构说明与阶段报告 |

## 能力边界（诚实清单）

**已实现并真实验证**

- 51 件本地档案检索（绘画 + 电影影像），带评分与命中理由
- Wikimedia Commons 实时电影影像检索，含概念拆分与权利判定
- Met 博物馆 API 检索（v1.1 搜索接口实测可用；旧 v1 已于 2026-10-01 退役返回 410）。
  注意：首次连接可能约 10s 超时，适配器无自动重试；失败时该通道诚实报错，不影响其他通道
- 45 条 VisualIntent 分析记录，读取时携带 provenance 与来源链接
- CREATE 选参 → 生成 Prompt → 复制 / 导出 Markdown
- TaskContext 参考在页间正确传递
- 记忆的导出与再导入

**未完成 / 不可用**

- **Vision 上传识图（真实 Provider）**：未配置任何真实识图模型，上传图片 / 以图搜图
  **实际不可用**——服务端返回 503，界面如实显示不可用。P3.1 的 Mock 安全门禁
  （意图结构校验、预算 fail-closed、静态路径守卫）已经真实验证，但那**不等于**真实识图可用
- **电影影像覆盖**：当前收录 15 件（10 件影片帧 / 截图 / 剧照 + 5 件宣传类影像，
  性质逐件标注），未做进一步扩充
- **Animation**：本地档案**没有动画素材**，动画视觉检索不可用——选择 animation 媒介
  只会得到如实的空状态，不会退化成「全部」，本仓库也不宣称支持动画视觉检索
- 无用户系统、无云端持久化、无移动端原生壳

**Agent Skill 的能力边界**

- 本地能力（不依赖外部服务）：`search`（本地档案检索）、`intent`（读取 45 条
  VisualIntent 记录）、`plan`（生成并导出创作方案）
- 依赖外部服务：`vision-status` 需要服务端 `/api/vision`（未配置时如实报告不可用）；
  带 `--external` 的检索需要访问 Wikimedia Commons（约 9–20s）

## 素材许可

代码 MIT。图片素材许可**逐件不同**；逐件许可、来源文件页与核验方法见
[`LICENSE-ASSETS.md`](./LICENSE-ASSETS.md)：

- 46 件附带图像的绘画：**44 件 Public domain + 2 件 CC0**（公有领域奉献），
  全部经 Wikimedia Commons 文件页实时核验（核验日期 2026-10-18）
- 15 件电影影像：均为 Public domain（Commons 文件页核验）；其中 5 件为宣传类影像，
  10 件为影片帧 / 截图 / 剧照，性质已逐件标注
- 另有 5 件绘画未附带图像（仅保留著录），不涉及再分发
- 许可核验脚本与证据 JSON 随仓库分发（`qa/licence-audit/`），全新克隆后可复现

## 最小真实验收

```powershell
npm start
# 浏览器打开 http://127.0.0.1:5173
#   1. 首页搜索「孤独 夜晚」→ 应出现命中作品与理由
#   2. 点开任一作品 → 侧栏出现「使用参考」
#   3. 进入 CREATE（#create）→ 该参考应排在参考区最前并处于选中态
#   4. 选到 2 幅 → 生成 Prompt → 导出 Markdown
# 5. Skill（另开一个终端）
node skill/visual-ancestry/scripts/va.mjs search "孤独 夜晚" --limit 3
node skill/visual-ancestry/scripts/va.mjs plan --refs bahram-gur-karg --out plan.md
```

验收脚本（需要本机 Edge）：`node qa/ui/ui-final-acceptance.mjs`、`node qa/find/edge-cdp-e2e.mjs`、`node qa/ui/round3-check.mjs`。

许可核验复现（免密钥，只读 Commons 公共 API）：

```bash
node qa/licence-audit/rc1-artwork-licence-audit.mjs   # 逐件核验 46 件画作
node qa/licence-audit/rc1-film-licence-audit.mjs      # 逐件核验 15 件电影影像
```

## 数据与隐私

- 视觉记忆保存在浏览器 localStorage，可一键导出/清空。
- 所有 Vision 凭据只存在于服务端进程环境变量；构建产物不包含任何 `VISION_*` 值。
