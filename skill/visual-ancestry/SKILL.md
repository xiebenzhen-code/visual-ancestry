---
name: visual-ancestry
description: Search public-domain paintings, film stills and animation frames as visual references; read verifiable VisualIntent analysis for a work; and generate plus export a creation reference plan (prompt + Markdown). Use when the user asks for visual references, 视觉参考, 找画, film still lookup, compositional analysis of a specific artwork, or wants a shooting/painting reference brief. Also reports honestly when no Vision provider is configured.
---

# Visual Ancestry

A film-and-painting visual research tool. This skill exposes three capabilities
that run the **same code the web product runs** — it does not carry a second,
divergent search implementation.

## Prerequisites

- Node.js ≥ 20 (no npm install required — zero runtime dependencies)
- Repository root must be this skill's grandparent (`skill/visual-ancestry/scripts` → `../../..`)

## Commands

All commands live in `scripts/va.mjs`. Run them from anywhere:

```bash
node <repo>/skill/visual-ancestry/scripts/va.mjs <command> [options]
```

### 1. Search visual references

```bash
node va.mjs search "孤独 夜晚" --media all --limit 6
node va.mjs search "孤独 夜晚" --media film
node va.mjs search "Inception hallway" --external     # + live Wikimedia Commons lookup
node va.mjs search "孤独 夜晚" --json                  # machine-readable
```

- Searches paintings, film stills and animation frames through the shared
  retrieval pipeline (`src/services/retrieval/retrievalService.js`).
- `--external` adds a live Wikimedia Commons film-still search. It reuses the
  product's concept-splitting and rights adjudication; when Commons is
  unreachable the result carries `external.ok=false` with the error, and the
  local results stay valid.
- Empty results are reported as an empty list, never padded with invented works.

### 2. Read VisualIntent analysis

```bash
node va.mjs intent bahram-gur-karg
```

Returns the stored analysis with its `provenance` (where the record came from)
and the artwork's `rightsStatus` / `sourceUrl` so the user can verify it.

**If the work has no analysis record, `intent` is `null` and `note` says so.**
Never infer composition, lighting or colour for a work that has no record — a
fabricated field is worse than a missing one.

### 3. Generate and export a creation plan

```bash
node va.mjs plan --refs bahram-gur-karg,the-kiss --intent "安静 冷调 留白多" --out plan.md
node va.mjs plan --refs bahram-gur-karg --json
```

- Up to 4 references (the product's contract). Duplicates are removed.
- Uses the same `translatePrompt` + `buildPromptExport` + `promptExportToMarkdown`
  functions as the web UI, so the Markdown is structurally identical to what a
  user gets from the page.
- `missingAnalysis` lists references that contributed only source information.
  Say this out loud to the user rather than presenting the plan as fully derived.

### Vision status

```bash
node va.mjs vision-status --base http://127.0.0.1:5173
```

Reports whether a real Vision provider is reachable.

## Rules

1. **No provider → say Vision is unavailable.** Do not substitute local
   retrieval results, metadata, or any mock for actual image understanding.
2. **No fabricated analysis.** Missing fields stay missing.
3. **Rights travel with the reference.** Always surface `rightsStatus` when
   reporting a work; 5 works in the archive are still in copyright and carry
   no bundled image.
4. **Don't fork the retrieval.** If a search feels wrong, report it — do not
   write a new scoring or film-matching implementation inside the skill.
