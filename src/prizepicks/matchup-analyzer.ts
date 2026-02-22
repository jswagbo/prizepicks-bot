/**
 * Matchup Analyzer
 * 
 * Computes matchup-based analysis for a player + stat_type + opponent.
 * Replaces "vibe check" with actual numbers.
 */

import { getDatabase } from '../core/db/database';
import { getPlayerAverages, getTeamDefenseRankings, type PlayerAverages } from './nba-stats-client';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MatchupAnalysis {
  playerName: string;
  statType: string;
  opponent: string;
  homeAway: 'home' | 'away';
  last5Avg: number;
  last10Avg: number;
  seasonAvg: number;
  last3Avg: number;
  ewma: number; // Exponentially weighted moving average (decay=0.85)
  opponentDefenseRank: number | null;
  matchupGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  estimatedLine: number;
  prizePicksLine: number;
  edge: number; // positive = OVER edge, negative = UNDER edge
  /** Absolute game spread (e.g., 13.5 means one team is a 13.5pt favorite). Null if unavailable. */
  gameSpread: number | null;
  /** Expected minutes based on L5 average minutes */
  expectedMinutes: number | null;
  /** Season average minutes */
  seasonAvgMinutes: number | null;
  /** Pace adjustment factor (gamePace / leagueAvgPace - 1) */
  paceAdjustment: number;
  /** Is the player's team on the 2nd night of a back-to-back? */
  isBackToBack: boolean;
}

// ─── Stat Type Mapping ───────────────────────────────────────────────────────

/** Map PrizePicks stat type to our DB column name */
function statTypeToColumn(statType: string): string {
  const map: Record<string, string> = {
    'Points': 'points',
    'Rebounds': 'rebounds',
    'Assists': 'assists',
    'Steals': 'steals',
    'Blocks': 'blocks',
    'Turnovers': 'turnovers',
    '3-PT Made': 'three_pointers_made',
    'Fantasy Score': 'fantasy_score',
    'Pts+Rebs+Asts': 'pts_rebs_asts',
    'Blks+Stls': 'blocks', // approximate — sum handled below
  };
  return map[statType] || statType.toLowerCase().replace(/[^a-z_]/g, '_');
}

/** Compute a stat value from a game log row (handles combo stats) */
function getStatValue(row: Record<string, unknown>, statType: string): number {
  const lower = statType.toLowerCase();
  if (lower.includes('blks+stls') || lower.includes('blocks+steals')) {
    return ((row.blocks as number) || 0) + ((row.steals as number) || 0);
  }
  if (lower.includes('pts+rebs+asts') || lower.includes('pts_rebs_asts')) {
    return ((row.pts_rebs_asts as number) || 0);
  }
  if (lower === 'pts+rebs') {
    return ((row.points as number) || 0) + ((row.rebounds as number) || 0);
  }
  if (lower === 'pts+asts') {
    return ((row.points as number) || 0) + ((row.assists as number) || 0);
  }
  if (lower === 'rebs+asts') {
    return ((row.rebounds as number) || 0) + ((row.assists as number) || 0);
  }
  
  // Handle defensive/offensive rebounds (estimate from total rebounds)
  // NBA average: ~75% defensive, ~25% offensive
  if (lower.includes('defensive rebounds') || lower === 'defensive_rebounds') {
    return ((row.rebounds as number) || 0) * 0.75;
  }
  if (lower.includes('offensive rebounds') || lower === 'offensive_rebounds') {
    return ((row.rebounds as number) || 0) * 0.25;
  }
  
  const col = statTypeToColumn(statType);
  return (row[col] as number) || 0;
}

// ─── Pace Factor (2025-26 NBA Pace Rankings) ────────────────────────────────

/** Team pace ratings (possessions per game, 2025-26 season) */
const TEAM_PACE: Record<string, number> = {
  'BOS': 102.5, 'IND': 103.2, 'GS': 101.8, 'SAC': 102.1, 'MEM': 101.5,
  'ATL': 100.9, 'MIN': 100.2, 'MIL': 100.7, 'PHX': 101.1, 'NO': 101.3,
  'OKC': 99.8, 'DEN': 99.5, 'LAL': 99.9, 'LAC': 99.2, 'DAL': 99.1,
  'HOU': 100.4, 'CLE': 98.8, 'TOR': 100.6, 'NY': 98.2, 'CHI': 99.3,
  'ORL': 98.5, 'PHI': 98.1, 'BKN': 99.7, 'MIA': 97.9, 'WSH': 100.8,
  'CHA': 100.3, 'DET': 99.4, 'POR': 100.1, 'SA': 101.0, 'UTAH': 99.6,
};

const LEAGUE_AVG_PACE = 100.0;

