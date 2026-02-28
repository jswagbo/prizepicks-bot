/**
 * Pick Scorer — Pure Pinnacle Divergence Engine
 *
 * Score = ABS(pinnacle_edge). That's it.
 * Pinnacle is the sharpest sportsbook — when their line diverges from
 * PrizePicks, that's genuine market mispricing.
 *
 * Picks WITHOUT Pinnacle data get score 0 and are excluded from top picks.
 */

import { type PrizePicksProjection } from './prizepicks-client';
import { getDatabase } from '../core/db/database';
import { fetchPinnacleLines, type BookLine } from './odds-service';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScoredPick {
  projection: PrizePicksProjection;
  pick: 'OVER' | 'UNDER';
  confidence: number; // 1-5 stars
  ev: number; // absolute edge as decimal
  totalScore: number; // signed edge (positive = OVER, negative = UNDER)
  reasoning: string;
  /** PrizePicks line for this projection */
  ppLine: number;
  /** Pinnacle line (sharpest sportsbook) */
  pinnacleLine: number | null;
  /** (pinnacle_line - pp_line) / pp_line */
  pinnacleEdge: number;
  /** Opponent team (for report/parlay dedup) */
  opponent: string;
  /** Covers.com expert alignment: agrees, contradicts, or null */
  coversFlag?: 'agrees' | 'contradicts' | null;
}

export interface ParlayPick {
  picks: ScoredPick[];
  combinedConfidence: number;
  correlationNote: string;
}

// ─── Stat type mapping ──────────────────────────────────────────────────────

const PP_TO_BOOK_STAT: Record<string, string> = {
  Points: 'Points',
  Rebounds: 'Rebounds',
  Assists: 'Assists',
  'Pts+Rebs+Asts': 'Pts+Rebs+Asts',
  'Rebs+Asts': 'Rebs+Asts',
  'Pts+Asts': 'Pts+Asts',
  'Pts+Rebs': 'Pts+Rebs',
  'Blks+Stls': 'Blks+Stls',
  'Blocked Shots': 'Blocked Shots',
  Steals: 'Steals',
  '3-PT Made': '3-PT Made',
  Turnovers: 'Turnovers',
  'Fantasy Score': 'Fantasy Score',
};

// ─── Name Matching ──────────────────────────────────────────────────────────

function namesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const clean = (s: string) =>
    s.toLowerCase().trim().replace(/\s+(jr\.?|sr\.?|iii|ii|iv)$/i, '');
  const aClean = clean(a);
  const bClean = clean(b);
  if (aClean === bClean) return true;
  const aParts = aClean.split(/\s+/);
  const bParts = bClean.split(/\s+/);
  if (aParts.length < 2 || bParts.length < 2) return false;
  if (aParts[aParts.length - 1] !== bParts[bParts.length - 1]) return false;
  const aFirst = aParts[0];
  const bFirst = bParts[0];
  const minLen = Math.min(aFirst.length, bFirst.length);
  if (minLen >= 3) {
    return aFirst.slice(0, 3) === bFirst.slice(0, 3);
  }
  return aFirst === bFirst;
}

// ─── Pinnacle Line Lookup ───────────────────────────────────────────────────

let pinnacleCache: BookLine[] | null = null;

async function getPinnacleLines(): Promise<BookLine[]> {
  if (pinnacleCache !== null) return pinnacleCache;
  pinnacleCache = await fetchPinnacleLines().catch(() => []);
  return pinnacleCache;
}

function findPinnacleLine(
  lines: BookLine[],
  playerName: string,
  statType: string
): number | null {
  const bookStat = PP_TO_BOOK_STAT[statType] || statType;
  const matching = lines.filter(
    (l) => namesMatch(l.playerName, playerName) && l.statType === bookStat
  );
  if (matching.length === 0) return null;
  const avg = matching.reduce((s, l) => s + l.line, 0) / matching.length;
  return Math.round(avg * 10) / 10;
}

// ─── Confidence Mapping ─────────────────────────────────────────────────────

function edgeToConfidence(absEdge: number): number {
  if (absEdge >= 0.05) return 5;
  if (absEdge >= 0.03) return 4;
  if (absEdge >= 0.02) return 3;
  if (absEdge >= 0.01) return 2;
  return 1;
}

// ─── Scoring ────────────────────────────────────────────────────────────────

/**
 * Score a single projection using pure Pinnacle divergence.
 *
 * Score = (pinnacle_line - pp_line) / pp_line
 * Positive = OVER, Negative = UNDER
 * No Pinnacle data → score 0, excluded from top picks.
 */
