# PrizePicks Bot

Pure Pinnacle-divergence engine for NBA PrizePicks player prop analysis. Compares PrizePicks lines against Pinnacle (the sharpest sportsbook) and flags the biggest mispricings. Covers.com expert picks are used as annotations only — not for scoring.

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/your-username/prizepicks-bot.git
cd prizepicks-bot
npm install

# 2. Set up Python environment (needed for NBA player stats via nba_api)
python3 -m venv .venv
source .venv/bin/activate
pip install nba_api pandas

# 3. Configure environment variables
cp .env.example .env
# Edit .env and add your API key (see API Keys section below)

# 4. Run the daily pipeline
npx tsx scripts/daily-pipeline.ts
```

## API Keys

Only one API key is required:

| Key | Source | Cost | Used for |
|-----|--------|------|----------|
| `THE_ODDS_API_KEY` | [the-odds-api.com](https://the-odds-api.com) | Free tier (~500 req/month) | Pinnacle player prop lines |

The free tier is sufficient for daily use (~5–10 requests per report run).

`ODDS_API_KEY` (odds-api.io) is an optional fallback source and can be left blank.

## Python Dependency

The NBA stats module calls `nba_api` via a Python subprocess bridge. You need Python 3 installed, then create a virtual environment in the project root:

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install nba_api pandas
```

The bot automatically detects `.venv/bin/python3` in the project root. If the venv is missing it falls back to system `python3`, but `nba_api` must still be importable.

## How to Run

The pipeline consists of three standalone scripts that can be run independently or chained:

```bash
# 1. Run the daily pipeline — fetches, scores by Pinnacle divergence, saves top 10
npx tsx scripts/daily-pipeline.ts            # JSON summary → stdout, diagnostics → stderr
npx tsx scripts/daily-pipeline.ts > out.json # capture JSON, see diagnostics in terminal

# 2. Generate a human-readable report from saved picks (with Covers.com annotations)
npx tsx scripts/generate-report.ts           # defaults to today
npx tsx scripts/generate-report.ts 2026-02-27

# 3. Check results against ESPN box scores (run next morning)
npx tsx scripts/check-results.ts             # defaults to yesterday
npx tsx scripts/check-results.ts 2026-02-27

# Optional: pull NBA.com tracking opportunity stats for assist/rebound research
python3 scripts/nba-stats.py opportunity-stats "Josh Hart" --season 2025-26 --season-type Playoffs
python3 scripts/nba-stats.py opportunity-stats "Josh Hart" --season 2025-26 --season-type Playoffs --opponent BOS --last-n 5
```

Pipeline steps (daily-pipeline.ts):
1. Fetches today's PrizePicks `NBA`, `NBA1H`, and `NBA1Q` projections separately (standard lines only)
2. Keeps full-game `eventType=team` lines and period-board `eventType=team_with_duration` lines
3. Fetches Pinnacle lines from The Odds API
4. Scores each projection: `edge = (pinnacle_line - pp_line) / pp_line`
5. Filters to Pinnacle-backed picks only (no Pinnacle data = excluded)
6. Ranks by absolute edge, saves top 10 to database (dedupes on re-run)
7. Outputs JSON summary to stdout, including per-league projection counts

## Architecture

Three standalone scripts form a deterministic, cron-friendly pipeline:

```
┌──────────────────────────────────────────────────────────────────┐
│                   scripts/daily-pipeline.ts                       │
│     Fetch → Score (Pinnacle divergence) → Filter → Rank → Save   │
│          stdout: JSON summary  │  stderr: diagnostics             │
├──────────────────────────────────────────────────────────────────┤
│                   scripts/generate-report.ts                      │
│     Read DB picks → Covers annotations → Format markdown → out   │
├──────────────────────────────────────────────────────────────────┤
│                   scripts/check-results.ts                        │
│     Fetch ESPN box scores → Grade picks → Update DB → Scorecard   │
├──────────┬──────────┬──────────┬──────────┬──────────────────────┤
│PrizePicks│ NBA Stats│  Odds    │  Covers  │  Results             │
│  Client  │  Client  │ Service  │  Intel   │  Tracker             │
│  (API)   │ (Python) │(Pinnacle)│(scraper) │  (ESPN)              │
├──────────┴──────────┴──────────┴──────────┴──────────────────────┤
│                          Pick Scorer                              │
│            Score = ABS(pinnacle_edge). That's it.                 │
├──────────────────────────────────────────────────────────────────┤
│                    SQLite DB (data/fund.db)                        │
│   game logs • defense rankings • pick history                     │
└──────────────────────────────────────────────────────────────────┘
```

