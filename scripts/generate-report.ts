/**
 * Generate Report — Pure Pinnacle edge report with correlation flags and Covers annotations
 *
 * Sections:
 *   1. Top 10 Pinnacle Divergences (sorted by |edge|, with Covers & correlation flags)
 *   2. Correlation Alerts (same-game pairs)
 *   3. Best Play of the Day (parlay with correlation warnings)
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
  pinnacle_line: number | null;
  pinnacle_edge: number | null;
  covers_flag: string | null;
}

interface CorrelationGroup {
  label: string; // A, B, C...
  gameKey: string; // "LAL vs BOS"
  pickIndices: number[]; // 1-indexed rank in the table
  note: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function edgePercent(edge: number | null): string {
  if (edge === null || edge === 0) return 'N/A';
  return `${edge > 0 ? '+' : ''}${(edge * 100).toFixed(1)}%`;
}

function coversDisplay(flag: string | null): string {
  if (flag === 'agrees') return '🔒 Agrees';
  if (flag === 'contradicts') return '⚠️ Contradicts';
  return '—';
}

/**
 * Detect same-game correlation groups among picks.
 * Two picks are in the same game if team A plays opponent B and team B plays opponent A,
 * or they share the same team.
 */
function detectCorrelations(picks: DBPick[]): CorrelationGroup[] {
  // Build a normalized game key for each pick: sorted pair of (team, opponent)
  const gameKeyFor = (p: DBPick): string => {
    if (!p.team || !p.opponent) return '';
    return [p.team, p.opponent].sort().join(' vs ');
  };

  // Group picks by game key
  const gameGroups = new Map<string, number[]>();
  picks.forEach((p, i) => {
    const key = gameKeyFor(p);
    if (!key) return;
    if (!gameGroups.has(key)) gameGroups.set(key, []);
    gameGroups.get(key)!.push(i + 1); // 1-indexed
  });

  // Only keep groups with 2+ picks (actual correlations)
  const groups: CorrelationGroup[] = [];
  let labelIdx = 0;

  for (const [gameKey, indices] of gameGroups) {
    if (indices.length < 2) continue;
    const label = String.fromCharCode(65 + labelIdx); // A, B, C...
    labelIdx++;

    // Build a descriptive note about the correlation
    const gamePicks = indices.map((idx) => picks[idx - 1]);
    const notes: string[] = [];

    // Check for same-team pairs
    for (let a = 0; a < gamePicks.length; a++) {
      for (let b = a + 1; b < gamePicks.length; b++) {
        const pA = gamePicks[a];
        const pB = gamePicks[b];
        const idxA = indices[a];
        const idxB = indices[b];

        if (pA.team === pB.team) {
          // Same team
          if (pA.pick === pB.pick) {
            notes.push(
              `Picks ${idxA} & ${idxB} are same team (${pA.team}) both ${pA.pick} — positively correlated`
            );
          } else {
            notes.push(
              `Picks ${idxA} & ${idxB} are same team (${pA.team}) opposite directions — negatively correlated`
            );
          }
        } else {
          notes.push(
            `Picks ${idxA} & ${idxB} are from the same game (${gameKey})`
          );
        }
      }
    }

    groups.push({
      label,
      gameKey,
      pickIndices: indices,
      note: notes.join('\n'),
    });
  }

  return groups;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  initializeDatabase({ path: path.resolve(__dirname, '../data/fund.db') });
  const db = getDatabase();

  const date = process.argv[2] || new Date().toISOString().split('T')[0];

  // Fetch all picks with Pinnacle edge != 0 for the date
  const picks = db
    .prepare(
      `
    SELECT * FROM prizepicks_picks
    WHERE date = ? AND pinnacle_line IS NOT NULL AND pinnacle_edge IS NOT NULL AND pinnacle_edge != 0
    ORDER BY ABS(pinnacle_edge) DESC
  `
    )
    .all(date) as DBPick[];

  if (picks.length === 0) {
    console.error(
      `No Pinnacle-edge picks found for ${date}. Run daily-pipeline.ts first.`
    );
    process.exit(1);
  }

  const top10 = picks.slice(0, 10);

  // Detect correlations among top 10
  const correlations = detectCorrelations(top10);

  // Build a lookup: pick rank (1-indexed) -> correlation label
  const corrLabelMap = new Map<number, string>();
  for (const g of correlations) {
    for (const idx of g.pickIndices) {
      corrLabelMap.set(idx, g.label);
    }
  }

  // ─── Build Report ────────────────────────────────────────────────────────

  const report: string[] = [];
  report.push(`# PrizePicks Daily Report — ${date}\n`);

  // Section 1: Top 10 Pinnacle Divergences
  report.push(`## Top 10 Pinnacle Divergences\n`);
  report.push(
    `| # | Player | Stat | PP Line | Pinnacle | Edge | Pick | Covers | Corr |`
  );
  report.push(
    `|---|--------|------|---------|----------|------|------|--------|------|`
  );

  top10.forEach((p, i) => {
    const rank = i + 1;
    const corr = corrLabelMap.get(rank) || '—';
    report.push(
      `| ${rank} | ${p.player_name} | ${p.stat_type} | ${p.line} | ${p.pinnacle_line} | ${edgePercent(p.pinnacle_edge)} | ${p.pick} | ${coversDisplay(p.covers_flag)} | ${corr} |`
    );
  });
  report.push('');

  // Section 2: Correlation Alerts
  if (correlations.length > 0) {
    report.push(`## Correlation Alerts\n`);
    for (const g of correlations) {
      const lines = g.note.split('\n');
      for (const line of lines) {
        report.push(`ℹ️ [${g.label}] ${line}`);
      }
    }
    report.push('');
  }

  // Section 3: Best Play of the Day
  report.push(`## 🎯 Best Play of the Day\n`);

  let playType: string;
  let playPicks: DBPick[];
  let payout: string;
  let breakEven: string;

  if (picks.length >= 6) {
    playType = '6-Man Flex';
    playPicks = picks.slice(0, 6);
    payout = 'Up to 25x';
    breakEven = '54.25%';
  } else if (picks.length >= 5) {
    playType = '5-Man Flex';
    playPicks = picks.slice(0, 5);
    payout = 'Up to 10x';
    breakEven = '54.25%';
  } else if (picks.length >= 4) {
    playType = '4-Man Power';
    playPicks = picks.slice(0, 4);
    payout = '10x';
    breakEven = '56.2%';
  } else if (picks.length >= 3) {
    playType = '3-Man Power';
    playPicks = picks.slice(0, 3);
    payout = '5x';
    breakEven = '58.5%';
  } else if (picks.length >= 2) {
    playType = '2-Man Power';
    playPicks = picks.slice(0, 2);
    payout = '3x';
    breakEven = '57.7%';
  } else {
    report.push(
      `_Only 1 Pinnacle-edge pick — not enough for a parlay. Consider a straight play or wait for more data._\n`
    );
    playPicks = [];
    playType = '';
    payout = '';
    breakEven = '';
  }

  if (playPicks.length >= 2) {
    report.push(
      `**${playType}** (${playPicks.length} picks) | Payout: ${payout} | Break-even: ${breakEven}\n`
    );

    // Detect correlations within the parlay picks specifically
    const parlayCorrelations = detectCorrelations(playPicks);

    report.push(
      `| # | Player | Stat | PP Line | Pinnacle | Edge | Pick | Covers |`
    );
    report.push(
      `|---|--------|------|---------|----------|------|------|--------|`
    );
    playPicks.forEach((p, i) => {
      report.push(
        `| ${i + 1} | ${p.player_name} | ${p.stat_type} | ${p.line} | ${p.pinnacle_line} | ${edgePercent(p.pinnacle_edge)} | ${p.pick} | ${coversDisplay(p.covers_flag)} |`
      );
    });

    if (parlayCorrelations.length > 0) {
      report.push('');
      report.push(`**⚠️ Correlation warning in parlay:**`);
      for (const g of parlayCorrelations) {
        const lines = g.note.split('\n');
        for (const line of lines) {
          report.push(`- ${line}`);
        }
      }
    }
  }
  report.push('');

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
