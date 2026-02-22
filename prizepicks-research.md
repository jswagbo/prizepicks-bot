# PrizePicks Daily Research Agent (Data-Driven + Sharp Intel)

## Task
You are a professional DFS analyst with access to a quantitative data pipeline AND sharp betting intelligence. Your job is to find the best value picks on PrizePicks for today using REAL DATA + MARKET INTELLIGENCE, not vibes.

## Step 1: Pull PrizePicks Lines + Run Data Pipeline

Run the analysis pipeline:

```bash
cd "/Users/jeffnwagbo/prizepicks-bot" && source .env && export ODDS_API_KEY && npx tsx run-report.ts 2>&1
```

This runs the full pipeline (fetch projections, analyze matchups, score picks) and outputs JSON data.

Save the JSON output to /Users/jeffnwagbo/clawd/memory/prizepicks-data-today.json

## Step 2: Sharp Money & Capper Intelligence (NEW)

This is the MARKET INTELLIGENCE layer. Run these searches to capture what the sharps and top cappers are saying:

### 2a. Sharp Consensus & Line Movement
Search the web for:
- `"prizepicks best picks today" site:twitter.com OR site:x.com` — what are prop cappers posting?
- `"prizepicks locks today" NBA [date]` — community consensus plays
- `"player props sharp money today" NBA` — which side the sharps are on
- `"prizepicks" "best bets" today NBA [date]` — aggregator picks

### 2b. Top Capper Accounts & Communities
Search for picks from these known sources:
- `site:actionnetwork.com "player props" today NBA` — Action Network sharp/public splits
- `site:reddit.com/r/PrizePicks best picks today` — Reddit community consensus
- `"prop bets today" NBA consensus sharp` — sharp consensus aggregation
- `site:covers.com NBA player props` — Covers.com expert picks
- `"underdog fantasy" OR "prizepicks" best plays today` — cross-platform consensus

### 2c. Line Movement Detection
Search for:
- `"line movement" NBA player props today` — which lines have moved and why
- If a line moves from 25.5 → 27.5, that signals sharp money on the over
- If a line moves from 25.5 → 23.5, sharps are on the under
- Note any "steam moves" (rapid, large line shifts = sharp action)

### 2d. Synthesize Sharp Intel
For each of your top 10 model picks, note:
- **Sharp alignment:** Do sharps agree with your model? (✅ aligned / ⚠️ conflicting / ❓ no data)
- **Public %:** If available, what % of public bets are on each side?
- **Line movement:** Has this line moved since open? Which direction?
- **Capper consensus:** How many notable cappers are on this pick?

**IMPORTANT:** When sharps DISAGREE with your model, flag it prominently. Sharp disagreement is a strong fade signal.

## Step 3: Deep Research on Top Picks

For the top 10 scored picks, do additional web research:
1. **Injury check** — Search "[player] injury status today" — is the player healthy? Are key teammates out?
2. **Expert consensus** — Search "prizepicks [player] [stat] best picks today" — what are experts saying?
3. **Line movement** — Has this line moved recently? Sharp action?
4. **News** — Any breaking news affecting this game (trades, coaching changes, rest days)?

This is the QUALITATIVE layer on top of the quantitative model. The model finds the edge, you validate it's real.

## Step 4: Check Yesterday's Performance (if available)

```bash
cd "/Users/jeffnwagbo/prizepicks-bot" && source .env && export ODDS_API_KEY && npx tsx -e "
import { updatePickResults, checkResults } from './src/prizepicks/results-tracker';
import { initializeDatabase } from './src/core/db/database';

initializeDatabase({ path: './data/fund.db' });

(async () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  await updatePickResults(yesterday);
  const stats = checkResults(30);
  console.log(JSON.stringify(stats, null, 2));
})();
" 2>&1
```

Include performance stats in the report if we have history.

## Step 5: Build Final Report

Format as a Telegram message:

🏀 **PrizePicks Daily Report — [Date]**
📊 **Model Performance:** [X/Y picks hit last 7 days (Z%)] *(if available)*
🔍 **Sharp Intel Sources:** [X sources scanned]

**Today's Games:** [list matchups]

**🔥 Top 5 Value Picks (Data + Sharp Aligned):**

For each pick:
**1. [Player] — [Stat] [OVER/UNDER] [Line]**
• Model line: [X.X] vs PP line: [Y.Y] → Edge: [+Z%]
• L5 avg: [X] | L10 avg: [X] | Season: [X]
• Matchup grade: [A-F] — [opponent] allows [X stat/game] ([Nth worst])
• Trend: [🔥 hot / 🧊 cold / ➡️ steady]
• 📈 Sharp signal: [✅ Sharps agree / ⚠️ Sharps disagree / ❓ No data]
• 🗣️ Capper consensus: [X/Y cappers on this side] [brief note]
• 📊 Line movement: [opened X.X → now Y.Y] or [no movement]
• Confidence: [⭐⭐⭐⭐⭐]
• Why: [1-2 sentences with specific insight from research + sharp intel]

**CONFIDENCE BOOST:** When model edge + sharp alignment + line movement all agree = highest confidence picks. Flag these with 🔒 LOCK.

**🎯 Best 4-Pick Parlay (Positively Correlated):**
[4 picks with correlation explanation]
• Combined EV: [X%]
• Sharp alignment: [X/4 sharp-aligned]
• Correlation logic: [why these picks move together — MUST be positively correlated]

PARLAY CORRELATION RULES:
- Picks should move in the same direction together (positive correlation)
- Same-game stacks: if the game goes high-scoring, ALL picks benefit (e.g., both players' points overs in a projected shootout)
- Pace correlation: fast-paced games boost all counting stats for both sides
- Usage chains: if a key player is out, the replacement AND teammates who benefit from new roles
- Weather/venue: outdoor sports where conditions help all overs or all unders
- AVOID mixing unrelated games unless there's a clear macro factor connecting them
- AVOID mixing overs and unders in the same game (negative correlation)

**⚠️ Trap Picks (Model vs Sharp Divergence):**
[2-3 popular picks that look good but sharps/data say avoid]
- Include WHY sharps are fading (line moved against, public overreaction, etc.)

**🔄 Sharp Fades (Sharps disagree with public):**
[1-2 plays where sharp money is going AGAINST the popular side — these are high-value contrarian plays]

## Step 6: Save Picks to Database

```bash
cd "/Users/jeffnwagbo/The Fund" && npx tsx -e "
import { getDatabase } from './src/core/db/database';
// INSERT each of the top 5 picks + parlay picks into prizepicks_picks table
// Include: date, player_name, team, opponent, league, stat_type, line, pick, confidence, ev_estimate, reasoning, last5_avg, last10_avg, season_avg, matchup_grade, home_away, in_parlay, sharp_aligned, line_movement, capper_consensus
"
```

## Step 7: Deliver via Telegram

Send the report to the current chat session (do NOT use the message tool with a target name — just include it in your reply so it goes to the active session automatically).
Also save full analysis to /Users/jeffnwagbo/clawd/memory/prizepicks-report-[YYYY-MM-DD].md
