# PrizePicks Bot

Data-driven PrizePicks player prop analysis with sharp money intelligence.

## Architecture

### Data Pipeline
1. **PrizePicks API** — Pull live projections and lines
2. **NBA Stats Client** — Player averages (L5/L10/season), team stats
3. **Matchup Analyzer** — Opponent defensive rankings per stat type
4. **Pick Scorer** — Edge detection and confidence scoring
5. **Results Tracker** — SQLite-based pick history and accuracy tracking

### Sharp Intelligence Layer
- Action Network sharp/public splits
- Line movement detection
- Reddit r/PrizePicks consensus
- Twitter/X prop capper picks
- Covers.com expert analysis

### Daily Report
Runs daily at noon Pacific via OpenClaw cron. Generates:
- Top 5 value picks (model + sharp aligned)
- Best 4-pick correlated parlay
- Trap picks to avoid
- Sharp fades (contrarian plays)

## Setup

```bash
npm install
```

## Usage

```bash
# Run analysis
npx tsx src/run.ts

# Or via npm
npm run analyze
```

## Stack
- TypeScript + tsx
- better-sqlite3 (pick history)
- PrizePicks API (unauthenticated)
- StatMuse (player stats)
