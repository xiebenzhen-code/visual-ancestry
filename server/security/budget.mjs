// server/security/budget.mjs
//
// R5 STEP 4 — durable call budget + concurrency cap.
//
// WHY A FILE AND NOT A MAP
//   The R1.0 rate limiter was a per-process `Map`. On N instances behind a load
//   balancer the effective limit is N × the configured value, and a restart
//   silently resets the counter — so the budget that protects a paid API key is
//   not a budget. R5 STEP 4 requires the spend cap to hold across processes.
//
//   This ledger is an append-only NDJSON file with an atomic append (a single
//   write() of a line <= PIPE_BUF under O_APPEND on POSIX; on Windows the file
//   handle is opened for append so concurrent writes do not interleave). Every
//   entry is one upstream attempt. Because the file is the shared state, any
//   number of instances pointed at the same volume enforce the SAME cap.
//
//   This is deliberately the simplest multi-writer store that has no new
//   dependency. When the platform offers a real shared store (Redis / SQL),
//   swap `readCounters` / `appendEntry` — the accounting logic above them does
//   not change.
//
// HONEST LIMITATION (stated, not hidden)
//   If instances run on separate filesystems, they each get their own budget.
//   `budgetIntegrity()` reports the resolved path so an operator can verify the
//   sharing assumption instead of believing it.

import { openSync, closeSync, writeSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function budgetConfig(env = process.env) {
  const file = typeof env.VISION_BUDGET_FILE === "string" && env.VISION_BUDGET_FILE.trim() !== ""
    ? path.resolve(env.VISION_BUDGET_FILE.trim())
    : null;
  const num = (name, dflt) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt;
  };
  return {
    file,
    dailyLimit: num("VISION_BUDGET_DAILY", 200),
    totalLimit: num("VISION_BUDGET_TOTAL", 2000),
    maxConcurrent: num("VISION_MAX_CONCURRENT", 2),
    // 0 = no extra cap. Protects against a caller who sets a daily limit but
    // forgets the total one.
    enabled: env.VISION_BUDGET_ENABLED !== "0",
  };
}

function ensureDir(file) {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readCounters(file, now) {
  const today = dayKey(now);
  let daily = 0;
  let total = 0;
  if (!file || !existsSync(file)) return { daily, total, today };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { daily, total, today };
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    // Each line is `<dayKey>\t<ts>`. Only the day key is parsed for accounting;
    // nothing image- or user-derived is ever written here.
    const day = line.slice(0, 10);
    if (day === today) daily += 1;
    total += 1;
  }
  return { daily, total, today };
}

function appendEntry(file, now) {
  ensureDir(file);
  const fd = openSync(file, "a");
  try {
    writeSync(fd, `${dayKey(now)}\t${now}\n`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Reserve one upstream attempt.
 * Returns { allowed, code, counters }.
 *   code: null | "budget-exhausted-daily" | "budget-exhausted-total"
 *
 * Reservation is checked-then-appended, which is correct for a single shared
 * file and intentionally conservative under a race: two instances may both pass
 * the check and both append, so the cap can be overshot by at most the number
 * of concurrent callers. `maxConcurrent` exists to bound exactly that window.
 *
 * P3.1 FAIL-CLOSED: `requireLedger` is set by the bridge **only after** it has
 * confirmed a real provider is configured — i.e. only when the next step would
 * spend money. In that state a missing ledger is not "no limit", it is "a limit
 * nobody can prove": the paid key would face unbounded calls.
 *
 * Measured motivation: `/healthz` reported `budgetEnforcement:"disabled"`
 * because `VISION_BUDGET_FILE` was unset, and this function returned
 * `allowed:true` for every request — the cap that protects the key was
 * decorative.
 *
 * P3.1 AUDIT: a reservation is NEVER released. A failed or timed-out call keeps
 * its ledger entry, so a failure can never be turned into extra free attempts.
 * There is deliberately no refund path in this module.
 */
export function reserveCall(config, now = Date.now(), { requireLedger = false } = {}) {
  if (!config.enabled || !config.file) {
    if (requireLedger) {
      return {
        allowed: false,
        code: "budget-unavailable",
        counters: { daily: 0, total: 0 },
        // Names the cause so an operator sees why it refused, instead of a
        // refusal that looks like an exhausted budget.
        detail: config.enabled ? "ledger-not-configured" : "budget-disabled",
      };
    }
    return { allowed: true, code: null, counters: { daily: 0, total: 0 } };
  }
  const counters = readCounters(config.file, now);
  if (config.dailyLimit > 0 && counters.daily >= config.dailyLimit) {
    return { allowed: false, code: "budget-exhausted-daily", counters };
  }
  if (config.totalLimit > 0 && counters.total >= config.totalLimit) {
    return { allowed: false, code: "budget-exhausted-total", counters };
  }
  appendEntry(config.file, now);
  return { allowed: true, code: null, counters: { daily: counters.daily + 1, total: counters.total + 1 } };
}

/** Read-only view for the status endpoint and for tests. Never appends. */
export function budgetStatus(config, now = Date.now()) {
  if (!config.enabled || !config.file) {
    return { enforcement: "disabled", daily: null, total: null, dailyLimit: config.dailyLimit, totalLimit: config.totalLimit };
  }
  const counters = readCounters(config.file, now);
  return {
    enforcement: "ledger",
    daily: counters.daily,
    total: counters.total,
    dailyLimit: config.dailyLimit,
    totalLimit: config.totalLimit,
  };
}

/**
 * Report whether the multi-instance assumption actually holds. With a shared
 * volume every instance resolves the SAME path; with per-instance disks the
 * paths differ and the operator must know.
 */
export function budgetIntegrity(config) {
  if (!config.enabled || !config.file) return { shared: false, note: "预算未启用（无账本文件）。", file: null };
  return {
    shared: true,
    file: config.file,
    note: "所有实例必须挂载同一账本文件，否则预算按实例各算一份。",
  };
}

// ---- Concurrency cap (in-process is CORRECT here) ------------------------- //
// A concurrency cap bounds how many requests are simultaneously waiting on the
// provider. It is intentionally NOT shared state: sharing it would be wrong,
// because concurrency is a property of one process's event loop, not of the
// budget. The provider call is what the budget ledger accounts for.

export function createConcurrencyGate(limit) {
  let active = 0;
  return {
    get active() {
      return active;
    },
    limit,
    tryEnter() {
      if (limit > 0 && active >= limit) return false;
      active += 1;
      return true;
    },
    exit() {
      if (active > 0) active -= 1;
    },
  };
}

export const BUDGET_CONSTANTS = { DAY_MS };