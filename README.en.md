# Visual Ancestry · Visual reference & creation toolkit

> Find paintings with a filmmaker's eye; write shots with a painter's structure.

Visual Ancestry connects art archives with open museum collections, helping creators find paintings and film stills by describing the shot they have in mind — then turn those references into a creation prompt and a shooting plan.

**Find references → read the visual relationships → generate a prompt → keep what inspired you**

[中文](./README.md) · [Architecture & data flow](./docs/ARCHITECTURE.md) · [Acceptance report](./docs/ACCEPTANCE-REPORT.md) · [Demo script](./docs/DEMO-SCRIPT.md) · [Agent Skill](./skill/visual-ancestry/SKILL.md)

![Home, "album" scheme: 15 works in the first screen at 1440×900, images occupy 73% of it](./docs/media/album-1-home.png)

<p align="center">
  <img src="./docs/media/album-2-search-results.png" width="49%" alt="Search results with scores and match reasons">
  <img src="./docs/media/album-4-create-picks.png" width="49%" alt="CREATE reference picker: the carried-over reference sits first and selected">
</p>

<p align="center">
  <img src="./docs/media/album-1-home-mobile.png" width="32%" alt="390px, two columns">
</p>

---

## What it helps you do

- **FIND · find references** — describe the frame you want ("cold night", "fog, vast empty space", "one figure, far away") or type a film title. Results come back with scores, reasons, source and licence.
- **CREATE · write the prompt** — pick 2–4 references, generate a structured prompt, export Markdown or JSON. Only fields that genuinely exist are written.
- **SHOOT · set the shot** — turn the visual principles in your references (composition, light, colour, space) into shooting guidance you can act on.
- **MEMORY · keep the spark** — save the frames that matter into a personal visual archive you can export, move between machines, or clear. The data stays in your own browser.

## Where the references come from

- **Local archive** — public-domain paintings and film imagery, each one carrying its institution, its Commons file page and its licence.
- **Open museum collections** — Art Institute of Chicago, The Met, Cleveland Museum of Art and Rijksmuseum, via their public keyless APIs.
- **Wikimedia Commons** — film-still discovery, with identity verification and licence checks; anything that can't be verified is left blank rather than guessed.

Results distinguish **visually relevant matches** from **text-metadata matches**: a work whose title happens to contain your keyword is never presented as "this is the shot you described".

Known limit: the first connection to the Met API can take about 10 seconds and the adapter does not retry. That channel says so plainly when it fails; the other sources are unaffected.

### Not available right now

- **Vision image analysis is not connected** — no vision model is configured, so image upload and image search are genuinely unavailable (the server returns 503 and the UI says so). Nothing is faked.
- **Animation retrieval is not finished** — the archive holds no animation assets, so choosing that medium gives an honest empty state.

### What this release is

This is a **GitHub source release**. There is **no hosted web app** in this repository; run it locally as described below.

---

## Technical notes

The following is for people who want to read or change the code.
  unavailable; it never pretends to have worked.**

## Requirements

| Item | Requirement |
|---|---|
| Node.js | **≥ 20** (built-in `fetch`, `node:crypto`) |
| Runtime dependencies | **None.** Node built-ins only — no `npm install` needed |
| Optional dependency | `sharp` — only for `npm run build` |

## Run it (Windows PowerShell)

```powershell
# 1. Enter the directory
cd <unpacked-directory>

# 2. Start (serves the source tree — no build step required)
$env:PORT = 5173
npm start
```

Or without npm:

```powershell
node scripts/server.mjs . 5173
```

Then open <http://127.0.0.1:5173>.

> The server's default static root is `dist/` (build output). `node scripts/server.mjs .`
> is an **explicit** choice to serve the source tree — the project directory holds
> `.env`, and a wrong default root is exactly how `GET /.env` leaked historically.
> An allow-list guard refuses both.

## Configure Vision (optional)

Everything works without it — retrieval, analysis, CREATE, SHOOT, MEMORY. Only
"upload an image / search by image" is unavailable.

```powershell
Copy-Item .env.example .env
$env:VISION_API_BASE = "https://.../v1/chat/completions"
$env:VISION_API_KEY = "..."
node scripts/server.mjs . 5173
```

Fail-closed default: if a provider is configured but **no budget ledger is set, the
server refuses to call it**. A forgotten budget never silently opens a paid key.
Full variable reference: [`.env.example`](./.env.example).

## Agent Skill

```bash
node skill/visual-ancestry/scripts/va.mjs search "lonely night" --limit 5
node skill/visual-ancestry/scripts/va.mjs intent bahram-gur-karg
node skill/visual-ancestry/scripts/va.mjs plan --refs bahram-gur-karg,the-kiss --out plan.md
node skill/visual-ancestry/scripts/va.mjs vision-status
```

