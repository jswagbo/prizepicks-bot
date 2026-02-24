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
  
  // Shooting attempt stats
  if (lower.includes('two pointers attempted') || lower === '2pa') {
    return ((row.field_goals_attempted as number) || 0) - ((row.three_pointers_attempted as number) || 0);
  }
  if (lower.includes('two pointers made') || lower === '2pm') {
    return ((row.field_goals_made as number) || 0) - ((row.three_pointers_made as number) || 0);
  }
  if (lower.includes('field goals attempted') || lower === 'fga') {
    return (row.field_goals_attempted as number) || 0;
  }
  if (lower.includes('field goals made') || lower === 'fgm') {
    return (row.field_goals_made as number) || 0;
  }
  if (lower.includes('3-pt attempted') || lower.includes('three pointers attempted') || lower === '3pa') {
    return (row.three_pointers_attempted as number) || 0;
  }
  if (lower.includes('free throws attempted') || lower === 'fta') {
    return (row.free_throws_attempted as number) || 0;
  }
  if (lower.includes('free throws made') || lower === 'ftm') {
    return (row.free_throws_made as number) || 0;
  }
  
  const col = statTypeToColumn(statType);
  return (row[col] as number) || 0;
}

// ─── Pace Factor (Live from NBA.com Stats API) ─────────────────────────────

const NBA_TEAM_ABBREV: Record<string, string> = {
  'Atlanta Hawks':'ATL','Boston Celtics':'BOS','Brooklyn Nets':'BKN','Charlotte Hornets':'CHA',
  'Chicago Bulls':'CHI','Cleveland Cavaliers':'CLE','Dallas Mavericks':'DAL','Denver Nuggets':'DEN',
  'Detroit Pistons':'DET','Golden State Warriors':'GS','Houston Rockets':'HOU','Indiana Pacers':'IND',
  'LA Clippers':'LAC','Los Angeles Lakers':'LAL','Memphis Grizzlies':'MEM','Miami Heat':'MIA',
  'Milwaukee Bucks':'MIL','Minnesota Timberwolves':'MIN','New Orleans Pelicans':'NO',
  'New York Knicks':'NY','Oklahoma City Thunder':'OKC','Orlando Magic':'ORL',
  'Philadelphia 76ers':'PHI','Phoenix Suns':'PHX','Portland Trail Blazers':'POR',
  'Sacramento Kings':'SAC','San Antonio Spurs':'SA','Toronto Raptors':'TOR',
  'Utah Jazz':'UTAH','Washington Wizards':'WSH',
};

// In-memory cache for pace data (refreshed max once per 12h)
let cachedPace: Record<string, number> | null = null;
let cachedLeagueAvgPace = 100.0;
let paceLastFetched = 0;
const PACE_CACHE_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Fetch team pace ratings from NBA.com stats API.
 * Caches in memory for 12 hours, falls back to DB cache if API fails.
 */
