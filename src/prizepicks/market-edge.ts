/**
 * Market Edge — Multi-book consensus engine
 *
 * Primary edge signal: Pinnacle line vs PrizePicks line.
 * Pinnacle is the sharpest sportsbook — if their line diverges from PP,
 * that's a real market mispricing.
 */

import { fetchPlayerProps, fetchPinnacleLines, fetchTeamTotals, type BookLine } from './odds-service';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MarketEdge {
  playerName: string;
  statType: string;
  ppLine: number;
  /** Pinnacle line — sharpest single source */
  pinnacleLine: number | null;
  /** DraftKings line */
  draftKingsLine: number | null;
  /** FanDuel line */
  fanDuelLine: number | null;
  /** Average of DK + FD + Pinnacle (whichever are available) */
  consensusLine: number | null;
  /**
   * (pinnacle_line - pp_line) / pp_line
   * Positive = Pinnacle is HIGHER than PP → OVER edge
   * Negative = Pinnacle is LOWER than PP → UNDER edge
   */
  pinnacleEdge: number;
  /**
   * (consensus_line - pp_line) / pp_line
   * Positive = consensus is HIGHER than PP → OVER edge
   * Negative = consensus is LOWER than PP → UNDER edge
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
 * Compute multi-book market edge for a player vs their PrizePicks line.
 *
 * Fetches lines from all books via fetchPlayerProps() and fetchPinnacleLines(),
 * computes Pinnacle edge and book consensus edge.
 *
 * @param team - Optional team name to look up team totals (e.g. "Lakers", "Los Angeles Lakers")
 */
export async function getMarketEdge(
  playerName: string,
  statType: string,
  ppLine: number,
  team?: string
): Promise<MarketEdge> {
  const [allLines, pinnacleLines, teamTotalsMap] = await Promise.all([
    fetchPlayerProps().catch((): BookLine[] => []),
    fetchPinnacleLines().catch((): BookLine[] => []),
    fetchTeamTotals().catch((): Map<string, number> => new Map()),
  ]);

  const draftKingsLine = findBookLine(allLines, playerName, statType, 'DraftKings');
  const fanDuelLine = findBookLine(allLines, playerName, statType, 'FanDuel');
  const pinnacleLine = findBookLine(pinnacleLines, playerName, statType);

  // Team total lookup
  const teamTotal = team ? findTeamTotal(teamTotalsMap, team) : null;

  // Consensus = average of available: DK, FD, Pinnacle
  const components: number[] = [];
  if (draftKingsLine !== null) components.push(draftKingsLine);
  if (fanDuelLine !== null) components.push(fanDuelLine);
  if (pinnacleLine !== null) components.push(pinnacleLine);

  const consensusLine =
    components.length > 0
      ? Math.round((components.reduce((s, v) => s + v, 0) / components.length) * 10) / 10
      : null;

  const pinnacleEdge =
    pinnacleLine !== null && ppLine !== 0
      ? Math.round(((pinnacleLine - ppLine) / ppLine) * 10000) / 10000
      : 0;

  const consensusEdge =
    consensusLine !== null && ppLine !== 0
      ? Math.round(((consensusLine - ppLine) / ppLine) * 10000) / 10000
      : 0;

  console.log(
    `[MarketEdge] ${playerName} ${statType}: PP ${ppLine} | ` +
      `Pinnacle ${pinnacleLine ?? 'N/A'} (${(pinnacleEdge * 100).toFixed(1)}%) | ` +
      `DK ${draftKingsLine ?? 'N/A'} | FD ${fanDuelLine ?? 'N/A'} | ` +
      `Consensus ${consensusLine ?? 'N/A'} (${(consensusEdge * 100).toFixed(1)}%) | ` +
      `Team Total ${teamTotal ?? 'N/A'}`
  );

  return {
    playerName,
    statType,
    ppLine,
    pinnacleLine,
    draftKingsLine,
    fanDuelLine,
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

  if (edge.consensusLine !== null) {
    const bookParts: string[] = [];
    if (edge.draftKingsLine !== null) bookParts.push(`DK ${edge.draftKingsLine}`);
    if (edge.fanDuelLine !== null) bookParts.push(`FD ${edge.fanDuelLine}`);
    if (edge.pinnacleLine !== null) bookParts.push(`Pinnacle ${edge.pinnacleLine}`);
    const pct = (edge.consensusEdge * 100).toFixed(1);
    const sign = edge.consensusEdge >= 0 ? '+' : '';
    parts.push(
      `Book consensus: ${bookParts.join(' / ')} = avg ${edge.consensusLine} vs PP ${edge.ppLine} (${sign}${pct}%)`
    );
  }

  return parts;
}
