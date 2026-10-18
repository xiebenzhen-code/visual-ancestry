# Visual Ancestry Core V1

Date: 2026-09-28 · **Status: FROZEN — Core V1 Freeze** · P3.2 PARTIAL PASS (45/49) / hypothesis validated / 4 rejected non-blocking

## Product Core

```
Image / Text
    → VisualIntent
    → Artwork VisualIntent Index (45/49 real vision intents + rule fallback)
    → Cross-museum Retrieval
```

The retrieval pipeline is unified: any query (text or image) is normalized into the same VisualIntent space, matched against the artwork VisualIntent index, and scored by field overlap. Museum adapters (AIC / Met / Cleveland / Rijksmuseum Data Services) remain the remote recall layer.

## Frozen Components

The following modules are verified present, wired, and stable — read-only verification performed at freeze time (2026-09-28 23:0x, zero provider calls, zero code modifications):

| # | Component | Path | Verified state |
|---|-----------|------|----------------|
| 1 | **VisualIntent schema** | `src/services/retrieval/visualIntent.js` | `emptyVisualIntent` with 20+ fields (emotion / atmosphere / subject / subjectScale / subjectPosition / spatialDepth / negativeSpace / light* / color* / saturation / contrast / humanRelation / camera* / motion / visualDensity / arousal / socialDistance / melancholy / source) + `mergeIntent`; single shared schema for text & image |
| 2 | **Vision bridge** | `scripts/server.mjs` (`POST /api/vision`) | Same-origin only; 6MB body cap (`VISION_BODY_LIMIT = 6*1024*1024`); mime whitelist; base64 alphabet+padding validation; honest errors: 400 missing-field / invalid-base64 / unsupported-format, 413 payload-too-large, 503 provider-not-configured, 502 provider failure |
| 3 | **Provider adapter** | `server/vision/openaiProvider.mjs` | `serverVisionConfig()` reads `VISION_API_BASE` / `VISION_API_KEY` / `VISION_MODEL` from server env only; `callVisionProvider()`; structured output `response_format: { type:"json_schema", json_schema:{ name:"visual_intent", strict:true } }`; default model gpt-5.6-sol |
| 4 | **Controlled JSON recovery** | `server/vision/openaiProvider.mjs` (`recoverDuplicatedJsonObject`, call site L207) | Runs only after `JSON.parse` fails, handles only `{...}{...}` duplicated-JSON-object defect (P2.6 classification A); merge `{...first, ...second}` conflicts→second wins; anything else preserves `invalid-json` flow |
| 5 | **Artwork VisualIntent cache** | `src/data/visual-intents/artworks.json` | `meta.coverage {pool:49, cached:45, pending:0, rejected:4, complete:false}`; 45 intents verbatim (admission = HTTP 200 + schemaValid + unknownEnums=0); ships in dist under `src/data/visual-intents/` |
| 6 | **Cache → rule fallback** | `src/services/retrieval/retrievalService.js` | `intentOf(artwork, "auto")`: cached vision intent first, `intentFromArtwork()` rule derivation fallback (L26–32); `intentSource: "auto"|"rule"` evaluation probe; artworks absent/rejected keep working |
| 7 | **Retrieval scoring** | `src/services/retrieval/scoring.js` | `WEIGHTS` incl. `subject: 1.5` (P3.1) and `melancholy: 2`; `scoreIntent` field-overlap; `melancholy=low` query penalizes 悲伤/忧郁 candidates (negation rule) |
| 8 | **Production secret boundary** | dist + `qa/prod-audit.json` | layer1Ok=true, layer2Ok=true, directThirdPartyPath=false, browserProvider.holdsSecrets=false, callsSameOriginVision=true; live dist scan 0 hits for VISION_API_KEY / Authorization / Bearer / apiKey; `server/` never enters dist |
| 9 | **Calibration harness** | `qa/vision-calibration.mjs` + `qa/vision-calibration-results.json` | Real-chain harness (serial, append, per-image latest), model gpt-5.6-sol, 63 raw records → per-image latest 45/49 OK / 4 rejected (502 invalid-json) |
| 10 | **Retrieval evaluation harness** | `qa/retrieval-quality/run-evaluation{-v2,-v3}.mjs` | V1/V2/V3 compare baseline rule vs vision-candidate retrieval; reads live cache coverage, marks COMPLETE/PENDING; zero provider calls; results `evaluation-results{-v2,-v3}.json` |

## Validation Evidence

| Metric | Value | Source |
|--------|-------|--------|
| Vision calibration baseline | **10/10** (P2.8, real gpt-5.6-sol, HTTP 200 + schemaValid + unknownEnums=0) | `qa/vision-calibration-results.json` |
| Intent richness (text → vision query) | **3.6 → 20.9** fields avg (5.8×) | P3 evaluation |
| Self retrieval (P3 → P3.1) | **6/10 → 10/10** rank 1 | P3.1 evaluation v2 (V2b) |
| Artwork VisualIntent coverage | **45/49** cached, 4 rejected, 0 pending | cache `meta.coverage` |
| Vision-candidate entries in top-8 | **69/80 → 80/80** (rule-candidate 0/80) | P3.2 evaluation v3 |
| Retrieval avg score | **20.9 → 25.5** | P3.2 evaluation v3 |
| Production audit | **PASS** — layer1/layer2 CLEAN, no direct third-party path, no secrets in browser | `qa/prod-audit.json` + build leak scan (60 files, 0 forbidden tokens) |

Also verified at freeze: production build exit 0; canonical text probes 4/4 (negation rule intact, 「夜晚冷色调」top-1 = starry); UI & core mtimes all pre-P3.2 (index.html 09-23, src/pages+components ≤09-23, retrievalService/scoring at P3.1 moment, openaiProvider 09-27, server.mjs 09-24).

## Known Non-blocking Issues

1. **4 artwork provider failures** (real `502 invalid-json`, not retried per discipline, no fabrication):
   - `dance-class`
   - `hunters-snow`
   - `bar-folies`
   - `court-of-gayumars`
2. **Provider latency variance** — 8–72s per call observed; serial calibration ~20 min for 49 works.
3. **Atmosphere "寂静" over-inference** — several calibrated intents lean 寂静 (mild over-inference, recorded in P2.8, unchanged).
4. **4 rejected artworks currently use rule fallback** (`intentFromArtwork`) — non-blocking for retrieval (fallback path validated since P3); coverage remains 45/49, `complete:false`.

## Freeze Rule

Except for **blocker / regression / security issues**, the following are **frozen — no further modification**:

- Vision schema (`src/services/retrieval/visualIntent.js`)
- Vision prompt (structured-output contract in `server/vision/openaiProvider.mjs`)
- Provider architecture (`/api/vision` same-origin bridge, server-side adapter, browser thin client)
- Recovery strategy (P2.7 controlled JSON recovery)
- Retrieval core (`retrievalService.js` cache/fallback + intent routing)
- Scoring weights (`scoring.js` WEIGHTS)

Allowed to change: data (cache rebuild from authorized calibration), report/docs, QA harnesses, bug fixes that are blocker/regression/security. The 4 rejected artworks may be retried **only with explicit user authorization**; a successful retry of all 4 would move coverage to 49/49 (`complete:true`) without touching any frozen component — simply rebuild the cache and rerun evaluation-v3.
