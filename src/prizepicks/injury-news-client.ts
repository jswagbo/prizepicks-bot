/**
 * Injury & News Client
 * 
 * Fetches injury reports, lineup changes, and player news from free ESPN APIs.
 * Calculates usage/minutes boost for teammates when key players are OUT.
 */

import { getPlayerAverages } from './nba-stats-client';

// ─── Team Abbreviation Map ───────────────────────────────────────────────────

const TEAM_ABBREV: Record<string, string> = {
  'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN',
  'Charlotte Hornets': 'CHA', 'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE',
  'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET',
  'Golden State Warriors': 'GS', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
  'LA Clippers': 'LAC', 'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL',
  'LA Lakers': 'LAL', 'Memphis Grizzlies': 'MEM', 'Miami Heat': 'MIA',
  'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN',
  'New Orleans Pelicans': 'NO', 'New York Knicks': 'NY', 'Oklahoma City Thunder': 'OKC',
  'Orlando Magic': 'ORL', 'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX',
  'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC',
  'San Antonio Spurs': 'SA', 'Toronto Raptors': 'TOR', 'Utah Jazz': 'UTAH',
  'Washington Wizards': 'WSH',
};

// Reverse lookup: abbreviation → full name
const ABBREV_TO_TEAM: Record<string, string> = Object.fromEntries(
  Object.entries(TEAM_ABBREV).map(([k, v]) => [v, k])
);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InjuryReport {
  playerName: string;
  team: string; // abbreviation
  status: 'Out' | 'Doubtful' | 'Questionable' | 'Probable' | 'Day-To-Day' | 'Suspended';
  description: string;
  lastUpdate: string;
}

export interface TeamInjuryImpact {
  team: string;
  outPlayers: InjuryReport[];
  questionablePlayers: InjuryReport[];
  usageBoost: Map<string, number>; // playerName → estimated % boost
  minutesBoost: Map<string, number>; // playerName → estimated additional minutes
}

// ─── ESPN API Helpers ────────────────────────────────────────────────────────

const ESPN_BASE = 'https://site.api.espn.com/apis';

