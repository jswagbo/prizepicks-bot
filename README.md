# PrizePicks Bot

Daily NBA PrizePicks player prop analysis powered by a quantitative data pipeline and sharp betting intelligence. Pulls live projections, player stats, matchup data, injury reports, and expert picks — then scores every prop for edge detection.

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
Game environment     = Vegas total > 228 → +2% (high scoring OVER boost)
                       Vegas total < 215 → −2% (low scoring UNDER boost)
                       Team pace factor (from NBA.com) added at 25% weight
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

### Trailing Averages (Context Only)

L3/L5/L10/season averages are displayed in the report for context but **do not factor into the score**. PrizePicks already uses those averages to set their line — using them as a signal creates zero edge.

### Sharp Projections (Supplementary)

Dimers.com and BettingPros model projections are scraped and displayed alongside picks. If their model agrees with the Pinnacle signal, it adds conviction. If they conflict, it's a flag. If scraping fails (anti-bot), we proceed gracefully without them.

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
| [The Odds API](https://the-odds-api.com) | API key (free tier) | DraftKings + FanDuel + Pinnacle lines + game totals |
| [ESPN](https://www.espn.com) | None (scraped) | Injury reports, game logs (fallback) |
| [NBA.com](https://stats.nba.com) | None | Live pace ratings per team |
| [Covers.com](https://www.covers.com) | None (scraped) | Expert prop picks |
| [OddsShark](https://www.oddsshark.com) | None (scraped) | Expert prop picks |
| [Action Network](https://www.actionnetwork.com) | None (scraped) | Expert prop picks |
| [Dimers.com](https://www.dimers.com) | None (scraped) | Sharp model player projections (supplementary) |
| [BettingPros](https://www.bettingpros.com) | None (scraped) | Sharp model player projections (supplementary) |

## Setup

### 1. Install Node dependencies

```bash
npm install
```

### 2. Set up Python environment (for NBA stats)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install nba_api pandas
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env and add your keys:
# THE_ODDS_API_KEY — get one free at https://the-odds-api.com
# ODDS_API_KEY — (optional) fallback odds source
```

### 4. Seed game logs (first run or after DB reset)

```bash
source .env && npx ts-node --transpile-only seed-gamelogs.ts
```

This pre-populates the SQLite cache with game logs for all active PrizePicks players. Required after a fresh install or schema migration.

## Usage

### Run the full pipeline

```bash
source .env && export THE_ODDS_API_KEY ODDS_API_KEY
npx ts-node --transpile-only run-report.ts
```

Pipeline steps:
1. Fetches today's PrizePicks NBA projections (filters to standard full-game lines)
2. Fetches spreads from The Odds API (DraftKings primary)
3. Loads defense rankings and pace data from DB cache
4. Pulls injury reports from ESPN
5. Scrapes expert picks from Covers, OddsShark, Action Network
6. Scores each projection through the multi-factor model
7. Fetches Pinnacle lines + sharp capper picks for top candidates
8. Generates markdown report with top picks, locks, parlay, traps, injury flags

### Automated daily report

Runs via OpenClaw cron job daily. The report is delivered to Telegram with:
- Top 5 value picks with full reasoning
- Lock picks (5-star confidence)
- Best 4-pick uncorrelated parlay
- Trap picks to avoid (sharps disagree)
- Injury impact analysis
- Sharp money signals
- Blowout alerts

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
| `src/prizepicks/sharp-projections.ts` | Dimers + BettingPros model projection scraper |
| `src/prizepicks/injury-news-client.ts` | ESPN injury scraper + team impact analysis |
| `src/prizepicks/expert-picks-client.ts` | Expert pick aggregation + line comparison |
| `src/prizepicks/odds-service.ts` | Unified odds fetcher — player props + spreads + totals |
| `src/prizepicks/sharps-intel.ts` | Pinnacle lines, expert cappers, line movement |
| `src/core/db/database.ts` | SQLite connection + auto-migrations |
| `src/core/db/schema.ts` | DB schema (v6) — game logs, defense, pace, picks |
| `scripts/nba-stats.py` | Python bridge for nba_api calls |

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

- TypeScript + ts-node
- better-sqlite3 (game logs, rankings, pick history)
- Python + nba_api + pandas (player stats bridge)
- PrizePicks API (unauthenticated)
- The Odds API (free tier, ~100K credits/month)
- ESPN APIs (injury reports, game logs fallback)
