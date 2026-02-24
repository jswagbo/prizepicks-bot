/**
 * Positional Defense Module
 *
 * Fetches NBA team defense vs position data using the NBA stats API endpoint
 * `leaguedashteamstats` with `MeasureType=Opponent` to get opponent stats per team.
 *
 * Maps stat types to positions (Points → PG/SG/SF/PF/C based on player) and
 * returns a grade (A-F) for how much a team gives up to that position.
 *
 * Falls back gracefully if the data isn't available.
 */

import { getDatabase } from '../core/db/database';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PositionalDefenseData {
  team: string;
  position: string;
  statType: string;
  allowedPerGame: number;
  rank: number; // 1 = best defense (allows least), 30 = worst defense (allows most)
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
let lastFetched = 0;

// ─── Position Mapping ────────────────────────────────────────────────────────

/**
 * Map a player's listed position to a defensive position category.
 * NBA.com tracks defense against 5 positions: PG, SG, SF, PF, C
 */
function normalizePosition(position: string): string {
  const pos = position.toUpperCase().trim();

  // Handle multi-position players (e.g., "PG-SG", "SF-PF")
  if (pos.includes('PG')) return 'PG';
  if (pos.includes('SG') || pos.includes('G')) return 'SG';  // Generic "G" → SG
  if (pos.includes('SF') || pos.includes('F')) return 'SF';  // Generic "F" → SF (most common)
  if (pos.includes('PF')) return 'PF';
  if (pos.includes('C')) return 'C';

  // Fallbacks for unusual position formats
  if (pos.includes('GUARD')) return 'SG';
  if (pos.includes('FORWARD')) return 'SF';
  if (pos.includes('CENTER')) return 'C';

  // Default fallback
  return 'SF'; // Most generic position
}

/**
 * Map a stat type to the most relevant position for defense tracking.
 * Some stats are more position-specific than others.
 */
function getRelevantPositionForStat(statType: string, playerPosition: string): string {
  const stat = statType.toLowerCase();
  const pos = normalizePosition(playerPosition);

  // Position-specific stats
  if (stat.includes('block')) {
    // Blocks are primarily from big men (PF, C)
    return ['PF', 'C'].includes(pos) ? pos : 'C';
  }

  if (stat.includes('assist')) {
    // Assists are primarily from guards (PG, SG)
    return ['PG', 'SG'].includes(pos) ? pos : 'PG';
  }

  if (stat.includes('3-pt') || stat.includes('three')) {
    // 3-pointers are from all positions but more common from guards/forwards
    return ['PG', 'SG', 'SF'].includes(pos) ? pos : 'SG';
  }

  if (stat.includes('rebound')) {
    // Rebounds are primarily from big men
    return ['PF', 'C'].includes(pos) ? pos : 'PF';
  }

  // For general stats (points, steals, turnovers, fantasy), use player's actual position
  return pos;
}

// ─── NBA Stats API Integration ───────────────────────────────────────────────

/**
 * Fetch team defense vs position data from NBA.com stats API.
 * This is complex because the API doesn't directly provide "defense vs position" data.
 * We need to approximate it using opponent stats and player tracking data.
 *
 * For now, this is a placeholder that falls back to general team defense rankings.
 * A full implementation would require tracking individual player matchups.
 */
async function fetchPositionalDefenseData(): Promise<PositionalDefenseData[]> {
  const db = getDatabase();

  // Check if we have cached data within TTL
  const cached = db.prepare(`
    SELECT team, position, stat_type, allowed_per_game, rank, grade, updated_at
    FROM positional_defense_cache
    WHERE updated_at > datetime('now', '-24 hours')
  `).all() as Array<{
    team: string;
    position: string;
    stat_type: string;
    allowed_per_game: number;
    rank: number;
    grade: string;
    updated_at: string;
  }>;

  if (cached.length > 100) { // Expect ~150 entries (30 teams × 5 positions)
    console.log(`[PositionalDefense] Using cached data (${cached.length} entries)`);
    return cached.map(row => ({
      team: row.team,
      position: row.position,
      statType: row.stat_type,
      allowedPerGame: row.allowed_per_game,
      rank: row.rank,
      grade: row.grade as 'A' | 'B' | 'C' | 'D' | 'F',
    }));
  }

  // TODO: Implement actual NBA.com API fetching for positional defense
  // This would require:
  // 1. Fetching player tracking data for each team
  // 2. Aggregating how many points/rebounds/assists each team allows by position
  // 3. Ranking teams 1-30 for each stat + position combination
  //
  // For now, we'll fall back to general team defense rankings and extrapolate

  console.log('[PositionalDefense] TODO: Implement NBA.com positional defense fetching');
  console.log('[PositionalDefense] Falling back to general team defense rankings');

  // Return empty for now - this will trigger graceful fallback behavior
  return [];
}

// ─── Database Schema ─────────────────────────────────────────────────────────

/**
 * Create the positional defense cache table if it doesn't exist.
 * This will store team defense grades for each position and stat type.
 */
function ensurePositionalDefenseTable(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS positional_defense_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team TEXT NOT NULL,
      position TEXT NOT NULL,
      stat_type TEXT NOT NULL,
      allowed_per_game REAL NOT NULL,
      rank INTEGER NOT NULL,
      grade TEXT NOT NULL CHECK (grade IN ('A', 'B', 'C', 'D', 'F')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (team, position, stat_type)
    );

    CREATE INDEX IF NOT EXISTS idx_positional_defense_team_pos
    ON positional_defense_cache(team, position, stat_type);
  `);
}

// ─── Grading ─────────────────────────────────────────────────────────────────

/**
 * Convert a defensive rank to a matchup grade.
 * Lower rank = better defense = harder matchup for offense = worse grade for OVER bets
 *
 * Rank 1-6: F (elite defense, bad for offense)
 * Rank 7-12: D
 * Rank 13-18: C (average)
 * Rank 19-24: B
 * Rank 25-30: A (worst defense, great for offense)
 */
function rankToGrade(rank: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (rank <= 6) return 'F';    // Elite defense
  if (rank <= 12) return 'D';   // Good defense
  if (rank <= 18) return 'C';   // Average defense
  if (rank <= 24) return 'B';   // Below average defense
  return 'A';                   // Poor defense (great for offense)
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get positional defense grade for a team vs a specific position and stat type.
 * Returns A-F grade where A = team gives up a lot (good for OVER), F = stingy defense (good for UNDER).
 *
 * @param team - Opponent team abbreviation (e.g., "LAL", "BOS")
 * @param position - Player position (e.g., "PG", "SF", "C")
 * @param statType - Stat category (e.g., "Points", "Rebounds", "Assists")
 * @returns Defense grade A-F, defaults to 'C' if no data available
 */
export async function getPositionalDefenseGrade(
  team: string,
  position: string,
  statType: string
): Promise<string> {
  try {
    // Ensure database table exists
    ensurePositionalDefenseTable();

    // Normalize inputs
    const normalizedPos = normalizePosition(position);
    const relevantPos = getRelevantPositionForStat(statType, position);

    // Try to fetch data (will fall back gracefully)
    const data = await fetchPositionalDefenseData();

    // Look for exact match
    const match = data.find(d =>
      d.team === team &&
      d.position === relevantPos &&
      d.statType === statType
    );

    if (match) {
      console.log(
        `[PositionalDefense] ${team} vs ${relevantPos} ${statType}: ` +
        `allows ${match.allowedPerGame}/game (rank ${match.rank}) → grade ${match.grade}`
      );
      return match.grade;
    }

    // Fallback: use general team defense ranking if available
    const db = getDatabase();
    const generalDefense = db.prepare(`
      SELECT rank FROM team_defense_rankings
      WHERE team = ? AND stat_type = ?
    `).get(team, statType) as { rank: number } | undefined;

    if (generalDefense) {
      const grade = rankToGrade(generalDefense.rank);
      console.log(
        `[PositionalDefense] ${team} vs ${relevantPos} ${statType}: ` +
        `fallback to general defense rank ${generalDefense.rank} → grade ${grade}`
      );
      return grade;
    }

    // Final fallback
    console.log(
      `[PositionalDefense] ${team} vs ${relevantPos} ${statType}: ` +
      `no data available → default grade C`
    );
    return 'C';

  } catch (err) {
    console.error(
      `[PositionalDefense] Error getting defense grade for ${team} vs ${position} ${statType}:`,
      err instanceof Error ? err.message : String(err)
    );
    return 'C'; // Default to average
  }
}

/**
 * Convert defense grade to a scoring adjustment.
 * A = bad defense (boost OVER), F = elite defense (boost UNDER).
 *
 * @param grade - Defense grade A-F
 * @returns Adjustment factor for scoring (+/- decimal)
 */
export function defenseGradeToAdjustment(grade: string): number {
  switch (grade) {
    case 'A': return +0.02;  // Bad defense → +2% OVER boost
    case 'B': return +0.01;  // Below avg → +1% OVER boost
    case 'C': return 0;      // Average → neutral
    case 'D': return -0.01;  // Good defense → -1% UNDER boost
    case 'F': return -0.02;  // Elite defense → -2% UNDER boost
    default: return 0;
  }
}