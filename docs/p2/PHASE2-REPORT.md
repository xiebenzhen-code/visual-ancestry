# Visual Ancestry v0.3 Phase 2 — 自动发现管线报告

日期：2026-10-21 ｜ 分支：`develop/v0.3-visual-explore` ｜ 提交：`d7125c2`

本报告只记录**实际发生过的事**。没有发生的（TMDB 实测、动画剧照、开放影片）在第五节单列，不用封面或无关图补齐。

---

## 一、最重要的一条验收

> 不手动向 `artworks.js` 添加作品，也不要求用户运行脚本，系统就能从外部获得新的真实图片，并让这些图片参与连续视觉探索。

**已达成**，证据链：

外部 API（Met / Cleveland / Commons）
→ 图片真实下载并解码（读字节头取尺寸）
→ MobileCLIP 512 维向量 + 像素特征入库
→ 作品页 `paris-rainy-day` 的四条探索分支各出现 3 张外部候选
→ 首页图片墙尾部追加 8 张外部发现图

浏览器实测（`qa/p2-shots.mjs`）：

```
首页: {"plates":16,"discovered":8,"sources":["openverse · 自动发现"]}
作品页外部候选: {"n":12,"status":"已接入 12 张外部自动发现图（当前索引 280 张）"}
                 {"subject":3,"scene":3,"composition":3,"local":3}
```

截图：`artwork-external-branches.png`（Met 的 Mountain Landscape、Cleveland 的 Landscape with Streams and Mountains 出现在「换主体」分支里）、`home-with-discovery.png`、`artwork-external-mobile.png`。

`src/data/artworks.js` 在本轮**零改动**（`git show --stat d7125c2` 中不含该文件）。

---

## 二、六类来源的实际可用性

| 来源 | 状态 | 本轮实测 | 说明 |
|---|---|---|---|
| 博物馆（AIC / Met / Cleveland / Rijks） | **可用** | HTTP 200，单关键词合计 62–101 条 | Met 已用 `v1.1/search`；Cleveland 加 `has_image=1` 且上限 40 |
| Openverse | **可用** | HTTP 200，20 条 / 关键词 | 匿名 `page_size` 上限 20（超出 401），固定 20 + 翻页 |
| Wikimedia Commons | **本轮新增，可用** | HTTP 200，30 条 / 关键词，944–4789ms | `generator=search` + `imageinfo`，只取文件命名空间 |
| TMDB | **credential-required（未配置）** | 0 次请求 | 适配器已实现（search / images / episode stills），无 Token 时明确返回该状态且不发请求 |
| AniList | **可用** | HTTP 200，20 条，973ms | 只有目录封面，**0 张剧集画面** |
| 开放影片（LoC） | **未实现** | — | 本轮未做，登记为缺口，不用别的东西顶替 |

### 统一记录

每条记录都带：`provider / providerId / title / creator / year / medium / imageKind / imageUrl / thumbnailUrl / sourceUrl / rightsStatus / license / width / height / fetchedAt / missing[]`。

字段缺失写进 `missing`，不猜。`imageKind` 取值：`artwork / photograph / anime-cover / poster / promotional-backdrop / tv-episode-still / film-still / unknown`。
只有 `tv-episode-still` / `film-still` 被 `isAnimationFrame()` 认定为「画面」，封面、海报、宣传背景一律不算。

---

## 三、入库与索引

累计 **280 件**，全部有真实缩略图、实测尺寸、向量与像素特征：

| 来源 | 件数 |
|---|---|
| commons | 89 |
| met | 65 |
| cleveland | 60 |
| rijks | 26 |
| openverse | 20 |
| anilist | 20 |

按 `imageKind`：`artwork` 185 ｜ `photograph` 75 ｜ `anime-cover` 20。
磁盘：286 个缩略图 / 57.5 MB（`.rc1-audit/discovery/`，已 gitignore，不进 Git）。

按关键词：`rainy city street` 62 ｜ `mountain landscape` 101 ｜ `decorative painting` 97 ｜ `anime` 20。

### 画质与尺寸

**PoC-02 已解决**：Rijks 26 件原先全缺 `ratio` 进不了网格；现在尺寸来自真实下载字节的头部解析，26/26 全部有实测宽高（例：`Carriages and Waiting Coachmen` 960×699）。全库缺尺寸件数 **0**。

### 图片校验失败（真实、未掩盖）

每个关键词约 23–25 张图校验失败，几乎全是 `image HTTP 403`（Met 主图热链限制）。这些记录**没有入库**，也没有用占位图代替。

---

## 四、脚本与命令

