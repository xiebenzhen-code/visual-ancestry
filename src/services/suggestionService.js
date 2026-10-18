// suggestionService.js — "Try: …" chips when a query has no exact match.
// Works entirely against the internal alias ledger (the alias tables drive
// search matching; they never render as a dictionary UI themselves).
import { aliases } from "../data/aliases.js";

function norm(str) {
  return String(str || "").toLowerCase().trim();
}

// small Levenshtein for typo-tolerant suggestion
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}

export function suggestForQuery(query) {
  const q = norm(query);
  if (!q) return [];
  const candidates = [];

  for (const entry of aliases) {
    const scored = [
      ...entry.aliases,
      ...(entry.related || []),
    ].map((alias) => {
      const a = norm(alias);
      if (!a) return null;
      const contains = a.includes(q) || q.includes(a);
      const distance = editDistance(q, a);
      // prefix match is the strongest signal for Chinese/English alike
      const prefix = a.startsWith(q) || q.startsWith(a);
      let score = 0;
      if (prefix) score += 3;
      if (contains) score += 2.5;
      score += Math.max(0, 2 - distance * 0.5);
      if (score < 1.2) return null;
      return { primary: entry.primary, alias: a, score };
    }).filter(Boolean);

    if (scored.length) {
      const best = scored.sort((x, y) => y.score - x.score)[0];
      candidates.push(best);
    }
  }

  return candidates
    .sort((x, y) => y.score - x.score)
    .slice(0, 4)
    .map((c) => c.primary);
}

// Always-available suggestions when the query matches nothing at all,
// so the user is never left with a dead "no results" line.
const FALLBACK_SUGGESTIONS = ["孤独", "夜晚", "水墨", "浮世绘"];

export function suggestForQueryWithFallback(query) {
  const tips = suggestForQuery(query);
  return tips.length ? tips : FALLBACK_SUGGESTIONS;
}