The skill **imports the same retrieval and analysis modules the web app runs** — it
does not carry a second, divergent film-search implementation. With no Vision
provider it reports unavailability rather than passing local retrieval off as
image understanding. See [`skill/visual-ancestry/SKILL.md`](./skill/visual-ancestry/SKILL.md).

## Layout

| Path | Contents |
|---|---|
| `index.html` | Entry; default skin is the "album" scheme |
| `src/pages/` | Route-level pages: `find` / `create` / `shoot` / `memory` |
| `src/services/retrieval/` | Retrieval and scoring (shared with the skill) |
| `src/services/source/` | External sources: Commons discovery, film concept splitting, rights adjudication |
| `src/services/vision/` | Vision analysis contract and normalisation |
| `src/data/` | Archive data (artworks, film stills, VisualIntent records) |
| `server/security/` | Access control, budget ledger, static path guard |
| `scripts/server.mjs` | Static server + Vision API |
| `public/assets/` | Local images (thumb / preview / detail tiers) |
| `qa/` | Runnable acceptance harnesses (no browser profiles or screenshot evidence) |
| `docs/` | Architecture notes and stage reports |

## Status (technical view)

**Implemented and verified for real**

- Local archive retrieval (51 paintings + 15 film images) with scores and reasons; Chinese and English
  descriptions are first parsed into a structured VisualIntent, then scored
- Open museum retrieval: AIC / Met / Cleveland / Rijksmuseum keyless APIs (Met uses the v1.1 search;
  the old v1 endpoint was retired upstream)
- Wikimedia Commons film discovery with multi-concept splitting, identity verification and licence checks
- 45 VisualIntent records, returned with provenance and source links
- CREATE: pick references → generate prompt → copy / export Markdown / JSON
- TaskContext carry-over between pages, SHOOT guidance, memory export and re-import
- Static path guard and budget fail-closed

Capabilities that are *not* available are listed under "Not available right now" above. Also:
**no accounts, no cloud persistence, no native mobile shell** — memory data lives only in your own browser.

**Agent Skill boundaries**

- Local, no external service needed: `search`, `intent` (reads the 45 VisualIntent records), `plan`
- Depends on external services: `vision-status` needs the server-side `/api/vision` (reports
  unavailability honestly when unconfigured); `--external` retrieval needs Wikimedia Commons (roughly 9–20s)

## Asset licensing

Code is MIT. Image assets are licensed **per item**; the per-item licences, source file
pages and verification method are documented in
[`LICENSE-ASSETS.md`](./LICENSE-ASSETS.md):

- 46 bundled paintings: **44 Public domain + 2 CC0** (public-domain dedication), each
  verified live against its Wikimedia Commons file page (verification date 2026-10-18)
- 15 film images: all Public domain (verified via Commons file pages); 5 of them are
  promotional images and 10 are film frames / screenshots / stills, labelled per item
- 5 further paintings ship without images (catalogue records only) and involve no
  redistribution
- The licence verification scripts and evidence JSON ship with the repo
  (`qa/licence-audit/`) and can be reproduced from a fresh clone

### Commercial use

| Content | Licence | Commercial use |
|---|---|---|
| Source code | MIT | **Yes** (keep the copyright and licence notice) |
| Bundled images (183 webp files) | Public domain / CC0 | **Yes**, no copyright restriction |
| Live retrieval results (records and images fetched at runtime) | **Not covered by this repo's licence** — provided by each source under its own terms | Depends on the source's terms; this repo neither re-hosts nor mirrors them |
| Generated prompts / shooting plans | Ship with the MIT code | **Yes**, but they are creative reference, not legal advice |

Full wording in [`LICENSE-ASSETS.md` §6](./LICENSE-ASSETS.md). One caveat worth stating plainly:
**MIT does not cover artwork copyright** — the code may be used commercially, but that does not make
museum collections commercially reusable.

## Minimal real acceptance

```powershell
npm start
# open http://127.0.0.1:5173
#   1. Search "lonely night" → hits with reasons
#   2. Open a work → side panel with "use as reference"
#   3. Go to CREATE (#create) → that reference should be first and selected
#   4. Select 2 → generate prompt → export Markdown
# 5. Skill (second terminal)
node skill/visual-ancestry/scripts/va.mjs search "lonely night" --limit 3
node skill/visual-ancestry/scripts/va.mjs plan --refs bahram-gur-karg --out plan.md
```

Harnesses (require local Edge): `node qa/ui/ui-final-acceptance.mjs`,
`node qa/find/edge-cdp-e2e.mjs`, `node qa/ui/round3-check.mjs`.

Licence verification reproduction (keyless, read-only Commons public API):

```bash
node qa/licence-audit/rc1-artwork-licence-audit.mjs   # per-item check of 46 paintings
node qa/licence-audit/rc1-film-licence-audit.mjs      # per-item check of 15 film images
```

## Data & privacy

- Visual memory lives in browser localStorage; export and clear are one click.
- Vision credentials exist only in the server process environment; the build output
  contains no `VISION_*` values.