## Scoring Model

The pick scorer uses **pure Pinnacle divergence** as the only scoring signal.

```
Score = (pinnacle_line - pp_line) / pp_line

Positive → OVER edge (Pinnacle line higher than PrizePicks)
Negative → UNDER edge (Pinnacle line lower than PrizePicks)
No Pinnacle data → score 0, excluded from top picks
```

That's it. No game environment adjustments, no consensus weighting, no expert bonuses, no blowout models, no pace adjustments. Pinnacle is the sharpest sportsbook — when their line diverges from PrizePicks, that's genuine market mispricing.

### Confidence Stars

| Stars | Edge | Meaning |
|-------|------|---------|
| ⭐⭐⭐⭐⭐ | ≥5% | Large Pinnacle divergence |
| ⭐⭐⭐⭐ | 3–5% | Strong edge |
| ⭐⭐⭐ | 2–3% | Moderate edge |
| ⭐⭐ | 1–2% | Small edge |
| ⭐ | <1% | Marginal edge |

### Covers.com Annotations

Each pick in the report is annotated with Covers.com expert alignment:
- 🔒 **Covers agrees** — an expert on Covers picked the same direction
- ⚠️ **Covers contradicts** — an expert picked the opposite direction
- _(no annotation)_ — no matching expert pick found

This is purely informational — it does NOT affect the score.

## Data Sources

