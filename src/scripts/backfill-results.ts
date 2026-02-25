/**
 * Backfill historical PrizePicks results
 *
 * Reads saved report files, parses top picks, inserts them into
 * prizepicks_picks, then grades them against ESPN box scores.
 */

import * as fs from 'fs';
import * as path from 'path';
import { initializeDatabase, getDatabase } from '../core/db/database';
import { updatePickResults } from '../prizepicks/results-tracker';

// ─── Report File Config ────────────────────────────────────────────────────────

const MEMORY_DIR = '/Users/jeffnwagbo/clawd/memory';

const REPORT_FILES: Array<{ date: string; file: string }> = [
  { date: '2026-02-20', file: 'prizepicks-report-2026-02-20-v2.md' },
  { date: '2026-02-21', file: 'prizepicks-report-2026-02-21-v2.md' },
  { date: '2026-02-22', file: 'prizepicks-report-2026-02-22-final.md' },
  { date: '2026-02-23', file: 'prizepicks-report-2026-02-23.md' },
  { date: '2026-02-24', file: 'prizepicks-report-2026-02-24.md' },
];

// ─── Stat Type Normalization ─────────────────────────────────────────────────

/**
 * Normalize stat type from report text to standard PrizePicks stat type names
 */
function normalizeStatType(raw: string): string {
  const s = raw.trim();
  const map: Record<string, string> = {
    'Points': 'Points',
    'Rebounds': 'Rebounds',
    'Assists': 'Assists',
    'Steals': 'Steals',
    'Blocks': 'Blocks',
    'Turnovers': 'Turnovers',
    'Pts+Rebs+Asts': 'Pts+Rebs+Asts',
    'PRA': 'Pts+Rebs+Asts',
    'Pts+Rebs': 'Pts+Rebs',
    'Pts+Asts': 'Pts+Asts',
    'Rebs+Asts': 'Rebs+Asts',
    'Rebounds + Assists': 'Rebs+Asts',
    'Blks+Stls': 'Blks+Stls',
    'Blocks + Steals': 'Blks+Stls',
    '3-PT Made': '3-PT Made',
    '3PT Made': '3-PT Made',
    '3-Point Made': '3-PT Made',
    '3 PT Made': '3-PT Made',
    'Fantasy Score': 'Fantasy Score',
    'Free Throws Attempted': 'Free Throws Attempted',
    'Free Throws Made': 'Free Throws Made',
    'FG Attempted': 'FG Attempted',
    'Two Pointers Attempted': 'Two Pointers Attempted',
    'Offensive Rebounds': 'Offensive Rebounds',
  };

  // Direct lookup
  if (map[s]) return map[s];

  // Case-insensitive lookup
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === s.toLowerCase()) return v;
  }

  // Return as-is if no match found
  return s;
}

// ─── Pick Parsing ────────────────────────────────────────────────────────────

interface ParsedPick {
  playerName: string;
  statType: string;
  direction: 'OVER' | 'UNDER';
  line: number;
}

