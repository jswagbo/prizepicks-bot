/**
 * Daily Pipeline — Standalone data pipeline script
 *
 * Fetches PrizePicks NBA projections, scores them against Pinnacle lines,
 * ranks by edge, saves top 10 to database, builds a parlay, and outputs
 * a JSON summary to stdout.
 *
 * Usage: npx tsx scripts/daily-pipeline.ts
 * Exit codes: 0 = success, 1 = failure
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Redirect ALL console output to stderr so stdout is reserved for JSON only.
// Imported modules (odds-service, nba-stats, etc.) may use console.log internally.
const _origLog = console.log;
console.log = (...args: unknown[]) => console.error(...args);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { getProjections } from '../src/prizepicks/prizepicks-client';
import { getTodaysGames } from '../src/prizepicks/nba-stats-client';
import { analyzeMatchup } from '../src/prizepicks/matchup-analyzer';
import {
  scoreProjection,
  rankProjections,
  buildParlay,
  savePicks,
  type ScoredPick,
} from '../src/prizepicks/pick-scorer';
import { initializeDatabase, getDatabase } from '../src/core/db/database';

// ─── Config ──────────────────────────────────────────────────────────────────

const TARGET_STATS = [
  'Points', 'Rebounds', 'Assists', 'Pts+Rebs+Asts',
  '3-PT Made', 'Fantasy Score', 'Blks+Stls',
];
const MAX_PER_TEAM_FLOOR = 4;
const SAMPLE_TARGET = 80;
const THROTTLE_MS = 500;
const ERROR_BACKOFF_MS = 1000;
const TOP_N = 10;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildTeamLookups(games: Array<{ homeTeam: string; awayTeam: string; spread: number | null }>) {
  const spreadByTeam: Record<string, number | null> = {};
  const homeAwayByTeam: Record<string, 'home' | 'away'> = {};
  const opponentByTeam: Record<string, string> = {};

  for (const g of games) {
    spreadByTeam[g.homeTeam] = g.spread;
    spreadByTeam[g.awayTeam] = g.spread ? -g.spread : null;
    homeAwayByTeam[g.homeTeam] = 'home';
    homeAwayByTeam[g.awayTeam] = 'away';
    opponentByTeam[g.homeTeam] = g.awayTeam;
    opponentByTeam[g.awayTeam] = g.homeTeam;
  }

  return { spreadByTeam, homeAwayByTeam, opponentByTeam };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Initialize database
  initializeDatabase({ path: path.resolve(__dirname, '../data/fund.db') });

  // 1. Fetch projections
  const projections = await getProjections('NBA');
  console.error(`NBA projections: ${projections.length}`);
  if (projections.length === 0) {
    throw new Error('No NBA projections returned — PrizePicks API may be down');
  }

  // 2. Fetch today's games + spreads
  const games = await getTodaysGames();
  console.error(`Games today: ${games.length}`);
  if (games.length === 0) {
    throw new Error('No games found for today');
  }

  const { spreadByTeam, homeAwayByTeam, opponentByTeam } = buildTeamLookups(games);

  // 3. Filter to standard, team-level, target stat types
  const filtered = projections.filter(
    (p) =>
      p.oddsType === 'standard' &&
      p.eventType === 'team' &&
      TARGET_STATS.some((s) => p.statType.includes(s))
  );
  console.error(`Filtered projections: ${filtered.length}`);

  // 4. Sample evenly across teams for game diversity
  const byTeam: Record<string, typeof filtered> = {};
  for (const p of filtered) {
    if (!byTeam[p.team]) byTeam[p.team] = [];
    byTeam[p.team].push(p);
  }

  const maxPerTeam = Math.max(MAX_PER_TEAM_FLOOR, Math.floor(SAMPLE_TARGET / Object.keys(byTeam).length));
  const sampled: typeof filtered = [];
  for (const team of Object.keys(byTeam)) {
    sampled.push(...byTeam[team].slice(0, maxPerTeam));
  }
  console.error(`Sampled: ${sampled.length} from ${Object.keys(byTeam).length} teams (max ${maxPerTeam}/team)`);

  // 5. Analyze + score each projection
  const analyzed: ScoredPick[] = [];
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
      await sleep(THROTTLE_MS);
    } catch (e) {
      console.error(`Skip ${proj.playerName}: ${(e as Error).message}`);
      await sleep(ERROR_BACKOFF_MS);
    }
  }

  if (analyzed.length === 0) {
    throw new Error('No projections scored — pipeline failed');
  }

  // 5b. Filter to picks with Pinnacle data
  const withPinnacle = analyzed.filter((p) => p.pinnacleLine !== null && p.pinnacleLine !== undefined);
  console.error(`Pinnacle data: ${withPinnacle.length}/${analyzed.length} scored picks have Pinnacle lines`);

  if (withPinnacle.length === 0) {
    throw new Error('No picks with Pinnacle data — cannot rank');
  }

  // 6. Rank (only Pinnacle-backed picks)
  const ranked = rankProjections(withPinnacle);

  // 7. Save top N to database
  const today = new Date().toISOString().split('T')[0];
  const db = getDatabase();
  db.prepare('DELETE FROM prizepicks_picks WHERE date = ?').run(today);
  const toSave = ranked.slice(0, TOP_N);
  savePicks(today, toSave);
  console.error(`Saved ${toSave.length} picks to DB for ${today}`);

  // 8. Validate DB save
  const savedCount = (
    db.prepare('SELECT COUNT(*) as count FROM prizepicks_picks WHERE date = ?').get(today) as { count: number }
  ).count;
  if (savedCount === 0) {
    throw new Error('DB validation failed: no picks saved');
  }
  console.error(`DB validation: ${savedCount} picks confirmed for ${today}`);

  // 9. Build parlay
  const parlay = buildParlay(ranked.slice(0, 15));

  // 10. Output JSON summary to stdout
  const summary = {
    date: today,
    totalProjections: projections.length,
    gamesCount: games.length,
    sampledCount: sampled.length,
    analyzedCount: analyzed.length,
    savedCount,
    spreads: spreadByTeam,
    topPicks: ranked.slice(0, 20).map((p) => ({
      playerName: p.projection.playerName,
      team: p.projection.team,
      statType: p.projection.statType,
      ppLine: p.ppLine,
      pick: p.pick,
      confidence: p.confidence,
      totalScore: p.totalScore,
      ev: p.ev,
      pinnacleLine: p.pinnacleLine,
      pinnacleEdge: p.pinnacleEdge,
      vegasTotal: p.vegasTotal,
      sharpProjection: p.sharpProjection,
      reasoning: p.reasoning,
    })),
    parlay: {
      picks: parlay.picks.map((p) => ({
        playerName: p.projection.playerName,
        statType: p.projection.statType,
        ppLine: p.ppLine,
        pick: p.pick,
        confidence: p.confidence,
      })),
      combinedConfidence: parlay.combinedConfidence,
      correlationNote: parlay.correlationNote,
    },
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Pipeline failed:', err);
    process.exit(1);
  });
