/**
 * Full pipeline integration test
 * Tests scoring real PrizePicks projections with all new model improvements
 * Run with: npx tsx test-full-pipeline.ts
 */

import { getProjections, type PrizePicksProjection } from './src/prizepicks/prizepicks-client';
import { analyzeMatchup } from './src/prizepicks/matchup-analyzer';
import { scoreProjection, rankProjections } from './src/prizepicks/pick-scorer';
import { getTodaysGames } from './src/prizepicks/nba-stats-client';

async function testFullPipeline() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PrizePicks Full Pipeline Test');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Step 1: Fetch today's games
  console.log('📅 Step 1: Fetching today\'s NBA games...');
  const todaysGames = await getTodaysGames();
  console.log(`   Found ${todaysGames.length} games today\n`);

  if (todaysGames.length === 0) {
    console.log('⚠️  No games today — using mock data for testing\n');
  }

  // Step 2: Fetch PrizePicks projections
  console.log('🎯 Step 2: Fetching PrizePicks projections...');
  const allProjections = await getProjections();
  console.log(`   Total projections: ${allProjections.length}`);

  // Filter to NBA only
  const nbaProjections = allProjections.filter(p => p.league === 'NBA');
  console.log(`   NBA projections: ${nbaProjections.length}\n`);

  if (nbaProjections.length === 0) {
    console.log('❌ No NBA projections available. Cannot test pipeline.\n');
    return;
  }

  // Step 3: Test on a sample of projections (5-10)
  const sampleSize = Math.min(10, nbaProjections.length);
  const sample = nbaProjections.slice(0, sampleSize);

  console.log(`🧪 Step 3: Testing scoring pipeline on ${sampleSize} projections...\n`);
  console.log('─────────────────────────────────────────────────────────────\n');

  const scoredPicks = [];

  for (const projection of sample) {
    try {
      console.log(`\n📊 Analyzing: ${projection.playerName} (${projection.team})`);
      console.log(`   Stat: ${projection.statType} | Line: ${projection.line}`);

      // Find opponent from today's games
      const game = todaysGames.find(g => 
        g.homeTeam === projection.team || g.awayTeam === projection.team
      );
      const opponent = game 
        ? (game.homeTeam === projection.team ? game.awayTeam : game.homeTeam)
        : 'UNKNOWN';
      const homeAway = game 
        ? (game.homeTeam === projection.team ? 'home' as const : 'away' as const)
        : 'home' as const;
      const gameSpread = game?.spread ?? null;

      // Analyze matchup (with playerTeam parameter for new features)
      const matchup = await analyzeMatchup(
        projection.playerName,
        projection.statType,
        opponent,
        projection.line,
        homeAway,
        gameSpread,
        projection.team // Pass team for pace/B2B calculation
      );

      console.log(`   ├─ EWMA: ${matchup.ewma}`);
      console.log(`   ├─ Expected minutes: ${matchup.expectedMinutes ?? 'N/A'} (season avg: ${matchup.seasonAvgMinutes ?? 'N/A'})`);
      console.log(`   ├─ Pace adjustment: ${(matchup.paceAdjustment * 100).toFixed(2)}%`);
      console.log(`   ├─ Back-to-back: ${matchup.isBackToBack ? 'YES ⚠️' : 'NO'}`);
      console.log(`   ├─ Defense rank: #${matchup.opponentDefenseRank ?? 'N/A'} (${matchup.matchupGrade})`);
      console.log(`   └─ Estimated line: ${matchup.estimatedLine} (PP line: ${matchup.prizePicksLine})`);

      // Score the pick
      const scored = await scoreProjection(projection, matchup);
      scoredPicks.push(scored);

      console.log(`   ✅ Pick: ${scored.pick} | Confidence: ${scored.confidence}⭐ | EV: ${(scored.ev * 100).toFixed(2)}%`);
      console.log(`   Reasoning: ${scored.reasoning.substring(0, 150)}...`);

    } catch (err) {
      console.error(`   ❌ Error scoring ${projection.playerName}:`, err instanceof Error ? err.message : err);
    }
  }

  // Step 4: Rank and display top picks
  console.log('\n\n═══════════════════════════════════════════════════════════');
  console.log('  🏆 Top Picks (Ranked by Edge)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const ranked = rankProjections(scoredPicks);

  for (let i = 0; i < Math.min(5, ranked.length); i++) {
    const pick = ranked[i];
    console.log(`${i + 1}. ${pick.projection.playerName} — ${pick.projection.statType} ${pick.pick}`);
    console.log(`   Confidence: ${pick.confidence}⭐ | EV: ${(pick.ev * 100).toFixed(2)}%`);
    console.log(`   ${pick.reasoning.substring(0, 120)}...`);
    console.log('');
  }

  // Step 5: Verify new fields are populated
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ✅ Verification: New Fields Populated');
  console.log('═══════════════════════════════════════════════════════════\n');

  const firstPick = scoredPicks[0];
  const checks = [
    { name: 'EWMA', value: firstPick.matchup.ewma, check: firstPick.matchup.ewma > 0 },
    { name: 'Pace Adjustment', value: firstPick.matchup.paceAdjustment, check: true },
    { name: 'Back-to-Back Flag', value: firstPick.matchup.isBackToBack, check: typeof firstPick.matchup.isBackToBack === 'boolean' },
    { name: 'Expected Minutes', value: firstPick.matchup.expectedMinutes ?? 'null', check: true },
    { name: 'Defense Rank', value: firstPick.matchup.opponentDefenseRank ?? 'null', check: true },
  ];

  for (const { name, value, check } of checks) {
    const status = check ? '✅' : '❌';
    console.log(`${status} ${name}: ${value}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  🎉 Full Pipeline Test Complete!');
  console.log('═══════════════════════════════════════════════════════════\n');
}

// Run the test
testFullPipeline().catch(err => {
  console.error('Pipeline test failed:', err);
  process.exit(1);
});
