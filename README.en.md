# Scorecard

[![license](https://img.shields.io/github/license/webkubor/scorecard.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/webkubor/scorecard.svg)](https://github.com/webkubor/scorecard/stargazers)
[![online status](https://img.shields.io/website-up-down-green-red/https/scorecard.webkubor.online.svg)](https://scorecard.webkubor.online)
[![issues](https://img.shields.io/github/issues/webkubor/scorecard.svg)](https://github.com/webkubor/scorecard/issues)

> Paste a **GitHub URL / npm package name / webpage URL**, get a per-target-type quality report in seconds: radar chart, an action list sorted by `impact ÷ cost`, and a Markdown report you can hand straight to an AI. **Compare two targets** (test env ↔ prod env, you ↔ a competitor) to see exactly where they diverge. No login, public repos no token needed.

**Live**: <https://scorecard.webkubor.online>

[中文](./README.md)

<p align="center">
  <img src="https://scorecard.webkubor.online/og/scorecard/webkubor/typora-Bloom-theme"
       alt="Scorecard report example" width="640">
</p>

## What it answers

*"Where is my project actually weak?"* — repo, package, or site.

Star count tells you the outcome, not the cause. Scorecard splits quality into **three independent engines** with their own criteria (no merging — folding npm "weekly downloads" into GitHub "star growth" systematically mis-scores both):

| Input | Engine | Dims | Mostly checks |
|---|---|---:|---|
| GitHub repo | `server/audit.js` | 9 | description / topics / CI / issue response / llms.txt |
| npm package | `server/audit-npm.js` | 7 | registry metadata + weekly/monthly downloads + docs + security + AI readability |
| Any webpage | `server/audit-page.js` | 9 | includes **AI identification** (llms.txt / schema.org), **crawler root** (robots / sitemap / .well-known / favicon), **WebMCP friendliness** (mcp.json / ai-plugin / openapi) |

The output isn't just a score — it's an **actionable list**. Every item comes with evidence and a "+X points if you fix this" estimate, plus a one-click copy as a fix-it prompt you can hand to an AI.

## Compare mode

Run two targets side-by-side, get a dimension diff + unique-gap lists — the main use case is **test env vs production**:

- 9 dim-by-dim Δ, A-only and B-only gaps split out
- The report includes a built-in "bring A up to B" prompt for the AI
- Share URL: `https://scorecard.webkubor.online/?share=<A>&compare=<B>&type=page` — paste straight into IM

## Quick start

```bash
bun install          # or npm install
bun run build        # build the front-end to dist/
bun run server       # start the backend (default :54445), serves dist/ automatically
```

Open <http://127.0.0.1:54445>. Dev mode needs both ends running:

```bash
bun run server &     # backend :54445
bun run dev          # front-end :54446, /api proxied to backend
```

### Optional read-only token (recommended)

Without one, requests go through GitHub anonymous API (60/hour/IP); with one, the limit jumps to 5000/hour, and PR / Issues activity dimensions unlock — **without it those dimensions get no data and the score drops** (measured 6.4 vs 6.8 on the same repo).

```bash
export SCORECARD_GITHUB_TOKEN=ghp_xxx   # public_repo read-only is enough
bun run server
```

The token is server-side only and never sent to the front-end.

## CLI

```bash
# Three engines (type inferred: URL → page, pkg name → npm, owner/repo → github)
scorecard webkubor/scorecard                    # GitHub repo (9 dims)
scorecard react --type npm                      # npm package (7 dims)
scorecard https://example.com --type page       # webpage (9 dims)

# Side-by-side compare of two same-type targets
scorecard --compare-a https://test.example.com \
          --compare-b https://example.com \
          --type page

# Markdown report (hand straight to an AI)
scorecard webkubor/scorecard --md > report.md

# CI gate: fail if score below threshold
scorecard react --type npm --min 6

# Skip the 30-minute cache
scorecard webkubor/scorecard --fresh
```

The CLI just shells out to the HTTP API — agents pick this up as their default path.

## GitHub dims: skill as a deeper complement

The GitHub-repo path also ships a Claude skill version (deeper diagnosis), complementary to the engine rather than redundant:

| | Web engine (`server/audit.js`) | Claude skill (`skills/project-maturity-audit/`) |
|---|---|---|
| Strengths | **Breadth + trend**: scan many repos at once, schedule it, see "62 last time, 78 this time" | **Depth + fix-it**: read the README, judge whether the first screen explains it, deliver a sorted fix-it list |
| Criteria | Objective only — what the API returns, what files exist, what status codes you get | Subjective — "can you understand it in 10 seconds", "does the logo palette match the brand", "where does it fall short of category leaders" |
| Boundary | Each dimension's `manual` field marks "these need the skill" | Every conclusion must be backed by command output / file content / status code |

The engine has no LLM and can't judge subjective items; the skill has no concurrency or history DB and can't scan a batch of repos or draw trends. Neither replaces the other.

GitHub engine is authoritative: change dims in three places — `server/audit.js`,
`scripts/check-dimensions.mjs`, `skills/project-maturity-audit/SKILL.md` — then run
`bun run check:dimensions`.

```bash
bun run check:dimensions   # fails if dimension names don't match
```

## Deployment

A single `bun` process + sqlite, fits a 2-core small box:

```ini
# /etc/systemd/system/scorecard.service
[Service]
Environment=SCORECARD_HOST=127.0.0.1        # local only; tunnel for public access
Environment=SCORECARD_PORT=54445
Environment=SCORECARD_GITHUB_TOKEN=<read-only token, never commit>
WorkingDirectory=/opt/scorecard
ExecStart=/root/.bun/bin/bun server/index.js
Restart=always
```

Front it with a Cloudflare Tunnel pointing at `127.0.0.1:54445` — no public port needed.

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `SCORECARD_PORT` / `PORT` | 54445 | Backend port |
| `SCORECARD_HOST` / `HOST` | 0.0.0.0 | Bind address (production: prefer 127.0.0.1) |
| `SCORECARD_GITHUB_TOKEN` | – | Read-only token; raises API limit, unlocks PR/Issues dimensions |
| `SCORECARD_DATA_DIR` | ./data | sqlite data dir |
| `SCORECARD_BRAND` | SCORECARD | Brand text on OG image |
| `SCORECARD_SITE_URL` | scorecard.webkubor.online | Site URL on OG image CTA |

## API

All endpoints are no-login (except GitHub dims, which can take a token for rate limit):

| Endpoint | Notes |
|---|---|
| `GET /api/scorecard?repo=owner/name` | GitHub repo, 9 dims (30-min cache per target) |
| `GET /api/scorecard?type=npm&pkg=react` | npm package, 7 dims |
| `GET /api/scorecard?type=page&url=https://...` | Any webpage, 9 dims |
| `GET /api/scorecard/report.md?type=...&...` | Same report as Markdown, written for an AI assistant |
| `GET /api/scorecard/compare?type=...&a=X&b=Y` | Two-target compare: both reports + per-dim diff |
| `GET /api/scorecard/compare.md?type=...&a=X&b=Y` | Compare report as Markdown |
| `GET /api/scorecard/stats` | Cumulative query count and average score |
| `GET /api/scorecard/trending` | Top 10 hot repos in the last 24h |
| `GET /api/scorecard/leaderboard?limit=20` | Leaderboard: latest audit per project, sorted by score |
| `GET /og/scorecard/:owner/:repo` | 1200×630 OG share image (SVG) |
| `GET /api/health` | Health check |

Any endpoint accepts `fresh=1` to bypass the 30-minute cache and force a fresh audit.

## Tech stack

Vue 3 (no router lib — hand-rolled hash routing) + Vite + Hono + `bun:sqlite`.

Production is a single `bun` process, ~80 MB RAM. Zero external front-end dependencies — reports are delivered as Markdown generated by `reportMarkdown()` on the server side, so the front-end doesn't need html2canvas or any screenshot library.

## Origin

This project originally lived as a page inside `github-accounts-manager` (a multi-account and token management console). Two products in one repo meant the public-facing facade carried the "account management" name and tags, while private token-management code sat in the public repo. 2026-08-20: split — Scorecard went public standalone, the account manager went back to a private repo.

## License

MIT