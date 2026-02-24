# PrizePicks Bot

Daily NBA PrizePicks player prop analysis powered by a quantitative data pipeline and sharp betting intelligence. Pulls live projections, player stats, matchup data, injury reports, and expert picks — then scores every prop for edge detection.

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

# 4. Initialize the database (first run only)
npx tsx seed-gamelogs.ts

# 5. Generate today's report
npm run report
```

The report is saved to `./reports/prizepicks-report-YYYY-MM-DD.md`.

## API Keys

Only one API key is required:

| Key | Source | Cost | Used for |
|-----|--------|------|----------|
| `THE_ODDS_API_KEY` | [the-odds-api.com](https://the-odds-api.com) | Free tier (~500 req/month) | DraftKings, FanDuel, and Pinnacle lines; game totals; team totals; player props |

The free tier is sufficient for daily use (~5–10 requests per report run).

`ODDS_API_KEY` (odds-api.io) is an optional secondary source and can be left blank.

## Python Dependency

The NBA stats module calls `nba_api` via a Python subprocess bridge. You need Python 3 installed, then create a virtual environment in the project root:

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install nba_api pandas
```

The bot automatically detects `.venv/bin/python3` in the project root. If the venv is missing it falls back to system `python3`, but `nba_api` must still be importable.

### BettingPros Sharp Projections (Optional)