```
scripts/discovery/
  http.mjs            统一出口：https + 域名白名单 + 超时 + 有界重试 + 429/Retry-After + 8MB 上限
  normalize.mjs       统一记录 + 缺失字段登记 + imageKind 语义
  validate-image.mjs  读字节头解析尺寸，拒非图片/小图
  engine.mjs          校验 → 三键去重 → 落库（CLI 与服务端共用）
  store.mjs           works.ndjson / images / index.json / runs.ndjson
  measure.py          像素特征（画幅/明度重心/不对称/饱和度）
  providers/          museums · openverse · commons · tmdb · anilist
  harvest.mjs         discover / index / verify / status
```

真实可执行命令（npm scripts 已加）：

```powershell
npm run discovery:discover -- --query "rainy city street" --limit 30
npm run discovery:harvest          # 默认 limit 30
npm run discovery:index
npm run discovery:verify
npm run discovery:status
```

服务端接口（浏览器不直连外部 API，也拿不到 Token）：

```
GET  /api/discovery/status
GET  /api/discovery/wall?topic=&limit=
POST /api/discovery/harvest      {query, limit}      10 分钟窗口 + 每分钟 2 次额度
POST /api/discovery/neighbors    {artworkId}         → 四条分支归类好的外部候选
GET  /api/discovery/image/:hash                      只服务已校验的本地缩略图
```

### 自动触发

用户打开作品页时，页面自动调用 `/api/discovery/neighbors`，服务端先查索引，命中直接返回；候选不足时才在额度内向外部查询，并把新图写入当前分支结果。用户不需要打开 PowerShell。

### 重复运行（STEP 5E）

再次执行 `rainy city street`：

```
已入库跳过 62 条（不重复下载）
去重：新增 0（重复 id 0 / 同图 0 / 同作品 0）
待索引 0 / 共 280 → 无需索引
```

换主题（`mountain landscape` / `decorative painting` / `anime`）继续新增 218 件，未改任何作品清单。

---

## 五、缺口（没有做到的部分）

1. **TMDB 完全未验收**：`TMDB_READ_ACCESS_TOKEN` 未配置。电影/剧集剧照、海报分类、动画单集画面**一张都没有实测**。适配器已按官方接口写好（`/3/search/{movie,tv}`、`/3/{movie,tv}/{id}/images`、`/3/tv/{id}/season/{s}/episode/{e}/images`），但没有凭据就不宣称可用。
2. **动画分类里没有真画面**：AniList 20 条全是 `anime-cover` 目录封面，`isAnimationFrame()` 判定为 0。动画档在界面上仍是空状态，不用绘画或封面填充。
3. **开放影片（LoC）未实现**：`loc.mjs` 不存在。
4. **Openverse 只跑了第一个关键词**：后两轮为控制时长只跑了 `museums,commons`，属于主动取舍，不是失败。
5. **外部候选只做向量近邻，没有 Vision 验证**：结果标注为「外部发现」，不声明「同风格已验证」。界面不显示模型名、RRF、端点或内部证据等级。
6. **Met 图片 403 比例偏高**（每轮约 24 张），属上游热链限制，未做规避。

---

## 六、成本与资源

- **DeepSeek 真实付费调用：0 次**。账本仍为 15/17，未清零、未抬额。
- 向量全部本地计算（MobileCLIP-S0 ONNX），免费。
- 外部请求：每关键词 5–6 个接口 + 每张候选图 1 次缩略图下载；单轮 discover 约 1–2 分钟（Met 单次 21–42 秒是主要耗时）。
- 磁盘：缩略图 57.5 MB，索引 1.4 MB。

---

## 七、测试与安全

- 单元 **514/514**（21 套件），新增 `qa/features/p2-discovery.test.mjs` 16 项：来源齐全、TMDB 凭据语义、记录字段与缺失登记、封面≠画面、字节尺寸解析、白名单拒绝、三键去重、索引覆盖、像素特征覆盖、Rijks 不编造尺寸。
- 构建：120 文件，泄漏扫描 0 命中。
- 提交前扫描：无 Token/密钥命中；`.env` 与 `.rc1-audit/` 均未被跟踪。
- 采集安全：域名白名单（17 个主机）、20s 超时、并发 6、8MB 上限、429 退避、无效图剔除、目录/按 id 预过滤。

---

## 八、GitHub

- 分支：`develop/v0.3-visual-explore`（新建，未触碰 `main`，未 force push，未建 Release，未部署）
- 本地 HEAD：`d7125c2`
- 远端 SHA：`d7125c235e9a15fef23a6d9b629fa3a89e56197e`
- 提交内容：23 个文件，+1842 / −6，不含 `.env`、Token、私有图库、原始 Vision 缓存或临时下载图。

---

## 九、下一步（需要用户拍板）

1. **TMDB**：需要用户自己申请并写入 `.env`（不要发到聊天窗口）。配置后我才能验证电影剧照与动画单集画面。
2. **动画真画面**：只有三种合规路径——已确认的剧集剧照（依赖 TMDB）、开放授权动画、用户自有视频抽帧。是否要做其中一种？
3. **Met 403**：是否接受当前准入损耗，或改用更小的缩略图规格降低被拒率？
