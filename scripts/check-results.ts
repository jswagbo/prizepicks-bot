/**
 * Check Results — Resolves yesterday's picks against actual box scores
 *
 * Runs updatePickResults for yesterday, then outputs a scorecard to stdout.
 *
 * Usage: npx tsx scripts/check-results.ts [YYYY-MM-DD]
 * Exit codes: 0 = success, 1 = failure
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { initializeDatabase, getDatabase } from '../src/core/db/database';
import { updatePickResults } from '../src/prizepicks/results-tracker';

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  initializeDatabase({ path: path.resolve(__dirname, '../data/fund.db') });
  const db = getDatabase();

  // Default to yesterday
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const date = process.argv[2] || yesterday.toISOString().split('T')[0];

  console.error(`Checking results for ${date}...`);

  // Update pick results from ESPN box scores
  const updatedCount = await updatePickResults(date);
  console.error(`Updated ${updatedCount} pick(s) with actual results`);

  // Build scorecard from DB
  const picks = db.prepare(`
    SELECT player_name, stat_type, line, pick, confidence, ev_estimate,
           actual_result, hit, pinnacle_line, pinnacle_edge
    FROM prizepicks_picks
    WHERE date = ?
    ORDER BY ev_estimate DESC
  `).all(date) as Array<{
    player_name: string;
    stat_type: string;
    line: number;
    pick: string;
    confidence: number;
    ev_estimate: number;
    actual_result: number | null;
    hit: number | null;
    pinnacle_line: number | null;
    pinnacle_edge: number | null;
  }>;

  if (picks.length === 0) {
    console.error(`No picks found for ${date}`);
    process.exit(0);
  }

  // Compute stats
  const dnps = picks.filter((p) => p.actual_result === -1 && p.hit === null);
  const resolved = picks.filter((p) => p.hit !== null);
  const hits = resolved.filter((p) => p.hit === 1);
  const misses = resolved.filter((p) => p.hit === 0);
  const pending = picks.filter((p) => p.hit === null && p.actual_result !== -1);

  // Build scorecard
  const lines: string[] = [];
  lines.push(`# Results Scorecard — ${date}\n`);

  if (resolved.length > 0) {
    const hitRate = ((hits.length / resolved.length) * 100).toFixed(1);
    lines.push(`## Summary`);
    lines.push(`- Record: **${hits.length}-${misses.length}** (${hitRate}% hit rate)`);
    lines.push(`- Resolved: ${resolved.length}/${picks.length}`);
    if (pending.length > 0) lines.push(`- Pending: ${pending.length}`);
    if (dnps.length > 0) lines.push(`- Voided (DNP): ${dnps.length}`);
    lines.push('');
  }

  lines.push(`## Pick-by-Pick\n`);
  lines.push(`| # | Player | Stat | Line | Pick | Actual | Result | Edge |`);
  lines.push(`|---|--------|------|------|------|--------|--------|------|`);

  picks.forEach((p, i) => {
    const isDnp = p.actual_result === -1 && p.hit === null;
    const actual = isDnp ? 'DNP' : p.actual_result !== null ? p.actual_result.toString() : '—';
    const result = isDnp ? 'VOID' : p.hit === null ? 'PENDING' : p.hit === 1 ? 'HIT' : 'MISS';
    const emoji = isDnp ? '🚫' : p.hit === null ? '⏳' : p.hit === 1 ? '✅' : '❌';
    const edge = p.pinnacle_edge !== null ? `${(p.pinnacle_edge * 100).toFixed(1)}%` : '—';
    lines.push(
      `| ${i + 1} | ${p.player_name} | ${p.stat_type} | ${p.line} | ${p.pick} | ${actual} | ${emoji} ${result} | ${edge} |`
    );
  });

  lines.push('');

  // By confidence breakdown
  if (resolved.length > 0) {
    lines.push(`## By Confidence\n`);
    for (let c = 5; c >= 1; c--) {
      const confPicks = resolved.filter((p) => p.confidence === c);
      if (confPicks.length === 0) continue;
      const confHits = confPicks.filter((p) => p.hit === 1).length;
      const rate = ((confHits / confPicks.length) * 100).toFixed(0);
      lines.push(`- ${'\u2B50'.repeat(c)}: ${confHits}/${confPicks.length} (${rate}%)`);
    }
    lines.push('');
  }

  // All-time stats
  try {
    const allTime = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END) as hits
      FROM prizepicks_picks
      WHERE hit IS NOT NULL AND pinnacle_line IS NOT NULL
    `).get() as { total: number; hits: number };

    if (allTime.total > 0) {
      const rate = ((allTime.hits / allTime.total) * 100).toFixed(1);
      lines.push(`## All-Time: ${allTime.hits}/${allTime.total} (${rate}%)`);
    }
  } catch {
    // Non-fatal
  }

  const scorecard = lines.join('\n');
  console.log(scorecard);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Results check failed:', err);
    process.exit(1);
  });