BettingPros projections require [Scrapling](https://github.com/D4Vinci/Scrapling) (Playwright-based scraper) in a separate venv:

```bash
python3 -m venv scrapling-env
source scrapling-env/bin/activate
pip install scrapling
scrapling install  # installs Playwright browsers
deactivate
```

The bot searches for the scrapling venv in: `./scrapling-env/`, `~/.scrapling-env/`, or `~/.venv/`. If not found, BettingPros is skipped gracefully and the bot uses Dimers/StatsInsider projections only.

## How to Run

```bash
# Generate today's report
npm run report

# The report is written to:
# ./reports/prizepicks-report-YYYY-MM-DD.md
```

Pipeline steps:
1. Fetches today's PrizePicks NBA projections (standard lines only)
2. Fetches spreads and totals from The Odds API (DraftKings primary)
3. Loads defense rankings and pace data from SQLite cache
4. Pulls injury reports from ESPN
5. Scrapes expert picks from Covers, OddsShark, Action Network
6. Scores each projection through the multi-factor model
7. Fetches Pinnacle lines for top candidates
8. Generates a markdown report saved to `./reports/`

## Example Output

```markdown
# 🏀 PrizePicks Daily Report — February 24, 2026

> Generated 6:02:11 AM PST
> 8 NBA games | 312 standard projections analyzed | 247 scored

## 📋 Today's Slate
| Game | Spread | O/U |
|------|--------|-----|
| LAL @ GSW | GSW -4.5 | 228.5 |
...

## 🔥 Top 5 Value Picks

### 1. Steph Curry — Points OVER 28.5
⭐⭐⭐⭐⭐ (5/5) | EV: 12.3% | Score: 0.1231

- **Model Line:** 30.8 vs **PP Line:** 28.5
- **Matchup:** A grade vs LAL
- **Trends:** L3: 31.2 | L10: 29.8 | SZN: 28.9
- **Reasoning:** Pinnacle 30.5 (+7.0%) confirms over edge...
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        run-report.ts                             │
│                 (orchestrates full pipeline)                      │
├──────────┬──────────┬──────────┬──────────┬──────────┬──────────┤
│PrizePicks│ NBA Stats│  Matchup │  Injury  │  Sharps  │  Market  │
│  Client  │  Client  │ Analyzer │  Client  │  Intel   │  Edge    │
│  (API)   │ (Python) │(Pace+B2B)│  (ESPN)  │ (Multi)  │(Pinnacle)│
├──────────┴──────────┴──────────┴──────────┴──────────┴──────────┤
│                          Pick Scorer                             │
│     (Pinnacle-driven edge + consensus + game environment)         │
├──────────┬──────────┬───────────┬───────────┬────────────────────┤
│  Sharp   │  Vegas   │  Hit Rate │  Blowout  │   B2B              │
│  Projs   │  Totals  │  Tracking │  Penalty  │   Penalty          │
├──────────┴──────────┴───────────┴───────────┴────────────────────┤
│                    SQLite DB (data/fund.db)                       │
│   game logs • defense rankings • pace • pick history              │
└──────────────────────────────────────────────────────────────────┘
```

## Scoring Model

The pick scorer uses **Pinnacle lines as the primary edge signal**. Pinnacle is the sharpest sportsbook — when their line diverges from PrizePicks, that's genuine market mispricing, not trailing-average noise.

### Primary Edge (determines OVER/UNDER direction)

```
PRIMARY EDGE = Pinnacle divergence × 0.5
             + Consensus divergence × 0.3
             + Game environment × 0.2

Pinnacle divergence  = (Pinnacle line − PP line) / PP line
Consensus divergence = (avg(DK + FD + Pinnacle) − PP line) / PP line
Game environment     = Team total > 115 → +6% (high team scoring OVER boost, 2x weight)   ← preferred
                       Team total < 105 → −6% (low team scoring UNDER boost, 2x weight)    ← preferred
                       Vegas total > 228 → +2% (fallback when team total unavailable)
                       Vegas total < 215 → −2% (fallback when team total unavailable)
                       Team pace factor (from NBA.com) added at 25% weight

Team total uses the-odds-api `team_totals` market, which assigns an independent
over/under to each team (not the combined game total). This is more precise because
a fast team facing a slow team can have a 120 team total even in a 225-total game.
```

### Adjustments (additive)

| Factor | Effect | Description |
|--------|--------|-------------|
| **Expert Consensus** | +6% | When ≥60% of experts agree with pick direction |
| **Sharp Money** | +8% | When sharp money from books aligns with model |
| **Injury Penalty** | −6% to −15% | Doubtful (−15%), Questionable (−10%), Day-To-Day (−6%) |
| **Teammate OUT Boost** | Variable | Usage redistribution when star teammates sit |
| **B2B Penalty** | −5% | Back-to-back games penalize OVER picks |
| **Blowout Penalty** | Up to −8% | Spreads ≥ 8 pts penalize OVERs (starters pulled) |
| **Hit Rate History** | Variable | Historical accuracy by stat type and edge bucket |
| **Minutes Adjustment** | Variable | Scales projections for blowout/B2B expected minutes changes |
| **Positional Defense** | ±2% | Team defense grade vs player position (A=bad defense=OVER boost) |
| **Pace Adjustment** | Variable | Adjusts averages for fast/slow game pace vs league average |
| **Promo Line Penalty** | −1 star | Flags suspicious lines (>30% from season avg) with confidence reduction |

### Trailing Averages (Context Only)

L3/L5/L10/season averages are displayed in the report for context but **do not factor into the score**. PrizePicks already uses those averages to set their line — using them as a signal creates zero edge.

### Sharp Projections (Supplementary)

Dimers.com and BettingPros model projections are fetched and displayed alongside picks. If their model agrees with the Pinnacle signal, it adds conviction. If they conflict, it's a flag. If the API is down, we proceed gracefully.

### Confidence Stars

| Stars | Total Score | Meaning |
|-------|-------------|---------|
| ⭐⭐⭐⭐⭐ | ≥12% | Pinnacle + consensus both point same direction, strong divergence |
| ⭐⭐⭐⭐ | 8–12% | Good edge with some supporting signals |
| ⭐⭐⭐ | 5–8% | Moderate Pinnacle or consensus edge |
| ⭐⭐ | 2–5% | Marginal divergence |
| ⭐ | <2% | Weak signal only |

Injured players lose 1 star (Day-To-Day) or 2 stars (Questionable/Doubtful) and are flagged with 🏥 in the report.

## Data Sources

| Source | Auth | What it provides |
|--------|------|-----------------|
| [PrizePicks API](https://api.prizepicks.com) | None (free) | Live projections and lines |
| [nba_api](https://github.com/swar/nba_api) (Python) | None (free) | Player game logs, team stats, pace ratings |
| [The Odds API](https://the-odds-api.com) | API key (free tier) | DraftKings + FanDuel + Pinnacle lines + game totals + team totals |
| [ESPN](https://www.espn.com) | None (scraped) | Injury reports, game logs (fallback) |
| [NBA.com](https://stats.nba.com) | None | Live pace ratings per team |
| [Covers.com](https://www.covers.com) | None (scraped) | Expert prop picks |
| [OddsShark](https://www.oddsshark.com) | None (scraped) | Expert prop picks |
| [Action Network](https://www.actionnetwork.com) | None (scraped) | Expert prop picks |
| [Dimers.com](https://www.dimers.com) / StatsInsider | None (API) | Sharp model player projections (supplementary) |
| [BettingPros](https://www.bettingpros.com) | None (scraped) | Sharp model player projections (supplementary) |

## Key Files

| File | Purpose |
|------|---------|
| `run-report.ts` | Main entry — orchestrates full pipeline and generates report |
| `seed-gamelogs.ts` | Pre-seeds game log cache for all active players |
| `src/prizepicks/prizepicks-client.ts` | Fetches projections from PrizePicks API |
| `src/prizepicks/nba-stats-client.ts` | Player game logs, defense rankings, pace (ESPN + nba_api) |
| `src/prizepicks/matchup-analyzer.ts` | Matchup grades, EWMA, minutes projection, pace factor |
| `src/prizepicks/pick-scorer.ts` | Pinnacle-driven scoring engine + parlay builder |
| `src/prizepicks/market-edge.ts` | Multi-book consensus engine (Pinnacle + DK + FD) |
| `src/prizepicks/sharp-projections.ts` | Dimers + BettingPros model projection fetcher |
| `src/prizepicks/injury-news-client.ts` | ESPN injury scraper + team impact analysis |
| `src/prizepicks/expert-picks-client.ts` | Expert pick aggregation + line comparison |
| `src/prizepicks/odds-service.ts` | Unified odds fetcher — player props + spreads + totals |
| `src/prizepicks/sharps-intel.ts` | Pinnacle lines, expert cappers, line movement |
| `src/core/db/database.ts` | SQLite connection + auto-migrations |
| `src/core/db/schema.ts` | DB schema (v6) — game logs, defense, pace, picks |
| `scripts/nba-stats.py` | Python bridge for nba_api calls |
| `scripts/research-agent.md` | OpenClaw automation prompt (not needed for manual use) |

## Database

SQLite at `data/fund.db`. Migrations run automatically on first connection via `getDatabase()`.

**Current schema (v6):**
- `player_game_logs` — cached game logs with full shooting stats (FGA, 3PA, FTA, FTM, FGM)
- `team_defense_rankings` — stat-specific defense ratings per team
- `team_pace_ratings` — live pace data from NBA.com
- `line_movements` — tracked line changes over time
- `pick_results` — historical pick accuracy for hit rate tracking

### Stat Mappings
- "Two Pointers Attempted" = FGA - 3PA
- "Two Pointers Made" = FGM - 3PM
- Plus direct columns for FGA, FGM, 3PA, FTA, FTM

## Important Rules

- **Standard lines only** — PrizePicks has standard, demon, and goblin lines. Only `odds_type === 'standard'` full-game lines are analyzed.
- **Blowout penalty** — Spreads ≥ 8 pts automatically penalize OVER picks.
- **Injury flags** — Players with injury designations get score penalties AND are flagged 🏥 in the report.
- **No hardcoded data** — Pace and defense rankings come from live APIs and DB cache, not static files.

## Stack

- TypeScript + tsx
- better-sqlite3 (game logs, rankings, pick history)
- Python + nba_api + pandas (player stats bridge)
- PrizePicks API (unauthenticated)
- The Odds API (free tier, ~500 requests/month)
- ESPN APIs (injury reports, game logs fallback)

## License

MIT
