// blenderFrames.mjs — 从 Blender 开放影片里抽真实剧情帧。
//
// 为什么可信：这些影片由 Blender Foundation 以 CC BY 3.0/4.0 发布，官方下载站提供原片；
// 我们下载一次、用 ffmpeg 在固定时间点抽帧，保留影片名、时间戳、许可与来源链接。
//
// 纪律：
//   · 抽帧是**离线构建步骤**，绝不作为用户浏览时的实时任务
//   · 只抽画面帧，不抽片头 logo / 片尾字幕（时间点避开首尾）
//   · 每帧记录 timestamp，便于追溯"这不是封面而是第 N 秒的画面"
//   · 视频文件与抽帧结果都在 .rc1-audit/（不进 Git）

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = process.cwd();
export const MOVIE_DIR = path.join(ROOT, ".rc1-audit/discovery/movies");

/** 已核实的开放影片清单。许可与来源都在这里写死并带出处，改动需同时改报告。 */
export const OPEN_MOVIES = [
  {
    id: "tears-of-steel",
    title: "Tears of Steel",
    creator: "Blender Foundation / Ton Roosendaal",
    year: "2012",
    license: "CC BY 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
    sourceUrl: "https://mango.blender.org/",
    downloadUrl: "https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov",
    localFile: "tears_of_steel_720p.mov",
    medium: "film",
    imageKind: "film-still",
    // 避开 0-20s 片头与最后 40s 字幕：取正片中段
    timestamps: [95, 140, 185, 230, 275, 320, 365, 410, 455, 500],
  },
  {
    id: "big-buck-bunny",
    title: "Big Buck Bunny",
    creator: "Blender Foundation / Sacha Goedegebure",
    year: "2008",
    license: "CC BY 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
    sourceUrl: "https://peach.blender.org/",
    downloadUrl: "https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_640x360.m4v.zip",
    localFile: "bbb/BigBuckBunny_640x360.m4v",
    medium: "animation",
    imageKind: "animation-frame",
    timestamps: [30, 60, 95, 130, 165, 200, 235, 270, 305, 340],
  },
];

function fileOf(movie) {
  const candidates = [
    path.join(MOVIE_DIR, movie.localFile),
    path.join(MOVIE_DIR, movie.localFile.replace(/\.m4v$/, ".mp4")),
    path.join(MOVIE_DIR, movie.localFile.replace(/\.m4v$/, ".mov")),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export function movieStatus() {
  return OPEN_MOVIES.map((m) => {
    const f = fileOf(m);
    return {
      id: m.id,
      title: m.title,
      license: m.license,
      file: f ? path.relative(ROOT, f) : null,
      sizeMb: f ? Math.round(fs.statSync(f).size / 1048576) : 0,
    };
  });
}

/**
 * 抽帧。返回 [{ id, movieId, ts, file, width, height }]。
 * 已存在的帧直接复用（幂等），重复运行不会重新解码整部片子。
 */
export async function extractFrames({ force = false } = {}) {
  fs.mkdirSync(path.join(MOVIE_DIR, "frames"), { recursive: true });
  const out = [];
  for (const movie of OPEN_MOVIES) {
    const src = fileOf(movie);
    if (!src) { out.push({ movieId: movie.id, error: "video-missing" }); continue; }
    for (const ts of movie.timestamps) {
      const file = path.join(MOVIE_DIR, "frames", `${movie.id}_${String(ts).padStart(4, "0")}.jpg`);
      if (force || !fs.existsSync(file)) {
        try {
          await run("ffmpeg", [
            "-hide_banner", "-loglevel", "error", "-ss", String(ts), "-i", src,
            "-frames:v", "1", "-q:v", "3", "-y", file,
          ], { timeout: 120000 });
        } catch (e) {
          out.push({ movieId: movie.id, ts, error: String(e.stderr || e.message).slice(0, 120) });
          continue;
        }
      }
      if (!fs.existsSync(file) || fs.statSync(file).size < 8000) {
        out.push({ movieId: movie.id, ts, error: "frame-empty" });
        continue;
      }
      out.push({ movieId: movie.id, ts, file, movie });
    }
  }
  return out;
}

/** 抽出的帧 → 统一记录（交给 engine 做校验、去重、入库）。 */
export async function blenderRecords({ force = false } = {}) {
  const frames = await extractFrames({ force });
  const { normalize } = await import("../normalize.mjs");
  const records = [];
  for (const f of frames) {
    if (f.error) continue;
    const rel = path.relative(ROOT, f.file).replace(/\\/g, "/");
    records.push(normalize({
      providerId: `${f.movie.id}-t${f.ts}`,
      title: `${f.movie.title} — ${f.ts}s`,
      creator: f.movie.creator,
      year: f.movie.year,
      medium: f.movie.medium,
      imageKind: f.movie.imageKind,
      // 已抽到本地：imageUrl 用本地文件路径的 file: 伪协议会让校验层拒绝，
      // 所以这里直接把文件先登记为"已校验"，由调用方写入 storedImage。
      imageUrl: rel,
      thumbnailUrl: rel,
      sourceUrl: f.movie.sourceUrl,
      rightsStatus: f.movie.license,
      license: f.movie.license,
      width: null,
      height: null,
      origin: `blender:${f.movie.id}`,
      localFile: rel,
      extra: { movie: f.movie.title, timestamp: f.ts, licenseUrl: f.movie.licenseUrl, downloadUrl: f.movie.downloadUrl },
    }, { provider: "blender", query: f.movie.title }));
    records[records.length - 1].timestamp = f.ts;
    records[records.length - 1].localFile = rel;
  }
  return records;
}
