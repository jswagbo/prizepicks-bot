# PrizePicks Daily Research Agent (Data-Driven + Sharp Intel)

## CRITICAL RULES — READ FIRST
1. **NEVER ship an incomplete report.** If the pipeline fails, debug it. If stats return zeros, that means the pipeline is broken — FIX IT, don't report zero-stat picks.
2. **Blowout penalty MUST appear in every report.** If spreads are null, note it explicitly: "⚠️ Blowout data unavailable — spreads returned null."
3. **Take your time.** Quality > speed. Run every step thoroughly. Jeff doesn't care how long this takes.
4. **All exports are standalone FUNCTIONS, not classes.** Use `import { functionName } from '...'` — NEVER use `new ClassName()`.
5. **Load environment:** Always `source /Users/jeffnwagbo/prizepicks-bot/.env` before running, or pass `ODDS_API_KEY` explicitly.
6. **Repo path:** `/Users/jeffnwagbo/prizepicks-bot` (NOT `/Users/jeffnwagbo/The Fund`)

## Step 1: Run the Data Pipeline

```bash
cd "/Users/jeffnwagbo/prizepicks-bot" && source .env && export THE_ODDS_API_KEY && npx tsx -e "
import { getProjections } from './src/prizepicks/prizepicks-client';
import { getTodaysGames, getPlayerAverages, searchPlayer } from './src/prizepicks/nba-stats-client';
import { analyzeMatchup } from './src/prizepicks/matchup-analyzer';
import { scoreProjection, rankProjections, buildParlay } from './src/prizepicks/pick-scorer';
import { initializeDatabase } from './src/core/db/database';

initializeDatabase({ path: './data/fund.db' });

(async () => {
  // Get today's PrizePicks NBA projections
  const projections = await getProjections('NBA');
  console.log('NBA projections:', projections.length);

  // Get today's games (includes spreads from Odds-API.io)
  const games = await getTodaysGames();
  console.log('Games today:', games.length);
  games.forEach(g => console.log('  ', g.awayTeam, '@', g.homeTeam, '| spread:', g.spread));

  // Build a spread lookup by team
  const spreadByTeam: Record<string, number | null> = {};
  for (const g of games) {
    spreadByTeam[g.homeTeam] = g.spread;
    spreadByTeam[g.awayTeam] = g.spread ? -g.spread : null;
  }

  // Find homeAway for each projection
  const homeAwayByTeam: Record<string, 'home' | 'away'> = {};
  const opponentByTeam: Record<string, string> = {};
  for (const g of games) {
    homeAwayByTeam[g.homeTeam] = 'home';
    homeAwayByTeam[g.awayTeam] = 'away';
    opponentByTeam[g.homeTeam] = g.awayTeam;
    opponentByTeam[g.awayTeam] = g.homeTeam;
  }

  // Analyze projections — sample evenly across teams for game diversity
  const targetStats = ['Points', 'Rebounds', 'Assists', 'Pts+Rebs+Asts', '3-PT Made', 'Fantasy Score', 'Blks+Stls'];
  const filtered = projections.filter(p => targetStats.some(s => p.statType.includes(s)));
  console.log('Filtered projections:', filtered.length);

  // Group by team and take up to 6 per team to ensure all games represented
  const byTeam: Record<string, typeof filtered> = {};
  for (const p of filtered) {
    if (!byTeam[p.team]) byTeam[p.team] = [];
    byTeam[p.team].push(p);
  }
  const sampled: typeof filtered = [];
  const maxPerTeam = Math.max(4, Math.floor(80 / Object.keys(byTeam).length));
  for (const team of Object.keys(byTeam)) {
    sampled.push(...byTeam[team].slice(0, maxPerTeam));
  }
  console.log('Sampled projections:', sampled.length, 'from', Object.keys(byTeam).length, 'teams');

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const analyzed = [];
  for (const proj of sampled) {
    try {
      const opponent = opponentByTeam[proj.team] || '';
      const homeAway = homeAwayByTeam[proj.team] || 'away';
      const spread = spreadByTeam[proj.team] || null;
      
      const matchup = await analyzeMatchup(
        proj.playerName, proj.statType, opponent, proj.line, homeAway, spread
      );
      const score = await scoreProjection(proj, matchup);
      analyzed.push(score);
      await sleep(500); // Throttle to avoid 429s from PrizePicks/Odds APIs
    } catch (e) {
      console.error('Skip', proj.playerName, ':', (e as Error).message);
      await sleep(1000); // Back off on errors
    }
  }

  // Rank and output
  const ranked = rankProjections(analyzed);
  const parlay = buildParlay(ranked.slice(0, 15));

  console.log('=== TOP PICKS ===');
  console.log(JSON.stringify(ranked.slice(0, 20), null, 2));
  console.log('=== PARLAY ===');
  console.log(JSON.stringify(parlay, null, 2));
  console.log('=== SPREAD DATA ===');
  console.log(JSON.stringify(spreadByTeam, null, 2));
})();
" 2>&1
```