| Source | Auth | What it provides |
|--------|------|-----------------|
| [PrizePicks API](https://api.prizepicks.com) | None (free) | Live projections and lines |
| [nba_api](https://github.com/swar/nba_api) (Python) | None (free) | Player game logs, team stats |
| [The Odds API](https://the-odds-api.com) | API key (free tier) | Pinnacle player prop lines |
| [ESPN](https://www.espn.com) | None (scraped) | Injury reports, game logs (fallback), box scores for results |
| [Covers.com](https://www.covers.com) | None (scraped) | Expert prop picks (annotation only) |

The `opportunity-stats` bridge uses NBA.com player tracking through `nba_api` and returns assist/rebound opportunity inputs used by the manual props skill: potential assists, assist points created, passes made/received, touches, time of possession, rebound chances, contested/uncontested rebounds, deferred chances, and rebound chance conversion.

## Key Files

| File | Purpose |
|------|---------|
| `scripts/daily-pipeline.ts` | **Daily pipeline** — fetch, score by Pinnacle divergence, save top 10 |
| `scripts/generate-report.ts` | **Report generator** — reads DB picks, adds Covers annotations, outputs markdown |
| `scripts/check-results.ts` | **Results checker** — grades picks against ESPN box scores |
| `src/prizepicks/pick-scorer.ts` | Pure Pinnacle-divergence scoring engine + parlay builder |
| `src/prizepicks/prizepicks-client.ts` | Fetches projections from PrizePicks API |
| `src/prizepicks/odds-service.ts` | Fetches Pinnacle lines from The Odds API |
| `src/prizepicks/nba-stats-client.ts` | Player game logs, defense rankings (ESPN + nba_api) |
| `src/prizepicks/injury-news-client.ts` | ESPN injury scraper + team impact analysis |
| `src/prizepicks/covers-intel.ts` | Covers.com expert pick scraper (annotation only) |
| `src/prizepicks/results-tracker.ts` | Grades picks against ESPN box scores |
| `src/core/db/database.ts` | SQLite connection + auto-migrations |
| `src/core/db/schema.ts` | DB schema (v7) — game logs, defense, picks, results |
| `scripts/nba-stats.py` | Python bridge for nba_api calls |

## Database

SQLite at `data/fund.db`. Migrations run automatically on first connection via `getDatabase()`.

**Current schema (v7):**
- `player_game_logs` — cached game logs with full shooting stats
- `team_defense_rankings` — stat-specific defense ratings per team
- `team_pace_ratings` — live pace data from NBA.com
- `line_movements` — tracked line changes over time
- `prizepicks_picks` — daily top picks saved by the pipeline; graded next morning against ESPN
- `prizepicks_performance` — nightly performance summary
- `pick_results` — historical pick accuracy by stat type + edge bucket

DB columns like `sharp_projection`, `vegas_total`, `team_total`, `game_spread`, `matchup_grade` remain for backward compatibility but are no longer populated.

## Picks Tracking

Every time `daily-pipeline.ts` runs, the top 10 Pinnacle-backed picks are saved to `prizepicks_picks` (deduped on re-run). The next morning, `check-results.ts` grades them against ESPN box scores and updates `hit` / `actual_result`.

**Check today's picks:**
```bash
sqlite3 data/fund.db "SELECT player_name, stat_type, line, pick, hit, actual_result FROM prizepicks_picks WHERE date = date('now');"
```

**View all-time hit rate:**
```bash
sqlite3 data/fund.db "SELECT COUNT(*) as total, SUM(hit) as hits, ROUND(100.0*SUM(hit)/COUNT(*),1) as pct FROM prizepicks_picks WHERE hit IS NOT NULL;"
```

## Important Rules

- **Standard lines only** — PrizePicks has standard, demon, and goblin lines. Only `odds_type === 'standard'` lines are analyzed.
- **Period props included** — NBA first-half and first-quarter props are pulled as separate PrizePicks leagues (`NBA1H`, `NBA1Q`) and kept when `event_type === 'team_with_duration'`.
- **Pinnacle is the only signal** — No game environment, matchup grades, expert consensus, or sharp projections in scoring.
- **No hardcoded data** — All data comes from live APIs and DB cache.

## Stack

- TypeScript + tsx
- better-sqlite3 (game logs, rankings, pick history)
- Python + nba_api + pandas (player stats bridge)
- PrizePicks API (unauthenticated)
- The Odds API (free tier, ~500 requests/month)
- ESPN APIs (injury reports, box scores)

## License

MIT

### Best Play of the Day

The report includes an optimal PrizePicks entry recommendation based on available Pinnacle-edge picks:

| Edge Picks | Play Type | Payout | Break-Even |
|-----------|-----------|--------|------------|
| 6+ | 6-Man Flex | Up to 25x | 54.25% |
| 5 | 5-Man Flex | Up to 10x | 54.25% |
| 4 | 4-Man Power | 10x | 56.2% |
| 3 | 3-Man Power | 5x | 58.5% |
| 2 | 2-Man Power | 3x | 57.7% |

### Covers Tracking

The `covers_flag` column in `prizepicks_picks` records whether a Covers.com expert agreed or contradicted each pick. Query to analyze correlation:

```sql
SELECT covers_flag, COUNT(*) as n, ROUND(AVG(hit) * 100, 1) as hit_pct
FROM prizepicks_picks WHERE covers_flag IS NOT NULL GROUP BY covers_flag;
```

### Correlation Detection

The report automatically detects and flags correlated picks:
- **Same-game**: Two picks from players in the same game (teammates or opponents)
- **Positively correlated**: Same team, same direction (both OVER or both UNDER)
- **Negatively correlated**: Same team, opposite directions

Correlated picks are labeled with group letters (A, B, C...) in the report table and flagged with warnings in the parlay section.

### DNP (Did Not Play) Detection

The results checker auto-detects players who didn't play:
- If box scores exist but a player has no stats → marked as 🚫 VOID (DNP)
- Voided picks are excluded from win/loss record and all-time stats
- PrizePicks voids picks for players who don't play, so this matches their behavior