export async function scoreProjection(
  projection: PrizePicksProjection,
  opponent: string
): Promise<ScoredPick> {
  const pinnacleLines = await getPinnacleLines();
  const pinnacleLine = findPinnacleLine(
    pinnacleLines,
    projection.playerName,
    projection.statType
  );

  let pinnacleEdge = 0;
  if (pinnacleLine !== null && projection.line !== 0) {
    pinnacleEdge =
      Math.round(((pinnacleLine - projection.line) / projection.line) * 10000) /
      10000;
  }

  const pick: 'OVER' | 'UNDER' = pinnacleEdge >= 0 ? 'OVER' : 'UNDER';
  const absEdge = Math.abs(pinnacleEdge);
  const confidence = pinnacleLine !== null ? edgeToConfidence(absEdge) : 0;

  // Build reasoning
  const reasons: string[] = [];
  if (pinnacleLine !== null) {
    const sign = pinnacleEdge >= 0 ? '+' : '';
    reasons.push(
      `Pinnacle ${pinnacleLine} vs PP ${projection.line} -> ${sign}${(pinnacleEdge * 100).toFixed(1)}% edge`
    );
  } else {
    reasons.push('No Pinnacle line available — excluded from top picks');
  }

  return {
    projection,
    pick,
    confidence,
    ev: Math.round(absEdge * 10000) / 10000,
    totalScore: Math.round(pinnacleEdge * 10000) / 10000,
    reasoning: reasons.join('. '),
    ppLine: projection.line,
    pinnacleLine,
    pinnacleEdge,
    opponent,
  };
}

/**
 * Rank an array of scored picks by absolute edge (best first).
 */
export function rankProjections(scoredPicks: ScoredPick[]): ScoredPick[] {
  return [...scoredPicks].sort(
    (a, b) => Math.abs(b.totalScore) - Math.abs(a.totalScore)
  );
}

/**
 * Build the best 4-pick parlay from top picks.
 * Avoids correlated picks (same game / same team).
 */
export function buildParlay(topPicks: ScoredPick[]): ParlayPick {
  const ranked = rankProjections(topPicks);
  const selected: ScoredPick[] = [];
  const usedGames = new Set<string>();

  for (const pick of ranked) {
    if (selected.length >= 4) break;
    const gameKey = [pick.projection.team, pick.opponent].sort().join('-');
    if (usedGames.has(gameKey)) continue;
    selected.push(pick);
    usedGames.add(gameKey);
  }

  const combinedConfidence =
    selected.length > 0
      ? Math.round(
          selected.reduce((s, p) => s + p.confidence, 0) / selected.length
        )
      : 0;

  const correlationNote =
    selected.length < 4
      ? `Only ${selected.length} uncorrelated picks available`
      : 'All picks from different games for max independence';

  return { picks: selected, combinedConfidence, correlationNote };
}

/**
 * Save scored picks to the database.
 */
export function savePicks(date: string, picks: ScoredPick[]): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO prizepicks_picks
    (date, player_name, team, opponent, league, stat_type, line, pick,
     confidence, ev_estimate, reasoning, last5_avg, last10_avg, season_avg,
     matchup_grade, home_away, pinnacle_line, pinnacle_edge, sharp_projection,
     vegas_total, team_total, game_spread, covers_flag)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction((rows: ScoredPick[]) => {
    for (const p of rows) {
      stmt.run(
        date,
        p.projection.playerName,
        p.projection.team,
        p.opponent,
        p.projection.league,
        p.projection.statType,
        p.projection.line,
        p.pick,
        p.confidence,
        p.ev,
        p.reasoning,
        null, // last5_avg — no longer computed
        null, // last10_avg
        null, // season_avg
        null, // matchup_grade
        null, // home_away
        p.pinnacleLine,
        p.pinnacleEdge,
        null, // sharp_projection — removed
        null, // vegas_total — removed from scoring
        null, // team_total
        null, // game_spread
        p.coversFlag || null // covers_flag
      );
    }
  });

  insertAll(picks);
}

// ─── Historical Hit Rate Tracking ─────────────────────────────────────────────

function edgeToBucket(edge: number): string {
  const absEdge = Math.abs(edge);
  if (absEdge >= 0.15) return 'very_high';
  if (absEdge >= 0.10) return 'high';
  if (absEdge >= 0.05) return 'medium';
  return 'low';
}

export function recordPickResult(
  date: string,
  playerName: string,
  statType: string,
  pickDirection: 'OVER' | 'UNDER',
  edge: number,
  line: number,
  actualResult: number,
  hit: boolean
): void {
  const db = getDatabase();
  const edgeBucketVal = edgeToBucket(edge);

  db.prepare(`
    INSERT INTO pick_results
    (date, player_name, stat_type, pick_direction, edge_bucket, hit, line, actual_result, pinnacle_edge)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    date,
    playerName,
    statType,
    pickDirection,
    edgeBucketVal,
    hit ? 1 : 0,
    line,
    actualResult,
    edge
  );
}

export function getHistoricalHitRate(
  statType: string,
  edgeBucket: string
): number | null {
  const db = getDatabase();

  const result = db
    .prepare(
      `
    SELECT COUNT(*) as total, SUM(hit) as hits
    FROM pick_results
    WHERE stat_type = ? AND edge_bucket = ?
  `
    )
    .get(statType, edgeBucket) as { total: number; hits: number } | undefined;

  if (!result || result.total < 10) return null;
  return result.hits / result.total;
}

/** Reset the Pinnacle lines cache (for testing or between runs). */
export function resetPinnacleCache(): void {
  pinnacleCache = null;
}
