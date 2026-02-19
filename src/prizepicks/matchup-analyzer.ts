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
  opponentDefenseRank: number | null;
  matchupGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  estimatedLine: number;
  prizePicksLine: number;
  edge: number; // positive = OVER edge, negative = UNDER edge
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
  const col = statTypeToColumn(statType);
  return (row[col] as number) || 0;
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
  homeAway: 'home' | 'away'
): Promise<MatchupAnalysis> {
  const db = getDatabase();

  // Fetch game logs from DB
  const gameLogs = db.prepare(`
    SELECT * FROM player_game_logs
    WHERE player_name = ? AND league = 'NBA'
    ORDER BY game_date DESC
  `).all(playerName) as Array<Record<string, unknown>>;

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

  // Get opponent defensive rank for this stat
  const defenseRow = db.prepare(`
    SELECT rank FROM team_defense_rankings
    WHERE team = ? AND league = 'NBA' AND stat_type = ?
  `).get(opponent, statType) as { rank: number } | undefined;

  const opponentDefenseRank = defenseRow?.rank ?? null;
  const matchupGrade = rankToGrade(opponentDefenseRank);

  // Estimated line: weighted average (recent games weighted more)
  const estimatedLine = last5Avg * 0.5 + last10Avg * 0.3 + seasonAvg * 0.2;

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
    opponentDefenseRank,
    matchupGrade,
    estimatedLine: Math.round(estimatedLine * 100) / 100,
    prizePicksLine,
    edge: Math.round(edge * 10000) / 10000,
  };
}
