// jobs.mjs — 按需补货的后台作业队列。
//
// 三条硬约束：
//   1. HTTP 请求只入队，不在请求里下载图片、不在请求里跑 Python。
//   2. 同一查询在窗口期内只跑一次（进程内去重 + 磁盘记录），任务串行执行。
//   3. 队列有上限、有时间窗，失败写原因，不无限重试。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { DATA_DIR, readWorks, appendRun } from "./store.mjs";
import { harvestQuery } from "./engine.mjs";

const JOBS_LOG = path.join(DATA_DIR, "jobs.ndjson");
const QUERY_CACHE = path.join(DATA_DIR, "query-cache.json");

const MAX_QUEUE = 6;
const QUERY_TTL_MS = 30 * 60 * 1000; // 同一查询 30 分钟内不重复抓
const JOB_TTL_MS = 60 * 60 * 1000;

const queue = [];
let running = null;
const jobs = new Map();

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 1), "utf8");
  fs.renameSync(tmp, file);
}

export function queryCache() {
  return readJson(QUERY_CACHE, {});
}

function markQuery(query, added) {
  const cache = queryCache();
  cache[query] = { at: Date.now(), added, works: readWorks().length };
  writeJson(QUERY_CACHE, cache);
}

function logJob(job) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(JOBS_LOG, JSON.stringify(job) + "\n", "utf8");
  } catch { /* 日志失败不影响任务 */ }
}

const publicView = (j) => ({
  id: j.id,
  status: j.status,
  query: j.query,
  reason: j.reason,
  added: j.added ?? null,
  error: j.error ?? null,
  queuedAt: j.queuedAt,
  startedAt: j.startedAt ?? null,
  finishedAt: j.finishedAt ?? null,
  queueDepth: queue.length,
  running: running ? running.id : null,
});

export function getJob(id) {
  const j = jobs.get(id);
  return j ? publicView(j) : null;
}

export function jobStats() {
  const done = [...jobs.values()].filter((j) => j.status === "done").length;
  const failed = [...jobs.values()].filter((j) => j.status === "failed").length;
  return { tracked: jobs.size, done, failed, queue: queue.length, running: running ? running.id : null };
}

function spawnIndex() {
  // 新图入库后必须建立向量，否则它进不了探索。放到后台跑，绝不占用请求线程。
  return new Promise((resolve) => {
    execFile(process.execPath, ["scripts/discovery/harvest.mjs", "index"], { cwd: process.cwd(), timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, detail: err ? String(stderr || err.message).slice(0, 200) : String(stdout).slice(-300) });
    });
  });
}

async function run(job) {
  job.status = "running";
  job.startedAt = Date.now();
  running = job;
  try {
    const res = await harvestQuery(job.query, { limit: job.limit, providers: job.providers });
    job.added = res.added;
    job.skippedKnown = res.skippedKnown || 0;
    if (res.added > 0) {
      job.index = await spawnIndex();
    }
    markQuery(job.query, res.added);
    job.status = "done";
  } catch (e) {
    job.status = "failed";
    job.error = String(e.message).slice(0, 160);
  } finally {
    job.finishedAt = Date.now();
    running = null;
    logJob(publicView(job));
    pump();
  }
}

function pump() {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  run(next);
}

/**
 * 入队。返回 { job, deduped }。
 * deduped=true 表示命中窗口期或已有同查询任务，不会重复抓取。
 */
export function enqueue(query, { limit = 24, providers = ["museums", "openverse", "commons"], reason = "thin-candidates" } = {}) {
  const q = String(query || "").trim().slice(0, 80);
  if (!q) return { job: null, deduped: false, reason: "empty-query" };

  const existing = queue.find((j) => j.query === q) || (running && running.query === q ? running : null);
  if (existing) return { job: publicView(existing), deduped: true };

  const cache = queryCache()[q];
  if (cache && Date.now() - cache.at < QUERY_TTL_MS) {
    const fake = { id: "cached", status: "cached", query: q, reason, added: 0, queuedAt: cache.at, queueDepth: queue.length, running: running?.id ?? null };
    return { job: fake, deduped: true };
  }

  if (queue.length >= MAX_QUEUE) return { job: null, deduped: false, reason: "queue-full" };

  const job = {
    id: crypto.randomBytes(8).toString("hex"),
    status: "queued",
    query: q,
    limit,
    providers,
    reason,
    queuedAt: Date.now(),
    added: null,
  };
  jobs.set(job.id, job);
  queue.push(job);
  // 清理过期任务记录
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.queuedAt > JOB_TTL_MS && j.status !== "running") jobs.delete(id);
  pump();
  return { job: publicView(job), deduped: false };
}

export function recentRuns(limit = 10) {
  const out = [];
  try {
    for (const line of fs.readFileSync(JOBS_LOG, "utf8").split("\n")) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line));
    }
  } catch { /* 没有日志就是没有 */ }
  return out.slice(-limit);
}