async function espnFetch(path: string): Promise<unknown> {
  try {
    const res = await fetch(`${ESPN_BASE}${path}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      console.error(`[Injuries] ESPN API error: ${res.status} for ${path}`);
      return null;
    }
    return res.json();
  } catch (err) {
    console.error('[Injuries] Fetch error:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Injury Report ───────────────────────────────────────────────────────────

/**
 * Fetch full NBA injury report from ESPN
 */
export async function getInjuryReport(): Promise<InjuryReport[]> {
  console.log('[Injuries] Fetching NBA injury report...');
  
  const data = await espnFetch('/site/v2/sports/basketball/nba/injuries') as any;
  if (!data?.teams) {
    console.log('[Injuries] No injury data available');
    return [];
  }

  const injuries: InjuryReport[] = [];

  for (const teamData of data.teams) {
    const teamName = teamData.team?.displayName || teamData.team?.name || '';
    const teamAbbr = TEAM_ABBREV[teamName] || teamData.team?.abbreviation || '';
    
    const teamInjuries = teamData.injuries || [];
    for (const inj of teamInjuries) {
      const athlete = inj.athlete || {};
      const status = normalizeStatus(inj.status || '');
      if (!status) continue; // skip unknown statuses

      injuries.push({
        playerName: athlete.displayName || athlete.name || 'Unknown',
        team: teamAbbr,
        status,
        description: inj.details?.fantasyInjuryStatus || inj.details?.detail || inj.status || '',
        lastUpdate: inj.date || new Date().toISOString(),
      });
    }
  }

  console.log(`[Injuries] Found ${injuries.length} injury reports`);
  return injuries;
}

/**
 * Normalize ESPN injury status strings to our enum
 */
function normalizeStatus(
  status: string
): 'Out' | 'Doubtful' | 'Questionable' | 'Probable' | 'Day-To-Day' | 'Suspended' | null {
  const lower = status.toLowerCase();
  if (lower.includes('out')) return 'Out';
  if (lower.includes('doubtful')) return 'Doubtful';
  if (lower.includes('questionable')) return 'Questionable';
  if (lower.includes('probable')) return 'Probable';
  if (lower.includes('day-to-day') || lower.includes('day to day')) return 'Day-To-Day';
  if (lower.includes('suspend')) return 'Suspended';
  return null;
}

// ─── Team Injury Impact ──────────────────────────────────────────────────────

/**
 * Calculate injury impact for a specific team.
 * Returns usage/minutes boost estimates for healthy players.
 */
export async function getTeamInjuryImpact(
  team: string,
  injuries: InjuryReport[]
): Promise<TeamInjuryImpact> {
  const teamInjuries = injuries.filter((i) => i.team === team);
  const outPlayers = teamInjuries.filter((i) => i.status === 'Out' || i.status === 'Suspended');
  const questionablePlayers = teamInjuries.filter((i) => 
    i.status === 'Questionable' || i.status === 'Doubtful' || i.status === 'Day-To-Day'
  );

  const usageBoost = new Map<string, number>();
  const minutesBoost = new Map<string, number>();

  // For each OUT player, estimate their impact and distribute to teammates
  for (const outPlayer of outPlayers) {
    try {
      const stats = await getPlayerAverages(outPlayer.playerName, 10);
      if (!stats) continue;

      // Estimate player's role based on their averages
      const isPrimaryScorer = stats.points >= 18;
      const isPlaymaker = stats.assists >= 5;
      const isRebounder = stats.rebounds >= 8;

      // Simple boost distribution: give 60% of lost production to top teammates
      // In a real system, you'd fetch roster and distribute weighted by current usage
      const scoringBoost = isPrimaryScorer ? stats.points * 0.6 : 0;
      const assistBoost = isPlaymaker ? stats.assists * 0.6 : 0;
      const reboundBoost = isRebounder ? stats.rebounds * 0.6 : 0;

      console.log(
        `[Injuries] ${outPlayer.playerName} OUT → ${scoringBoost.toFixed(1)} pts, ` +
        `${assistBoost.toFixed(1)} ast, ${reboundBoost.toFixed(1)} reb distributed`
      );

      // Store as % boost (this will be applied by pick-scorer to specific teammates)
      // For now, store generic team-level boost — pick-scorer can apply it proportionally
      usageBoost.set(team, (usageBoost.get(team) || 0) + 0.10); // 10% usage boost per key player out
      
    } catch (err) {
      console.error(`[Injuries] Error processing ${outPlayer.playerName}:`, err);
    }
  }

  // Minutes boost: simple heuristic
  // If 1+ starter is OUT, bench players get +10 min estimate
  if (outPlayers.length > 0) {
    minutesBoost.set(team, outPlayers.length * 10);
  }

  console.log(
    `[Injuries] ${team}: ${outPlayers.length} OUT, ${questionablePlayers.length} GTD | ` +
    `Usage boost: ${(usageBoost.get(team) || 0) * 100}%`
  );

  return {
    team,
    outPlayers,
    questionablePlayers,
    usageBoost,
    minutesBoost,
  };
}

// ─── Player News ─────────────────────────────────────────────────────────────

/**
 * Fetch recent news headlines for a specific player
 */
export async function getPlayerNews(playerName: string): Promise<string[]> {
  console.log(`[Injuries] Fetching news for ${playerName}...`);
  
  const data = await espnFetch('/site/v2/sports/basketball/nba/news') as any;
  if (!data?.articles) {
    return [];
  }

  const headlines: string[] = [];
  const lowerName = playerName.toLowerCase();

  for (const article of data.articles) {
    const headline = article.headline || '';
    const description = article.description || '';
    
    if (
      headline.toLowerCase().includes(lowerName) ||
      description.toLowerCase().includes(lowerName)
    ) {
      headlines.push(headline);
      if (headlines.length >= 5) break; // max 5 headlines
    }
  }

  console.log(`[Injuries] Found ${headlines.length} news items for ${playerName}`);
  return headlines;
}
