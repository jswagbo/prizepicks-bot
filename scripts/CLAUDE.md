# Scripts Architecture — PrizePicks Bot

## Overview

The pipeline is three standalone TypeScript scripts. No AI agent orchestration — each script is deterministic and cron-friendly.

```
daily-pipeline.ts  →  generate-report.ts  →  check-results.ts
   (morning)             (after pipeline)       (next morning)
```

## Scripts

### `daily-pipeline.ts`
- **Fetches** PrizePicks NBA projections (standard lines only, demon/goblin filtered out)
- **Scores** each projection via `scoreProjection()` using Pinnacle-driven model
- **Filters** to Pinnacle-backed picks only — picks without Pinnacle data are discarded
- **Ranks** by total score via `rankProjections()`
- **Dedupes** — deletes existing picks for today before inserting (safe to re-run)
- **Saves** top 10 to `prizepicks_picks` table via `savePicks()`
- **Outputs** JSON summary to **stdout** only; all diagnostics go to **stderr**
- Exit code: 0 = success, 1 = failure

```bash
npx tsx scripts/daily-pipeline.ts            # JSON to stdout
npx tsx scripts/daily-pipeline.ts > out.json # capture JSON, diagnostics visible in terminal
npx tsx scripts/daily-pipeline.ts 2>/dev/null # JSON only, suppress diagnostics
```

### `generate-report.ts`
- Reads picks from database for a given date (default: today)
- Formats a markdown report with: games/spreads, top picks, Pinnacle divergences, recent performance
- Outputs to stdout and saves to `~/clawd/memory/`
- Arg: optional date string `YYYY-MM-DD`

### `check-results.ts`
- Grades picks against ESPN box scores (default: yesterday, since results come next day)
- Calls `updatePickResults()` which handles fuzzy player matching and composite stat computation
- Outputs scorecard with hit/miss breakdown, confidence calibration, all-time stats
- Arg: optional date string `YYYY-MM-DD`

## Key Conventions

1. **All exports are standalone functions, not classes.** Use `import { fn } from '...'` — never `new ClassName()`.
2. **Pinnacle is the primary edge signal.** The pipeline requires Pinnacle data for all top picks.
3. **Standard lines only.** `oddsType === 'standard'` — demon/goblin lines are filtered out.
4. **Database path:** `data/fund.db` (relative to repo root). Scripts use `path.resolve(__dirname, '../data/fund.db')`.
5. **Env vars:** Loaded from `.env` at repo root via `dotenv.config({ path: path.resolve(__dirname, '../.env') })`.
6. **Schema version:** v7 — includes `pinnacle_line`, `pinnacle_edge`, `sharp_projection`, `vegas_total` columns.
7. **stdout/stderr separation:** In `daily-pipeline.ts`, `console.log` is redirected to stderr. Only the final JSON uses `process.stdout.write()`.

## Core Modules

| Module | Key Exports | Used By |
|--------|-------------|---------|
| `src/prizepicks/prizepicks-client.ts` | `getProjections(league)` | daily-pipeline |
| `src/prizepicks/nba-stats-client.ts` | `getTodaysGames()` | daily-pipeline |
| `src/prizepicks/matchup-analyzer.ts` | `analyzeMatchup(player, stat, opp, line, homeAway, spread)` | daily-pipeline |
| `src/prizepicks/pick-scorer.ts` | `scoreProjection()`, `rankProjections()`, `buildParlay()`, `savePicks()` | daily-pipeline |
| `src/prizepicks/results-tracker.ts` | `updatePickResults(date)` | check-results |
| `src/core/db/database.ts` | `initializeDatabase(opts)`, `getDatabase()` | all scripts |

## Deprecated

`scripts/research-agent.md.deprecated` — old AI-driven pipeline instructions for OpenClaw. Kept for reference only. The new pipeline does not use AI orchestration.
