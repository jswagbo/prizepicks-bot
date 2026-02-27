/**
 * Generate Report — Reads today's picks from DB and formats a markdown report
 *
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

function formatPick(pick: DBPick, rank: number): string {
  const lines: string[] = [];
  lines.push(`**${rank}. ${pick.player_name} — ${pick.stat_type} ${pick.pick} ${pick.line}**`);

  // Pinnacle edge
  if (pick.pinnacle_line !== null) {
    lines.push(`- Pinnacle: ${pick.pinnacle_line} vs PP ${pick.line} -> ${edgePercent(pick.pinnacle_edge)} edge`);
  } else {
    lines.push(`- Pinnacle: N/A`);
  }

  // Vegas total
  if (pick.vegas_total !== null) {
    const level = pick.vegas_total > 228 ? 'high' : pick.vegas_total < 215 ? 'low' : 'neutral';
    lines.push(`- Vegas total: ${pick.vegas_total} (${level})`);
  }

  // Team total
  if (pick.team_total !== null) {
    lines.push(`- Team total: ${pick.team_total}`);
  }

  // Sharp projection
  if (pick.sharp_projection !== null) {
    const direction = pick.sharp_projection > pick.line ? 'OVER' : 'UNDER';
    lines.push(`- Sharp projection: ${pick.sharp_projection.toFixed(1)} (${direction})`);
  }

  // Score + EV
  lines.push(`- Confidence: ${confidenceStars(pick.confidence)} | EV: ${pick.ev_estimate.toFixed(4)}`);

  // Blowout risk
  if (pick.game_spread !== null) {
    const absSpread = Math.abs(pick.game_spread);
    if (absSpread >= 8) {
      lines.push(`- Blowout risk: ${absSpread.toFixed(1)}pt spread`);
    } else {
      lines.push(`- Spread: ${absSpread.toFixed(1)}pt (no blowout risk)`);
    }
  }

  // Matchup context
  const parts: string[] = [];
  if (pick.opponent) parts.push(`vs ${pick.opponent}`);
  if (pick.home_away) parts.push(pick.home_away.toUpperCase());
  if (pick.matchup_grade) parts.push(`Grade: ${pick.matchup_grade}`);
  if (parts.length > 0) lines.push(`- Matchup: ${parts.join(' | ')}`);

  // Reasoning (first 2 sentences)
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
  const picks = db.prepare(`
    SELECT * FROM prizepicks_picks
    WHERE date = ?
    ORDER BY ev_estimate DESC
  `).all(date) as DBPick[];

  if (picks.length === 0) {
    console.error(`No picks found for ${date}. Run daily-pipeline.ts first.`);
    process.exit(1);
  }

  // Build report
  const report: string[] = [];
  report.push(`# PrizePicks Daily Report — ${date}\n`);

  // Games section
  const gamesSet = new Map<string, DBPick>();
  for (const p of picks) {
    const key = [p.team, p.opponent].sort().join(' vs ');
    if (!gamesSet.has(key)) gamesSet.set(key, p);
  }
  report.push(`## Today's Games + Spreads\n`);
  for (const [matchup, pick] of gamesSet) {
    const spread = pick.game_spread !== null ? `spread: ${pick.game_spread}` : 'spread: N/A';
    const total = pick.vegas_total !== null ? `O/U: ${pick.vegas_total}` : '';
    report.push(`- ${matchup} | ${spread} ${total}`);
  }
  report.push('');

  // Top picks
  report.push(`## Top ${picks.length} Value Picks\n`);
  picks.forEach((pick, i) => {
    report.push(formatPick(pick, i + 1));
    report.push('');
  });

  // Line divergences — sorted by absolute Pinnacle edge
  const withEdge = picks
    .filter((p) => p.pinnacle_line !== null && p.pinnacle_edge !== null && p.pinnacle_edge !== 0)
    .sort((a, b) => Math.abs(b.pinnacle_edge!) - Math.abs(a.pinnacle_edge!));

  if (withEdge.length > 0) {
    report.push(`## Top Line Divergences (Pinnacle vs PrizePicks)\n`);
    for (const p of withEdge.slice(0, 10)) {
      const dir = p.pinnacle_edge! > 0 ? 'OVER' : 'UNDER';
      report.push(
        `- ${p.player_name} — ${p.stat_type}: Pinnacle ${p.pinnacle_line} vs PP ${p.line} -> ${edgePercent(p.pinnacle_edge)} ${dir} edge`
      );
    }
    report.push('');
  }

  // Performance stats (last 7 days)
  try {
    const perf = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END) as hits,
        SUM(CASE WHEN hit = 0 THEN 1 ELSE 0 END) as misses
      FROM prizepicks_picks
      WHERE hit IS NOT NULL AND date >= date('now', '-7 days')
    `).get() as { total: number; hits: number; misses: number };

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