function parsePicksFromReport(content: string): ParsedPick[] {
  const picks: ParsedPick[] = [];
  const seen = new Set<string>(); // deduplicate by player+stat+direction

  // Match lines like:
  //   ### 1. Tyler Herro (MIA) — Points OVER 16.5
  //   ### 🔒 2. Kevin Porter Jr (MIL) — Rebounds + Assists OVER 12.5
  //   **1. Austin Reaves — Offensive Rebounds OVER 0.5**
  //   ### **1. Nolan Traore (BKN) — Pts+Rebs+Asts UNDER 18.5**
  // Match em-dash (—) or en-dash (–) as separator, NOT regular hyphen (to avoid "Karl-Anthony" split)
  const regex = /(?:###\s*(?:[^\d]*?)|\*\*)\s*(\d+)\.\s*(.+?)\s*[—–]\s*(.+?)\s+(OVER|UNDER)\s+([\d.]+)/gi;

  let match: RegExpExecArray | null;
  let rankCount = 0;

  while ((match = regex.exec(content)) !== null) {
    const rankNum = parseInt(match[1], 10);
    // Only take ranks 1-5 (top 5 picks)
    if (rankNum > 5) continue;

    let playerName = match[2].trim();
    const rawStat = match[3].trim();
    const direction = match[4].toUpperCase() as 'OVER' | 'UNDER';
    const line = parseFloat(match[5]);

    // Strip team acronym in parens: "Tyler Herro (MIA)" → "Tyler Herro"
    playerName = playerName.replace(/\s*\([A-Z]{2,4}\)\s*$/, '').trim();

    // Strip markdown bold: **Player Name** → Player Name
    playerName = playerName.replace(/\*\*/g, '').trim();

    // Strip emoji prefixes: "🔒 Austin" → "Austin"
    playerName = playerName.replace(/^[\u{1F300}-\u{1FFFF}\u{2600}-\u{27FF}\uFE00-\uFEFF\s]+/u, '').trim();

    // Strip trailing markers: "(if available)", "(-114)", "✅ SHARP ALIGNED"
    const statCleaned = rawStat.replace(/\s*\(.*?\)\s*/g, '').trim();

    if (!playerName || isNaN(line)) continue;

    const statType = normalizeStatType(statCleaned);
    const key = `${playerName}|${statType}|${direction}`;
    if (seen.has(key)) continue;
    seen.add(key);

    picks.push({ playerName, statType, direction, line });
    rankCount++;
  }

  return picks;
}

// ─── Database Insert ─────────────────────────────────────────────────────────

function insertPickIfMissing(
  date: string,
  pick: ParsedPick
): boolean {
  const db = getDatabase();

  // Check if already exists
  const existing = db.prepare(`
    SELECT id FROM prizepicks_picks
    WHERE date = ? AND player_name = ? AND stat_type = ?
  `).get(date, pick.playerName, pick.statType);

  if (existing) return false;

  db.prepare(`
    INSERT INTO prizepicks_picks
      (date, player_name, league, stat_type, line, pick, confidence)
    VALUES (?, ?, 'NBA', ?, ?, ?, 4)
  `).run(date, pick.playerName, pick.statType, pick.line, pick.direction);

  return true;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  initializeDatabase({ path: '/Users/jeffnwagbo/prizepicks-bot/data/fund.db' });

  let totalInserted = 0;
  let totalGraded = 0;
  let totalHits = 0;
  const dateResults: Array<{ date: string; inserted: number; graded: number; hits: number }> = [];

  for (const { date, file } of REPORT_FILES) {
    const filePath = path.join(MEMORY_DIR, file);

    if (!fs.existsSync(filePath)) {
      console.log(`[${date}] Report not found: ${file} — skipping`);
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const picks = parsePicksFromReport(content);

    console.log(`\n[${date}] Parsed ${picks.length} picks from ${file}`);
    picks.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.playerName} — ${p.statType} ${p.direction} ${p.line}`);
    });

    // Insert picks that aren't already in DB
    let inserted = 0;
    for (const pick of picks) {
      if (insertPickIfMissing(date, pick)) {
        inserted++;
        console.log(`  ✅ Inserted: ${pick.playerName} ${pick.statType} ${pick.direction} ${pick.line}`);
      } else {
        console.log(`  ⏭️  Already exists: ${pick.playerName} ${pick.statType}`);
      }
    }
    totalInserted += inserted;

    // Grade picks against ESPN box scores
    console.log(`  📊 Grading picks for ${date}...`);
    try {
      const graded = await updatePickResults(date);
      console.log(`  ✅ Graded: ${graded} picks`);
      totalGraded += graded;

      // Count hits for this date
      const db = getDatabase();
      const summary = db.prepare(`
        SELECT COUNT(*) as total, SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END) as hits
        FROM prizepicks_picks
        WHERE date = ? AND hit IS NOT NULL
      `).get(date) as { total: number; hits: number };

      totalHits += summary.hits || 0;
      dateResults.push({ date, inserted, graded, hits: summary.hits || 0 });
    } catch (e) {
      console.error(`  ❌ Failed to grade ${date}:`, (e as Error).message);
      dateResults.push({ date, inserted, graded: 0, hits: 0 });
    }
  }

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('BACKFILL SUMMARY');
  console.log('═'.repeat(60));

  for (const r of dateResults) {
    console.log(`  ${r.date}: inserted=${r.inserted}, graded=${r.graded}, hits=${r.hits}`);
  }

  console.log('\nTotals:');
  console.log(`  Total picks backfilled: ${totalInserted}`);
  console.log(`  Total picks graded:     ${totalGraded}`);
  console.log(`  Hit rate:               ${totalGraded > 0 ? ((totalHits / totalGraded) * 100).toFixed(1) : 'N/A'}%`);

  // Overall DB stats
  const db = getDatabase();
  const overall = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END) as hits,
           ROUND(100.0 * SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as pct
    FROM prizepicks_picks
    WHERE hit IS NOT NULL
  `).get() as { total: number; hits: number; pct: number };

  console.log('\nAll-time graded picks:');
  console.log(`  Total: ${overall.total}, Hits: ${overall.hits}, Hit rate: ${overall.pct ?? 'N/A'}%`);
}

main().catch(console.error);
