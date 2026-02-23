# PrizePicks Bot

Daily NBA PrizePicks player prop analysis powered by a quantitative data pipeline and sharp betting intelligence. Pulls live projections, player stats, matchup data, injury reports, and expert picks — then scores every prop for edge detection.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     run-report.ts                        │
│              (orchestrates full pipeline)                 │
├──────────┬──────────┬───────────┬───────────┬───────────┤
│ PrizePicks│ NBA Stats│  Matchup  │  Injury   │  Sharps   │
│  Client   │  Client  │ Analyzer  │  Client   │  Intel    │
│ (API)     │ (Python) │ (Pace+Def)│ (ESPN)    │ (Multi)   │
├──────────┴──────────┴───────────┴───────────┴───────────┤
│                    Pick Scorer                           │
│     (edge detection + confidence + injury flags)         │
├──────────┬──────────┬───────────┬───────────┬───────────┤
│  Minutes │   EWMA   │  Hit Rate │  Blowout  │   B2B     │
│Projection│ Weighting│  Tracking │  Penalty  │  Penalty  │
├──────────┴──────────┴───────────┴───────────┴───────────┤
│              SQLite DB (data/fund.db)                    │
│   game logs • defense rankings • pace • pick history     │
└─────────────────────────────────────────────────────────┘
```

## Scoring Model

The pick scorer evaluates every projection through multiple factors:

| Factor | Weight | Description |
|--------|--------|-------------|
| **Base Edge** | Primary | Model line (EWMA-weighted avg) vs PrizePicks line |
| **Matchup Grade** | A-F | Stat-specific defense ranking of opponent |
| **Trend Analysis** | L3/L10/SZN | Hot/cold streak detection |
| **Sharp Money** | ±10% max | Pinnacle line comparison + expert capper consensus |
| **Expert Consensus** | +6% | When 60%+ of experts agree with pick direction |
| **Sharp Money Agree** | +8% | When sharp money aligns with model direction |
| **Minutes Projection** | Variable | L5 minutes vs season avg → projected output adjustment |
| **Pace Factor** | Variable | Live NBA.com pace data per team |
| **Injury Penalty** | -6% to -15% | Doubtful (-15%), Questionable (-10%), Day-To-Day (-6%) |
| **Injury Return Rust** | Up to -8% | Recent minutes < 70% of season avg |
| **B2B Penalty** | Negative | Back-to-back games reduce OVER confidence |
| **Blowout Penalty** | Negative | Spreads ≥ 8 pts penalize OVERs (starters pulled) |
| **Home Court** | +1.5% | Small home advantage bonus |
| **Hit Rate History** | Variable | Historical accuracy by stat type and edge bucket |

### Confidence Stars
- ⭐⭐⭐⭐⭐ (5) — Strong edge, multiple confirming signals
- ⭐⭐⭐⭐ (4) — Good edge with some uncertainty
- ⭐⭐⭐ (3) — Moderate edge
- ⭐⭐ (2) — Marginal
- ⭐ (1) — Weak or injury-flagged

Injured players lose 1 star (Day-To-Day) or 2 stars (Questionable/Doubtful) and are flagged with 🏥 in the report.

## Data Sources

| Source | Auth | What it provides |
|--------|------|-----------------|
| [PrizePicks API](https://api.prizepicks.com) | None (free) | Live projections and lines |
| [nba_api](https://github.com/swar/nba_api) (Python) | None (free) | Player game logs, team stats, pace ratings |
| [The Odds API](https://the-odds-api.com) | API key (free tier) | DraftKings + FanDuel + Pinnacle lines |
| [ESPN](https://www.espn.com) | None (scraped) | Injury reports, game logs (fallback) |
| [NBA.com](https://stats.nba.com) | None | Live pace ratings per team |
| [Covers.com](https://www.covers.com) | None (scraped) | Expert prop picks |
| [OddsShark](https://www.oddsshark.com) | None (scraped) | Expert prop picks |
| [Action Network](https://www.actionnetwork.com) | None (scraped) | Expert prop picks |

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
| `src/prizepicks/pick-scorer.ts` | Multi-factor scoring engine + parlay builder |
| `src/prizepicks/injury-news-client.ts` | ESPN injury scraper + team impact analysis |
| `src/prizepicks/expert-picks-client.ts` | Expert pick aggregation + line comparison |
| `src/prizepicks/odds-service.ts` | Unified odds fetcher (The Odds API) |
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
