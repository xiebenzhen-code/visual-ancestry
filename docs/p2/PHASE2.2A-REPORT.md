# Frame Atlas v0.3 Phase 2.2A — 电影与动画真实画面接入

日期：2026-10-21 ｜ 分支：`develop/v0.3-visual-explore` ｜ 基线：`71513d4`

本轮把电影档与动画档从 0 变成真实可用：接入 Wikimedia Commons 的画⾯分类，并从 Blender 开放影片里用 ffmpeg 抽真实剧情帧。没有调用任何付费 Vision API，没有新增详情系统，没有改四馆调用行为。

---

## 一、结果

| 类型 | 数量 | 来源 | 其中黑白（被媒介政策排除） | 可作参考 |
|---|---|---|---|---|
| 电影画面 `film-still` | **24** | Blender 抽帧 10 ｜ Commons 14 | 7 | 17 |
| 动画画面 `animation-frame` | **20** | Blender 抽帧 10 ｜ Commons 10 | 1 | 19 |

许可分布：CC BY 3.0（Blender）、CC BY-SA 3.0/4.0、CC0、Public domain。库里没有一张“许可不明”的画面：缺字段或 fair use 的一律跳过。

均远超“每类至少 10 张”的目标；两类都没有用另一类凑数，也没有用封面/概念图冒充画面。

---

## 二、Commons 采集（STEP 1）

`scripts/discovery/providers/commonsCinema.mjs`

- 只用 MediaWiki 官方 API（`generator=categorymembers` + `imageinfo`），不抓 HTML。
- 分类：`Film screenshots`、`Film frames`、`Film stills`、`Animated film screenshots`。
- 许可硬校验：`LicenseShortName` / `UsageTerms` 必须命中 public domain / CC0 / CC BY / CC BY-SA；命中 `fair use`、`all rights reserved`、缺字段 → 跳过并记原因。
- 画面自证：描述 + 分类 + 文件名里必须有 `film|movie|cinema|animat|cartoon|screenshot|frame`，否则跳过。
  这一条是收紧后加的：`Film stills` 分类里混着“毯子上的一堆照片”这类非影片图，只靠分类会误收。
- 标题级排除：poster、title card、intertitle、trailer、behind the scenes、making-of、logo、cover、DVD/Blu-ray、concept art、storyboard。另外挡掉 `Muybridge`、`test stills`、`explosion`、`nuclear` —— 这些是 `Film frames` 里真实存在的非影片静帧。

一个实测教训：图片校验阶段遇到 429 时原本会按 `Retry-After` 原值睡眠，服务器返回几千秒就把整轮采集拖死。现在等待上限 2.5 秒，超时记失败并跳过。

---

## 三、Blender 开放影片（STEP 2）

`scripts/discovery/providers/blenderFrames.mjs`

| 影片 | 类型 | 许可 | 官方地址 | 体积 |
|---|---|---|---|---|
| Tears of Steel (2012) | 真人电影 | CC BY 3.0 | mango.blender.org | 355 MB |
| Big Buck Bunny (2008) | 3D 动画 | CC BY 3.0 | peach.blender.org | 116 MB |

- 从官方下载站取原片，`ffmpeg -ss <ts> -frames:v 1` 在 10 个固定时间点抽帧，避开片头与片尾字幕。
- 每帧记录：影片名、时间戳（秒）、许可与许可链接、影片主页、原始下载地址。
- 抽帧是**离线构建步骤**（`npm run discovery:cinema:blender`），用户浏览时不下载视频；已抽过的帧直接复用（幂等）。
- 未做：《Spring》在 `download.blender.org` 上没有可用的公开直链（720p/1080p 多个候选都 404），本轮只用 ToS + BBB 覆盖真人/动画两类。

---

## 四、产品接入（STEP 3）

- 画面走现有 external 索引：`#artwork/r.<图片哈希>`，同一个 `artwork.js`，没有第二套详情。
- 详情页新增可溯源字段：影片、时间戳、署名；来源外链仍是“查看原始馆藏 ↗”。
- 媒介筛选沿用既有口径，新增 `animation-frame` 类型：
  - 电影档 = `film-still` + `tv-episode-still`
  - 动画档 = `animation-frame` + `tv-episode-still`
  - 黑白（`meanSat < 0.06`）继续排除——本轮因此挡掉 7 张电影帧与 1 张动画帧（含 Metropolis 帧）。
- **同媒介视觉近邻**：新增一行独立区域。原因很实在——一件绘画与电影画面在像素亲和度上常达不到风格阈值，若只按风格证据筛，媒介档会永远是空。这一行明确写“仅向量近邻，未做风格判定”，不混进四条风格分支，也不出现“同风格”字样。
- 四馆适配器未改动。

---

## 五、验收（STEP 4）

`qa/p22-cinema.mjs`，真实浏览器（Edge headless + CDP）：

```
PASS 电影档非零且图片真实加载      同媒介 6 张 / 图 6/6 / 类型 film-still
PASS 动画档非零且图片真实加载      同媒介 6 张 / 图 6/6 / 类型 animation-frame
PASS 彩色电影档里没有黑白画面      6 张，最低饱和度均 ≥0.06
PASS 点击画面进入统一详情          Moça · 图 已加载
PASS 详情页带许可与来源溯源信息     版权 CC BY-SA 4.0 / 查看原始馆藏
PASS 从画面继续探索返回真实候选    n=2
PASS 刷新后仍打开且图片可用        r.988d7608…
PASS 切回不限后候选恢复
=== 电影/动画端到端 9/9 PASS ===
```

契约测试 `qa/features/p22-cinema.test.mjs`：12/12 PASS（非画面排除、许可拒绝、动画帧语义、媒介分流、黑白排除、可追溯字段）。

回归：单元 **543/543（23 套件）**；构建 121 文件、泄漏扫描 0 命中；账本未动，仍是 **15/17**（本轮 0 次付费调用）。

截图：`.rc1-audit/discovery/p22/01-film-mode.png`、`02-animation-mode.png`、`03-frame-detail.png`、`04-frame-explore.png`。

---

## 六、明确没做到的

1. **《Spring》未接入**：官方下载站无可用直链（多个候选 404）。不做镜像猜测。
2. **商业日漫没有接入**：Commons 上的日本动画截图多为第三方上传，**不因出现在第三方站点就默认拥有索引授权**。本轮动画覆盖是公有领域早期动画（Baby Huey、Paramount 卡通等）+ CC BY 的 Big Buck Bunny，不宣称覆盖商业日漫。
3. **Commons 画面质量参差**：分类成员由上传者自述，个别标题仍像文件名；已用描述替换机器标题，但没有人工逐张复核 24 张。
4. **同媒介近邻不是风格结论**：它只是“同媒介 + 向量最近”，界面上写明未做风格判定。
5. **ffmpeg 依赖**：抽帧需要本机 ffmpeg（本轮 9.0.1）；未安装时该来源报 `video-missing`，不影响其他来源。

---

## 七、命令

```powershell
npm run discovery:cinema -- --limit 16          # Commons 分类 + Blender 抽帧
npm run discovery:cinema -- --only blender      # 只抽帧（离线、幂等）
npm run discovery:cinema -- --only commons --categories "Category:Film screenshots"
npm run discovery:index                          # 向量 + 像素特征
npm run discovery:status
```

## 八、GitHub

分支 `develop/v0.3-visual-explore`，未动 `main`，未 force push，未部署，未建 Release。本地与远端 SHA 见本轮回执。