**VALIDATION CHECKLIST** (do NOT proceed to Step 2 until ALL pass):
- [ ] `NBA projections:` count > 0 (if 0, PrizePicks API is down — say so, don't fake it)
- [ ] `Games today:` count > 0
- [ ] At least SOME spreads are non-null (if all null, note it in report)
- [ ] Top picks JSON has non-zero `totalScore`, `ev`, and `confidence` values
- [ ] Top picks have non-zero `totalScore` (raw score should be visible in output)
- [ ] **Pinnacle line data:** At least some top picks have non-null `pinnacleLine` (not ALL null — if ALL null, THE_ODDS_API_KEY may be missing or Pinnacle not available for these games; note explicitly)
- [ ] **consensusLine** present for top picks when DK/FD lines are available
- [ ] **vegasTotal** is non-null for at least some games (confirms fetchGameTotals is working)
- [ ] `pinnacleEdge` and `consensusEdge` are non-zero for picks with Pinnacle data
- [ ] **Combo stat markets:** At least some picks have combo stats (Pts+Rebs, Rebs+Asts, Blks+Stls, etc.) with non-null Pinnacle lines — if ALL combo stats show null Pinnacle, the extended market list may not be loading
- [ ] **Team totals loaded:** At least some picks show `Team total: X.X` in reasoning (not just `Vegas total`) — confirms `fetchTeamTotals()` is working; if all show `Vegas total` fallback, check THE_ODDS_API_KEY and team_totals market availability

**If any check fails:** Debug the pipeline. Read error messages. Try fetching individual player stats. Fix the issue. Do NOT proceed with broken data.

## Step 2: Sharp Money & Capper Intelligence

Search the web for sharp betting intel on today's games:

### 3a. Sharp Consensus
- `"prizepicks best picks today" site:twitter.com OR site:x.com`
- `"player props sharp money today" NBA`
- `site:actionnetwork.com "player props" today NBA`
- `site:reddit.com/r/PrizePicks best picks today`

### 3b. Line Movement
- `"line movement" NBA player props today`
- Note any steam moves (rapid large shifts = sharp action)

### 3c. Synthesize
For each top 10 pick, note:
- **Sharp alignment:** ✅ aligned / ⚠️ conflicting / ❓ no data
- **Line movement:** opened X → now Y, or no movement
- **Capper consensus:** how many cappers on this side

## Step 3: Deep Research on Top Picks

For the top 10 picks:
1. **Injury check** — "[player] injury status today"
2. **Expert consensus** — "prizepicks [player] [stat] best picks today"
3. **News** — trades, coaching changes, rest days, back-to-backs

## Step 4: Build the Report

Format as a Telegram message:

🏀 **PrizePicks Daily Report — [Date]**

**Today's Games + Spreads:**
[list matchups with spreads — this confirms spread data is working]

**🔥 Top 5 Value Picks:**

For each pick:
**1. [Player] — [Stat] [OVER/UNDER] [Line]**
• Pinnacle: [X.X] vs PP [Y.Y] → [+Z%] edge
• Book consensus: DK [X] / FD [X] / Pinnacle [X] = avg [X] vs PP [Y]
• Vegas total: [X] ([high/low/neutral]) → [scoring OVER/UNDER boosted or N/A]
• Dimers projection: [X] ([agrees/conflicts with OVER/UNDER])
• Raw score: [totalScore] | EV: [ev]
• 📈 Sharp signal: ✅/⚠️/❓
• ⚠️ Blowout risk: [spread]pt spread → [penalty or "no penalty"]
• Confidence: ⭐⭐⭐⭐⭐
• Why: [1-2 sentences of primary edge logic]

**🔒 LOCK picks** = model edge + sharp alignment + line divergence all agree

**🎯 Best 4-Pick Parlay:**
[4 uncorrelated picks from different games]
• Correlation logic: [why these picks work together]
PARLAY RULES:
- All picks must be positively correlated
- Different games for independence
- Don't mix overs and unders in same game

**⚠️ Trap Picks:**
[2-3 picks that look good but sharps/data say avoid]

**📊 Top Line Divergences:**
[Top 10 picks sorted by absolute book consensus edge % — these come from the market-edge data in Step 1, not a separate script]

## Step 5: Save Report

Save the full report to `/Users/jeffnwagbo/clawd/memory/prizepicks-report-[YYYY-MM-DD].md`

## Step 6: Deliver

DO NOT use the message tool. Just include the report in your reply text — it will be delivered automatically via the announce mechanism.

## FINAL QUALITY CHECK
Before sending, verify:
- [ ] Every pick has Pinnacle edge shown (or "Pinnacle N/A" if no data — explain why)
- [ ] Blowout penalty section present for each pick (even if "no blowout risk")
- [ ] Vegas total shown for each game (or "Vegas total unavailable" — note it)
- [ ] At least some spreads shown in the games section
- [ ] Reasoning is specific — must reference Pinnacle line if available
- [ ] Trailing averages shown as CONTEXT only (not primary reasoning)
- [ ] Parlay picks are from different games
- [ ] Report saved to memory file