export async function fetchTeamPace(): Promise<{ pace: Record<string, number>; leagueAvg: number }> {
  const now = Date.now();
  if (cachedPace && (now - paceLastFetched) < PACE_CACHE_MS) {
    return { pace: cachedPace, leagueAvg: cachedLeagueAvgPace };
  }

  const db = getDatabase();

  // Try DB cache first (< 24h old)
  const dbCached = db.prepare(`
    SELECT team, pace FROM team_pace_ratings WHERE updated_at > datetime('now', '-24 hours')
  `).all() as Array<{ team: string; pace: number }>;

  if (dbCached.length >= 25) {
    cachedPace = {};
    let sum = 0;
    for (const r of dbCached) {
      cachedPace[r.team] = r.pace;
      sum += r.pace;
    }
    cachedLeagueAvgPace = sum / dbCached.length;
    paceLastFetched = now;
    console.log(`[pace] Loaded ${dbCached.length} teams from DB cache`);
    return { pace: cachedPace, leagueAvg: cachedLeagueAvgPace };
  }

  // Fetch from NBA.com stats API
  try {
    const url = 'https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=0&LeagueID=00&Location=&MeasureType=Advanced&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=2025-26&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=';
    const res = await fetch(url, {
      headers: {
        'Referer': 'https://www.nba.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'x-nba-stats-origin': 'stats',
        'x-nba-stats-token': 'true',
      },
      signal: AbortSignal.timeout(10000),
    });

    const data: any = await res.json();
    const headers = data.resultSets[0].headers as string[];
    const paceIdx = headers.indexOf('PACE');
    const nameIdx = headers.indexOf('TEAM_NAME');
    const rows = data.resultSets[0].rowSet;

    if (paceIdx < 0 || rows.length === 0) throw new Error('PACE column not found');

    cachedPace = {};
    let sum = 0;
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO team_pace_ratings (team, pace, updated_at) VALUES (?, ?, datetime('now'))
    `);

    for (const r of rows) {
      const abbrev = NBA_TEAM_ABBREV[r[nameIdx]] || r[nameIdx];
      const pace = r[paceIdx] as number;
      cachedPace[abbrev] = pace;
      sum += pace;
      upsert.run(abbrev, pace);
    }

    cachedLeagueAvgPace = sum / rows.length;
    paceLastFetched = now;
    console.log(`[pace] Fetched ${rows.length} teams from NBA.com (avg: ${cachedLeagueAvgPace.toFixed(2)})`);
    return { pace: cachedPace, leagueAvg: cachedLeagueAvgPace };
  } catch (e: any) {
    console.error(`[pace] NBA.com fetch failed: ${e.message}, using fallback`);
    // Return whatever we have (even stale DB data or empty)
    if (dbCached.length > 0) {
      cachedPace = {};
      let sum = 0;
      for (const r of dbCached) {
        cachedPace[r.team] = r.pace;
        sum += r.pace;
      }
      cachedLeagueAvgPace = sum / dbCached.length;
      paceLastFetched = now;
      return { pace: cachedPace, leagueAvg: cachedLeagueAvgPace };
    }
    return { pace: {}, leagueAvg: 100.0 };
  }
}

/**
 * Map PrizePicks team abbreviations → internal abbreviations (NBA_TEAM_ABBREV values).
 * PrizePicks uses different short codes than our NBA.com pace data / game list for some teams.
 *
 * Use normalizePPTeamAbbrev() everywhere you go from a PP projection to internal data.
 */
export const PP_TO_INTERNAL_ABBREV: Record<string, string> = {
  'SAS': 'SA',    // San Antonio Spurs: PP=SAS, internal=SA
  'NYK': 'NY',    // New York Knicks: PP=NYK, internal=NY
  'UTA': 'UTAH',  // Utah Jazz: PP=UTA, internal=UTAH
  'WAS': 'WSH',   // Washington Wizards: PP=WAS, internal=WSH
  'NOP': 'NO',    // New Orleans Pelicans: PP=NOP, internal=NO
  'GSW': 'GS',    // Golden State Warriors: PP=GSW, internal=GS
};

/**
 * Normalize a PrizePicks team abbreviation to the internal abbreviation used for
 * pace data lookups, game list matching, and team defense rankings.
 */
export function normalizePPTeamAbbrev(ppTeam: string): string {
  return PP_TO_INTERNAL_ABBREV[ppTeam] ?? ppTeam;
}

function normalizePaceAbbrev(team: string): string {
  return normalizePPTeamAbbrev(team);
}

/**
 * Calculate pace adjustment for a game.
 * Returns: (gamePace / leagueAvgPace - 1)
 * Positive = faster pace (boost OVERs), negative = slower pace (boost UNDERs)
 * NOTE: Uses cached pace data. Call fetchTeamPace() once before scoring pipeline.
 */
export function calculatePaceAdjustment(team1: string, team2: string): number {
  const leagueAvg = cachedLeagueAvgPace || 100.0;
  const pace1 = cachedPace?.[normalizePaceAbbrev(team1)] ?? leagueAvg;
  const pace2 = cachedPace?.[normalizePaceAbbrev(team2)] ?? leagueAvg;
  const gamePace = (pace1 + pace2) / 2;
  return (gamePace / leagueAvg) - 1;
}

/**
 * Adjust a raw statistical average for pace.
 * Makes the model smarter about fast vs slow matchups by scaling projections
 * based on expected game pace vs league average.
 *
 * Formula: adjustedAvg = rawAvg * (expectedGamePace / leagueAvgPace)
 * where expectedGamePace = (playerTeamPace + opponentPace) / 2
 *
 * @param rawAvg - Raw statistical average (L5, L10, season, etc.)
 * @param playerTeamPace - Pace rating for the player's team
 * @param opponentPace - Pace rating for the opponent team
 * @param leagueAvgPace - League average pace (for normalization)
 * @returns Pace-adjusted average
 */
export function paceAdjust(
  rawAvg: number,
  playerTeamPace: number,
  opponentPace: number,
  leagueAvgPace: number
): number {
  if (rawAvg <= 0 || leagueAvgPace <= 0) {
    return rawAvg;
  }

  const expectedGamePace = (playerTeamPace + opponentPace) / 2;
  const paceMultiplier = expectedGamePace / leagueAvgPace;
  const adjustedAvg = rawAvg * paceMultiplier;

  // Log significant pace adjustments (>3% change)
  if (Math.abs(paceMultiplier - 1) > 0.03) {
    const changePercent = ((paceMultiplier - 1) * 100).toFixed(1);
    console.log(
      `[PaceAdjust] Expected pace ${expectedGamePace.toFixed(1)} vs league avg ${leagueAvgPace.toFixed(1)} ` +
      `→ ${rawAvg.toFixed(1)} becomes ${adjustedAvg.toFixed(1)} (${changePercent}% ${paceMultiplier > 1 ? 'boost' : 'reduction'})`
    );
  }

  return Math.round(adjustedAvg * 100) / 100; // Round to 2 decimal places
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