/**
 * Calculate pace adjustment for a game.
 * Returns: (gamePace / leagueAvgPace - 1)
 * Positive = faster pace (boost OVERs), negative = slower pace (boost UNDERs)
 */
export function calculatePaceAdjustment(team1: string, team2: string): number {
  const pace1 = TEAM_PACE[team1] ?? LEAGUE_AVG_PACE;
  const pace2 = TEAM_PACE[team2] ?? LEAGUE_AVG_PACE;
  const gamePace = (pace1 + pace2) / 2;
  return (gamePace / LEAGUE_AVG_PACE) - 1;
}

// ─── Exponential Weighted Moving Average ────────────────────────────────────

const EWMA_DECAY = 0.85;

/**
 * Calculate exponentially weighted moving average.
 * Recent games are weighted more heavily.
 * weight = decay^(games_ago), where games_ago starts at 0 for most recent.
 */
export function calculateEWMA(values: number[]): number {
  if (values.length === 0) return 0;
  
  let weightedSum = 0;
  let totalWeight = 0;
  
  for (let i = 0; i < values.length; i++) {
    const weight = Math.pow(EWMA_DECAY, i);
    weightedSum += values[i] * weight;
    totalWeight += weight;
  }
  
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

// ─── Back-to-Back Detection ──────────────────────────────────────────────────

/**
 * Check if a team played yesterday (back-to-back game).
 * Returns true if the team's most recent game was yesterday.
 */
export function isTeamOnBackToBack(teamAbbr: string): boolean {
  const db = getDatabase();
  
  // Get yesterday's date (YYYY-MM-DD)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  
  // Check if any player from this team played yesterday
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM player_game_logs
    WHERE (team = ? OR opponent = ?) AND game_date = ?
    LIMIT 1
  `).get(teamAbbr, teamAbbr, yesterdayStr) as { count: number } | undefined;
  
  return (result?.count ?? 0) > 0;
}

// ─── Minutes Projection ──────────────────────────────────────────────────────

/**
 * Calculate expected minutes based on recent games (L5 average).
 * Also returns season average minutes for comparison.
 */
export function calculateMinutesProjection(
  gameLogs: Array<Record<string, unknown>>
): { expectedMinutes: number | null; seasonAvgMinutes: number | null } {
  if (gameLogs.length === 0) {
    return { expectedMinutes: null, seasonAvgMinutes: null };
  }
  
  const allMinutes = gameLogs.map(log => (log.minutes as number) || 0).filter(m => m > 0);
  const l5Minutes = allMinutes.slice(0, 5);
  
  if (l5Minutes.length === 0) {
    return { expectedMinutes: null, seasonAvgMinutes: null };
  }
  
  const expectedMinutes = l5Minutes.reduce((sum, m) => sum + m, 0) / l5Minutes.length;
  const seasonAvgMinutes = allMinutes.reduce((sum, m) => sum + m, 0) / allMinutes.length;
  
  return {
    expectedMinutes: Math.round(expectedMinutes * 10) / 10,
    seasonAvgMinutes: Math.round(seasonAvgMinutes * 10) / 10,
  };
}

// ─── Stat-Specific Defense Rankings ──────────────────────────────────────────

/**
 * Map PrizePicks stat type to defensive stat category.
 * Returns the appropriate stat_type for looking up opponent defense rank.
 */
export function mapStatToDefenseCategory(statType: string): string {
  const lower = statType.toLowerCase();
  
  if (lower.includes('point') || lower === 'pts') return 'Points';
  if (lower.includes('rebound') || lower === 'reb') return 'Rebounds';
  if (lower.includes('assist') || lower === 'ast') return 'Assists';
  if (lower.includes('3-pt') || lower.includes('three') || lower === '3pm') return 'Three pointers made';
  if (lower.includes('steal') || lower === 'stl') return 'Steals';
  if (lower.includes('block') || lower === 'blk') return 'Blocks';
  
  // Combo stats — default to points defense
  if (lower.includes('pts+reb') || lower.includes('pts_reb')) return 'Points';
  
  return 'Points'; // fallback
}

/**
 * Get opponent's defensive rank for a specific stat type.
 * Returns null if not found.
 */
export function getStatSpecificDefenseRank(
  opponent: string,
  statType: string
): number | null {
  const db = getDatabase();
  const defenseCategory = mapStatToDefenseCategory(statType);
  
  const result = db.prepare(`
    SELECT rank FROM team_defense_rankings
    WHERE team = ? AND league = 'NBA' AND stat_type = ?
  `).get(opponent, defenseCategory) as { rank: number } | undefined;
  
  return result?.rank ?? null;
}

// ─── Matchup Grade ───────────────────────────────────────────────────────────

/**
 * Convert defensive rank to matchup grade.
 * Lower rank = better defense = harder matchup = worse grade.
 * 
 * Rank 1-6: F (elite defense)
 * Rank 7-12: D
 * Rank 13-18: C
 * Rank 19-24: B
 * Rank 25-30: A (worst defense = best matchup)
 */
function rankToGrade(rank: number | null): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (rank === null) return 'C'; // Unknown defaults to average
  if (rank <= 6) return 'F';
  if (rank <= 12) return 'D';
  if (rank <= 18) return 'C';
  if (rank <= 24) return 'B';
  return 'A';
}

// ─── Core Analysis ───────────────────────────────────────────────────────────

/**
 * Analyze a matchup: player + stat + opponent
 */
export async function analyzeMatchup(
  playerName: string,
  statType: string,
  opponent: string,
  prizePicksLine: number,
  homeAway: 'home' | 'away',
  gameSpread?: number | null,
  playerTeam?: string
): Promise<MatchupAnalysis> {
  const db = getDatabase();

  // Ensure player data is in DB (fetches from ESPN if missing)
  let gameLogs = db.prepare(`
    SELECT * FROM player_game_logs
    WHERE player_name = ? AND league = 'NBA'
    ORDER BY game_date DESC
  `).all(playerName) as Array<Record<string, unknown>>;

  // If no cached data, trigger a fetch via getPlayerAverages (which caches to DB)
  if (gameLogs.length === 0) {
    await getPlayerAverages(playerName, 20);
    gameLogs = db.prepare(`
      SELECT * FROM player_game_logs
      WHERE player_name = ? AND league = 'NBA'
      ORDER BY game_date DESC
    `).all(playerName) as Array<Record<string, unknown>>;
  }

  // Compute averages
  const computeAvg = (logs: Array<Record<string, unknown>>) => {
    if (logs.length === 0) return 0;
    const sum = logs.reduce((s, r) => s + getStatValue(r, statType), 0);
    return sum / logs.length;
  };

  const last3Avg = computeAvg(gameLogs.slice(0, 3));
  const last5Avg = computeAvg(gameLogs.slice(0, 5));
  const last10Avg = computeAvg(gameLogs.slice(0, 10));
  const seasonAvg = computeAvg(gameLogs);

  // Calculate EWMA (exponentially weighted moving average)
  const statValues = gameLogs.map(log => getStatValue(log, statType));
  const ewma = calculateEWMA(statValues);

  // Get stat-specific opponent defensive rank
  const opponentDefenseRank = getStatSpecificDefenseRank(opponent, statType);
  const matchupGrade = rankToGrade(opponentDefenseRank);

  // Calculate minutes projection
  const { expectedMinutes, seasonAvgMinutes } = calculateMinutesProjection(gameLogs);

  // Calculate pace adjustment (need both teams)
  const paceAdjustment = playerTeam
    ? calculatePaceAdjustment(playerTeam, opponent)
    : 0;

  // Detect back-to-back
  const isBackToBack = playerTeam ? isTeamOnBackToBack(playerTeam) : false;

  // Estimated line: now uses EWMA with minutes adjustment
  let estimatedLine = ewma;
  
  // Adjust for minutes differential (if expected minutes significantly differ from season avg)
  if (expectedMinutes !== null && seasonAvgMinutes !== null && seasonAvgMinutes > 0) {
    const minutesDiff = (expectedMinutes - seasonAvgMinutes) / seasonAvgMinutes;
    
    // Scale projection based on minutes: +20% minutes → +20% to estimated line
    if (Math.abs(minutesDiff) > 0.05) { // Only adjust if >5% difference
      estimatedLine *= (1 + minutesDiff);
    }
  }

  // Edge calculation
  const edge = prizePicksLine !== 0
    ? (estimatedLine - prizePicksLine) / prizePicksLine
    : 0;

  return {
    playerName,
    statType,
    opponent,
    homeAway,
    last3Avg: Math.round(last3Avg * 100) / 100,
    last5Avg: Math.round(last5Avg * 100) / 100,
    last10Avg: Math.round(last10Avg * 100) / 100,
    seasonAvg: Math.round(seasonAvg * 100) / 100,
    ewma: Math.round(ewma * 100) / 100,
    opponentDefenseRank,
    matchupGrade,
    estimatedLine: Math.round(estimatedLine * 100) / 100,
    prizePicksLine,
    edge: Math.round(edge * 10000) / 10000,
    gameSpread: gameSpread ?? null,
    expectedMinutes,
    seasonAvgMinutes,
    paceAdjustment: Math.round(paceAdjustment * 10000) / 10000,
    isBackToBack,
  };
}
