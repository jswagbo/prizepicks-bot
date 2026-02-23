import { getProjections, getTodaysGames, analyzeMatchup, scoreProjection } from './src/prizepicks';
import { getInjuryReport, getTeamInjuryImpact } from './src/prizepicks/injury-news-client';
import { getExpertPicks, getConsensusForPick } from './src/prizepicks/expert-picks-client';
import { rankProjections, buildParlay, type ScoredPick } from './src/prizepicks/pick-scorer';
import { getTeamDefenseRankings } from './src/prizepicks/nba-stats-client';
import { fetchTeamPace } from './src/prizepicks/matchup-analyzer';
import { writeFileSync } from 'fs';

async function main() {
  console.log('=== STEP 1: Fetch Data ===');
  
  const [games, projections, injuries, expertPicks, defenseRankings] = await Promise.all([
    getTodaysGames(),
    getProjections('NBA'),
    getInjuryReport().catch(e => { console.error('Injury fetch failed:', e.message); return []; }),
    getExpertPicks().catch(e => { console.error('Expert picks failed:', e.message); return []; }),
    getTeamDefenseRankings().catch(e => { console.error('Defense rankings fetch failed:', e.message); return []; }),
    fetchTeamPace().catch(e => { console.error('Pace fetch failed:', e.message); return { pace: {}, leagueAvg: 100 }; }),
  ]);

  console.log(`Defense rankings: ${defenseRankings.length} entries`);

  console.log(`Games: ${games.length}`);
  console.log(`Projections: ${projections.length}`);
  console.log(`Injuries: ${injuries.length}`);
  console.log(`Expert picks: ${expertPicks.length}`);

  // Validation
  if (games.length === 0) { console.error('NO GAMES - ABORTING'); process.exit(1); }
  if (projections.length === 0) { console.error('NO PROJECTIONS - ABORTING'); process.exit(1); }
  if (projections.length > 10000) { console.error(`TOO MANY PROJECTIONS (${projections.length}) - FILTER BROKEN`); process.exit(1); }

  console.log('\n=== STEP 2: Score Projections ===');
  
  const scored: ScoredPick[] = [];
  let processed = 0;
  
  for (const proj of projections) {
    try {
      // Find the game this player is in
      const game = games.find(g => 
        g.homeTeam === proj.team || g.awayTeam === proj.team
      );
      
      if (!game) continue; // Skip if we can't find the game
      
      const opponent = game.homeTeam === proj.team ? game.awayTeam : game.homeTeam;
      const homeAway = game.homeTeam === proj.team ? 'home' : 'away';
      
      const matchup = await analyzeMatchup(
        proj.playerName,
        proj.statType,
        opponent,
        proj.line,
        homeAway,
        game.spread
      );
      const pick = await scoreProjection(proj, matchup, injuries);
      scored.push(pick);
    } catch (e: any) {
      // skip silently (can uncomment for debugging)
      // console.error(`Error scoring ${proj.playerName} ${proj.statType}:`, e.message);
    }
    processed++;
    if (processed % 500 === 0) console.log(`  Processed ${processed}/${projections.length}`);
  }

  console.log(`Scored: ${scored.length} picks`);

  const ranked = rankProjections(scored);
  const top20 = ranked.slice(0, 20);
  const top5 = ranked.slice(0, 5);
  const parlay = buildParlay(ranked.slice(0, 15));

  // Find trap picks (sharp money disagrees)
  const traps = ranked
    .filter(p => p.sharpSignal === 'DISAGREE' && Math.abs(p.totalScore) > 0.03)
    .slice(0, 5);

  // Injured players affecting games
  const outPlayers = injuries.filter(i => i.status === 'Out');

  console.log('\n=== STEP 3: Generate Report ===');

  const stars = (n: number) => '⭐'.repeat(n) + '☆'.repeat(5 - n);

  let report = `# 🏀 PrizePicks Daily Report — February 21, 2026\n\n`;
  report += `> Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PST\n`;
  report += `> ${games.length} NBA games | ${projections.length} standard projections analyzed | ${scored.length} scored\n\n`;

  // Slate
  report += `## 📋 Today's Slate\n\n`;
  report += `| Game | Spread | O/U |\n|------|--------|-----|\n`;
  for (const g of games) {
    const spread = g.spread !== null && g.spread !== undefined ? `${g.awayTeam} ${g.spread > 0 ? '+' : ''}${g.spread}` : 'N/A';
    const ou = g.total !== null && g.total !== undefined ? `${g.total}` : 'N/A';
    report += `| ${g.awayTeam} @ ${g.homeTeam} | ${spread} | ${ou} |\n`;
  }
  report += `\n`;

  // Top 5
  report += `## 🔥 Top 5 Value Picks\n\n`;
  for (let i = 0; i < top5.length; i++) {
    const p = top5[i];
    const dir = p.pick;
    const absSpread = p.matchup.gameSpread ? Math.abs(p.matchup.gameSpread) : 0;
    const blowoutNote = absSpread >= 8 && dir === 'OVER' ? ' ⚠️ BLOWOUT RISK' : '';
    const injuryTag = p.playerInjured ? ` 🏥 ${p.playerInjuryStatus || 'Injured'}` : '';
    report += `### ${i + 1}. ${p.projection.playerName}${injuryTag} — ${p.projection.statType} ${dir} ${p.projection.line}${blowoutNote}\n`;
    report += `${stars(p.confidence)} (${p.confidence}/5) | EV: ${(p.ev * 100).toFixed(1)}% | Score: ${p.totalScore.toFixed(4)}\n\n`;
    report += `- **Model Line:** ${p.matchup.estimatedLine} vs **PP Line:** ${p.projection.line}\n`;
    report += `- **Matchup:** ${p.matchup.matchupGrade} grade vs ${p.matchup.opponent}\n`;
    report += `- **Trends:** L3: ${p.matchup.last3Avg} | L10: ${p.matchup.last10Avg} | SZN: ${p.matchup.seasonAvg}\n`;
    if (p.playerInjured) report += `- **⚠️ INJURY:** ${p.playerInjuryStatus} — ${p.injuryContext || 'Check status before playing'}\n`;
    else if (p.injuryContext) report += `- **Injury:** ${p.injuryContext}\n`;
    if (p.expertConsensus) report += `- **Experts:** ${p.expertConsensus}\n`;
    report += `- **Reasoning:** ${p.reasoning}\n\n`;
  }

  // Lock picks (confidence 5)
  const locks = ranked.filter(p => p.confidence >= 5).slice(0, 3);
  report += `## 🔒 Lock Picks\n\n`;
  if (locks.length === 0) {
    const nearLocks = ranked.filter(p => p.confidence >= 4).slice(0, 3);
    report += `No 5-star locks today. Best high-confidence picks (4+ stars):\n\n`;
    for (const p of nearLocks) {
      const injTag = p.playerInjured ? ` 🏥 ${p.playerInjuryStatus}` : '';
      report += `- **${p.projection.playerName}**${injTag} ${p.projection.statType} ${p.pick} ${p.projection.line} ${stars(p.confidence)} — ${p.reasoning.slice(0, 100)}\n`;
    }
  } else {
    for (const p of locks) {
      const injTag = p.playerInjured ? ` 🏥 ${p.playerInjuryStatus}` : '';
      report += `- **${p.projection.playerName}**${injTag} ${p.projection.statType} ${p.pick} ${p.projection.line} ${stars(p.confidence)} — ${p.reasoning.slice(0, 100)}\n`;
    }
  }
  report += `\n`;

  // Parlay
  report += `## 🎰 Best 4-Pick Parlay\n\n`;
  if (parlay && parlay.picks) {
    for (const p of parlay.picks) {
      const injTag = p.playerInjured ? ` 🏥 ${p.playerInjuryStatus}` : '';
      report += `- **${p.projection.playerName}**${injTag} ${p.projection.statType} ${p.pick} ${p.projection.line} (${stars(p.confidence)})\n`;
    }
    report += `\n*Strategy: Uncorrelated games to minimize variance*\n\n`;
  }

  // Traps
  report += `## 🚫 Trap Picks (Avoid)\n\n`;
  if (traps.length === 0) {
    report += `No significant sharp-vs-model disagreements today.\n\n`;
  } else {
    for (const p of traps) {
      report += `- **${p.projection.playerName}** ${p.projection.statType} ${p.pick} ${p.projection.line} — ${p.expertConsensus || 'Sharp money disagrees'}\n`;
    }
    report += `\n`;
  }

  // Injury Impact
  report += `## 🏥 Injury Impact\n\n`;
  if (outPlayers.length === 0) {
    report += `No major injuries reported via ESPN today.\n\n`;
  } else {
    for (const inj of outPlayers.slice(0, 15)) {
      report += `- **${inj.playerName}** (${inj.team}) — ${inj.status}: ${inj.description}\n`;
    }
    report += `\n`;
  }

  // Sharp money
  const sharpAgree = ranked.filter(p => p.sharpSignal === 'AGREE').slice(0, 5);
  report += `## 💰 Sharp Money Signals\n\n`;
  if (sharpAgree.length === 0) {
    report += `No strong sharp money signals detected today.\n\n`;
  } else {
    for (const p of sharpAgree) {
      report += `- **${p.projection.playerName}** ${p.projection.statType} ${p.pick} — Sharp money agrees ✓\n`;
    }
    report += `\n`;
  }

  // Blowout games
  const blowoutGames = games.filter(g => g.spread && Math.abs(g.spread) >= 8);
  if (blowoutGames.length > 0) {
    report += `## ⚠️ Blowout Alert\n\n`;
    report += `Games with spread ≥ 8 pts (OVER picks penalized):\n\n`;
    for (const g of blowoutGames) {
      report += `- **${g.awayTeam} @ ${g.homeTeam}** — Spread: ${g.spread}\n`;
    }
    report += `\n`;
  }

  report += `---\n*Report generated by PrizePicks Bot v2 | Standard lines only | Blowout penalty active*\n`;

  const outPath = '/Users/jeffnwagbo/clawd/memory/prizepicks-report-2026-02-21-v2.md';
  writeFileSync(outPath, report);
  console.log(`\nReport saved to ${outPath}`);
  console.log(`Report length: ${report.length} chars`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
