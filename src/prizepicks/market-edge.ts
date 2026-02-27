/**
 * Market Edge — Pinnacle-only edge engine
 *
 * Edge signal: Pinnacle line vs PrizePicks line.
 * Pinnacle is the sharpest sportsbook — if their line diverges from PP,
 * that's a real market mispricing.
 */

import { fetchPinnacleLines, fetchTeamTotals, type BookLine } from './odds-service';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MarketEdge {
  playerName: string;
  statType: string;
  ppLine: number;
  /** Pinnacle line — sharpest single source */
  pinnacleLine: number | null;
  /** Consensus line = Pinnacle line (single source) */
  consensusLine: number | null;
  /**
   * (pinnacle_line - pp_line) / pp_line
   * Positive = Pinnacle is HIGHER than PP → OVER edge
   * Negative = Pinnacle is LOWER than PP → UNDER edge
   */
  pinnacleEdge: number;
  /**
   * Same as pinnacleEdge (Pinnacle is the only source)
   */
  consensusEdge: number;
  /** Vegas expected scoring total for this player's team (from team_totals market) */
  teamTotal: number | null;
}

// ─── Stat type mapping ───────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  // Last names must match exactly
  if (aParts[aParts.length - 1] !== bParts[bParts.length - 1]) return false;
  // First names must share at least 3 chars (not just initial)
  // This prevents "Kyshawn George" matching "Keyonte George"
  const aFirst = aParts[0];
  const bFirst = bParts[0];
  const minLen = Math.min(aFirst.length, bFirst.length);
  if (minLen >= 3) {
    return aFirst.slice(0, 3) === bFirst.slice(0, 3);
  }
  // Short first names: must match fully
  return aFirst === bFirst;
}

/**
 * Find team total for a given team from the team totals map.
 * Uses fuzzy matching (last word of team name) to handle short vs full names.
 */
function findTeamTotal(totals: Map<string, number>, team: string): number | null {
  if (totals.size === 0 || !team) return null;
  const teamLc = team.toLowerCase().trim();

  for (const [teamName, total] of totals) {
    const nameLc = teamName.toLowerCase().trim();
    // Exact match
    if (nameLc === teamLc) return total;
    // One contains the other (e.g., "Lakers" in "Los Angeles Lakers")
    if (nameLc.includes(teamLc) || teamLc.includes(nameLc)) return total;
    // Last word match (city abbreviation → "Lakers", "Warriors", etc.)
    const nameLastWord = nameLc.split(' ').pop() ?? '';
    const teamLastWord = teamLc.split(' ').pop() ?? '';
    if (nameLastWord && teamLastWord && nameLastWord === teamLastWord) return total;
  }

  return null;
}

/**
 * Find a specific book's line for a player/stat from a list of BookLines.
 * Returns null if no matching entry found.
 */
function findBookLine(
  lines: BookLine[],
  playerName: string,
  statType: string,
  bookFilter?: string
): number | null {
  const bookStat = PP_TO_BOOK_STAT[statType] || statType;
  const matching = lines.filter(
    (l) =>
      namesMatch(l.playerName, playerName) &&
      l.statType === bookStat &&
      (!bookFilter || l.book.toLowerCase().includes(bookFilter.toLowerCase()))
  );
  if (matching.length === 0) return null;
  // Average if multiple (e.g., regional variants) — rare in practice
  const avg = matching.reduce((s, l) => s + l.line, 0) / matching.length;
  return Math.round(avg * 10) / 10;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Compute Pinnacle market edge for a player vs their PrizePicks line.
 *
 * Fetches Pinnacle lines via fetchPinnacleLines(),
 * computes edge as (Pinnacle - PP) / PP.
 *
 * @param team - Optional team name to look up team totals (e.g. "Lakers", "Los Angeles Lakers")
 */
export async function getMarketEdge(
  playerName: string,
  statType: string,
  ppLine: number,
  team?: string
): Promise<MarketEdge> {
  console.log(`[MarketEdge] Looking up: ${playerName} | ${statType}`);

  const [pinnacleLines, teamTotalsMap] = await Promise.all([
    fetchPinnacleLines().catch((): BookLine[] => []),
    fetchTeamTotals().catch((): Map<string, number> => new Map()),
  ]);

  const pinnacleLine = findBookLine(pinnacleLines, playerName, statType);

  // Team total lookup
  const teamTotal = team ? findTeamTotal(teamTotalsMap, team) : null;

  // Consensus = Pinnacle (only source)
  const consensusLine = pinnacleLine;

  const pinnacleEdge =
    pinnacleLine !== null && ppLine !== 0
      ? Math.round(((pinnacleLine - ppLine) / ppLine) * 10000) / 10000
      : 0;

  // consensusEdge = pinnacleEdge since Pinnacle is the only source
  const consensusEdge = pinnacleEdge;

  console.log(
    `[MarketEdge] ${playerName} ${statType}: PP ${ppLine} | ` +
      `Pinnacle ${pinnacleLine ?? 'N/A'} (${(pinnacleEdge * 100).toFixed(1)}%) | ` +
      `Team Total ${teamTotal ?? 'N/A'}`
  );

  return {
    playerName,
    statType,
    ppLine,
    pinnacleLine,
    consensusLine,
    pinnacleEdge,
    consensusEdge,
    teamTotal,
  };
}

/**
 * Build a human-readable edge description for the reasoning string.
 */
export function describeMarketEdge(edge: MarketEdge): string[] {
  const parts: string[] = [];

  if (edge.pinnacleLine !== null) {
    const pct = (edge.pinnacleEdge * 100).toFixed(1);
    const sign = edge.pinnacleEdge >= 0 ? '+' : '';
    parts.push(
      `Pinnacle ${edge.pinnacleLine} vs PP ${edge.ppLine} → ${sign}${pct}% edge`
    );
  }

  return parts;
}
