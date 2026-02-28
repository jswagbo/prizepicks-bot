/**
 * Generate Report — Reads today's picks from DB and formats a markdown report
 *
 * Annotates each pick with Covers.com expert agreement/disagreement.
 * Outputs the report to stdout AND saves to the memory file.
 *
 * Usage: npx tsx scripts/generate-report.ts [YYYY-MM-DD]
 * Exit codes: 0 = success, 1 = failure
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { initializeDatabase, getDatabase } from '../src/core/db/database';
import {
  checkCoversAlignment,
  getCoversExpertPicks,
} from '../src/prizepicks/covers-intel';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DBPick {
  id: number;
  date: string;
  player_name: string;
  team: string;
  opponent: string;
  league: string;
  stat_type: string;
  line: number;
  pick: string;
  confidence: number;
  ev_estimate: number;
  reasoning: string;
  last5_avg: number | null;
  last10_avg: number | null;
  season_avg: number | null;
  matchup_grade: string | null;
  home_away: string | null;
  pinnacle_line: number | null;
  pinnacle_edge: number | null;
  sharp_projection: number | null;
  vegas_total: number | null;
  team_total: number | null;
  game_spread: number | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function confidenceStars(c: number): string {
  return '\u2B50'.repeat(c);
}

function edgePercent(edge: number | null): string {
  if (edge === null || edge === 0) return 'N/A';
  return `${edge > 0 ? '+' : ''}${(edge * 100).toFixed(1)}%`;
}

async function formatPick(pick: DBPick, rank: number): Promise<string> {
  const lines: string[] = [];
  lines.push(
    `**${rank}. ${pick.player_name} — ${pick.stat_type} ${pick.pick} ${pick.line}**`
  );

  // Pinnacle edge
  if (pick.pinnacle_line !== null) {
    lines.push(
      `- Pinnacle: ${pick.pinnacle_line} vs PP ${pick.line} -> ${edgePercent(pick.pinnacle_edge)} edge`
    );
  } else {
    lines.push(`- Pinnacle: N/A`);
  }

  // Confidence
  lines.push(
    `- Confidence: ${confidenceStars(pick.confidence)} | Edge: ${pick.ev_estimate.toFixed(4)}`
  );

  // Matchup context
  const parts: string[] = [];
  if (pick.opponent) parts.push(`vs ${pick.opponent}`);
  if (parts.length > 0) lines.push(`- Matchup: ${parts.join(' | ')}`);

  // Covers expert alignment
  try {
    const alignment = await checkCoversAlignment(
      pick.player_name,
      pick.stat_type,
      pick.pick as 'OVER' | 'UNDER'
    );
    if (alignment) {
      if (alignment.alignment === 'agree') {
        lines.push(`- \uD83D\uDD12 Covers agrees (${alignment.expertName})`);
      } else {
        lines.push(
          `- \u26A0\uFE0F Covers contradicts (${alignment.expertName})`
        );
      }
    }
  } catch {
    // Non-fatal — skip Covers annotation
  }

  // Reasoning
  if (pick.reasoning) {
    const sentences = pick.reasoning.split('. ').slice(0, 3).join('. ');
    lines.push(`- Why: ${sentences}`);
  }

  return lines.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  initializeDatabase({ path: path.resolve(__dirname, '../data/fund.db') });
  const db = getDatabase();

  const date = process.argv[2] || new Date().toISOString().split('T')[0];

  // Fetch picks for the date
  const picks = db
    .prepare(
      `
    SELECT * FROM prizepicks_picks
    WHERE date = ?
    ORDER BY ev_estimate DESC
  `
    )
    .all(date) as DBPick[];

  if (picks.length === 0) {
    console.error(`No picks found for ${date}. Run daily-pipeline.ts first.`);
    process.exit(1);
  }

  // Pre-fetch Covers picks (single call, cached)
  await getCoversExpertPicks().catch(() => []);

  // Build report
  const report: string[] = [];
  report.push(`# PrizePicks Daily Report — ${date}\n`);

  // Games section
  const gamesSet = new Map<string, DBPick>();
  for (const p of picks) {
    const key = [p.team, p.opponent].sort().join(' vs ');
    if (!gamesSet.has(key)) gamesSet.set(key, p);
  }
  report.push(`## Today's Games\n`);
  for (const [matchup] of gamesSet) {
    report.push(`- ${matchup}`);
  }
  report.push('');

  // Top picks with Covers annotations
  report.push(`## Top ${picks.length} Value Picks\n`);
  for (let i = 0; i < picks.length; i++) {
    const formatted = await formatPick(picks[i], i + 1);
    report.push(formatted);
    report.push('');
  }

  // Top 10 Pinnacle Divergences
  const allPicks = db
    .prepare(
      `
    SELECT * FROM prizepicks_picks
    WHERE date = ? AND pinnacle_line IS NOT NULL AND pinnacle_edge IS NOT NULL
    ORDER BY ABS(pinnacle_edge) DESC
    LIMIT 10
  `
    )
    .all(date) as DBPick[];

  report.push(`## Top 10 Pinnacle Divergences\n`);
  if (allPicks.length === 0) {
    report.push(`_No picks with Pinnacle data for ${date}._`);
  } else {
    report.push(`| # | Player | Stat | PP Line | Pinnacle | Edge | Pick |`);
    report.push(`|---|--------|------|---------|----------|------|------|`);
    allPicks.forEach((p, i) => {
      const dir = p.pinnacle_edge! > 0 ? 'OVER' : 'UNDER';
      report.push(
        `| ${i + 1} | ${p.player_name} | ${p.stat_type} | ${p.line} | ${p.pinnacle_line} | ${edgePercent(p.pinnacle_edge)} | ${dir} |`
      );
    });
  }
  report.push('');

  // Best Play of the Day
  const edgePicks = db
    .prepare(
      `
    SELECT * FROM prizepicks_picks
    WHERE date = ? AND pinnacle_edge IS NOT NULL AND pinnacle_edge != 0
    ORDER BY ABS(pinnacle_edge) DESC
  `
    )
    .all(date) as DBPick[];

  report.push(`## \uD83C\uDFAF Best Play of the Day\n`);

  if (edgePicks.length === 0) {
    report.push(
      `_No Pinnacle-edge picks available. No recommended play._\n`
    );
  } else {
    let playType: string;
    let playPicks: DBPick[];
    let payout: string;
    let breakEven: string;

    if (edgePicks.length >= 6) {
      playType = '6-Man Flex';
      playPicks = edgePicks.slice(0, 6);
      payout = 'Up to 25x';
      breakEven = '54.25%';
    } else if (edgePicks.length >= 5) {
      playType = '5-Man Flex';
      playPicks = edgePicks.slice(0, 5);
      payout = 'Up to 10x';
      breakEven = '54.25%';
    } else if (edgePicks.length >= 4) {
      playType = '4-Man Power';
      playPicks = edgePicks.slice(0, 4);
      payout = '10x';
      breakEven = '56.2%';
    } else if (edgePicks.length >= 3) {
      playType = '3-Man Power';
      playPicks = edgePicks.slice(0, 3);
      payout = '5x';
      breakEven = '58.5%';
    } else {
      playType = '2-Man Power';
      playPicks = edgePicks.slice(0, 2);
      payout = '3x';
      breakEven = '57.7%';
    }

    report.push(
      `**${playType}** (${playPicks.length} Pinnacle-edge picks) | Payout: ${payout} | Break-even: ${breakEven}\n`
    );
    report.push(`| # | Player | Stat | Line | Pick | Pinnacle Edge |`);
    report.push(`|---|--------|------|------|------|---------------|`);
    playPicks.forEach((p, i) => {
      report.push(
        `| ${i + 1} | ${p.player_name} | ${p.stat_type} | ${p.line} | ${p.pick} | ${edgePercent(p.pinnacle_edge)} |`
      );
    });

    if (edgePicks.length === 1) {
      report.push(
        `\n_Only 1 Pinnacle-edge pick — not enough for a parlay. Consider a straight play or wait for more data._`
      );
    }
  }
  report.push('');

  // Performance stats (last 7 days)
  try {
    const perf = db
      .prepare(
        `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END) as hits,
        SUM(CASE WHEN hit = 0 THEN 1 ELSE 0 END) as misses
      FROM prizepicks_picks
      WHERE hit IS NOT NULL AND date >= date('now', '-7 days')
    `
      )
      .get() as { total: number; hits: number; misses: number };

    if (perf.total > 0) {
      const rate = ((perf.hits / perf.total) * 100).toFixed(1);
      report.push(`## Last 7 Days Performance\n`);
      report.push(`- Record: ${perf.hits}-${perf.misses} (${rate}% hit rate)`);
      report.push('');
    }
  } catch {
    // Non-fatal
  }

  const reportText = report.join('\n');

  // Output to stdout
  console.log(reportText);

  // Save to memory file
  const outputPath = `/Users/jeffnwagbo/clawd/memory/prizepicks-report-${date}.md`;
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, reportText, 'utf-8');
  console.error(`Report saved to ${outputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Report generation failed:', err);
    process.exit(1);
  });
