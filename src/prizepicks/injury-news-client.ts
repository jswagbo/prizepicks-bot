/**
 * Injury News Client
 * 
 * Fetches injury reports, lineup changes, and news from ESPN APIs.
 * Uses free endpoints — no API key required.
 */

import { getDatabase } from '../core/db/database';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InjuryReport {
  playerName: string;
  team: string;
  status: 'Out' | 'Doubtful' | 'Questionable' | 'Probable' | 'Day-To-Day' | 'Suspended';
  description: string;
  lastUpdate: string;
}

export interface TeamInjuryImpact {
  team: string;
  outPlayers: InjuryReport[];
  questionablePlayers: InjuryReport[];
  usageBoost: Map<string, number>;
  minutesBoost: Map<string, number>;
}

// ─── Team Abbreviation Maps ─────────────────────────────────────────────────

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

/** Reverse map: ESPN displayName / abbreviation → our abbreviation */
const ESPN_TEAM_MAP: Record<string, string> = {
  ...TEAM_ABBREV,
  // ESPN sometimes uses short abbreviations
  'ATL': 'ATL', 'BOS': 'BOS', 'BKN': 'BKN', 'CHA': 'CHA', 'CHI': 'CHI',
  'CLE': 'CLE', 'DAL': 'DAL', 'DEN': 'DEN', 'DET': 'DET', 'GS': 'GS',
  'GSW': 'GS', 'HOU': 'HOU', 'IND': 'IND', 'LAC': 'LAC', 'LAL': 'LAL',
  'MEM': 'MEM', 'MIA': 'MIA', 'MIL': 'MIL', 'MIN': 'MIN', 'NO': 'NO',
  'NOP': 'NO', 'NY': 'NY', 'NYK': 'NY', 'OKC': 'OKC', 'ORL': 'ORL',
  'PHI': 'PHI', 'PHX': 'PHX', 'POR': 'POR', 'SAC': 'SAC', 'SA': 'SA',
  'SAS': 'SA', 'TOR': 'TOR', 'UTAH': 'UTAH', 'UTA': 'UTAH', 'WSH': 'WSH',
  'WAS': 'WSH',
};

function resolveTeamAbbrev(name: string): string {
  return ESPN_TEAM_MAP[name] || TEAM_ABBREV[name] || name;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

let injuryCache: { data: InjuryReport[]; timestamp: number } | null = null;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ─── ESPN Status Mapping ─────────────────────────────────────────────────────

const STATUS_MAP: Record<string, InjuryReport['status']> = {
  'Out': 'Out',
  'Doubtful': 'Doubtful',
  'Questionable': 'Questionable',
  'Probable': 'Probable',
  'Day-To-Day': 'Day-To-Day',
  'Suspended': 'Suspended',
  'out': 'Out',
  'doubtful': 'Doubtful',
  'questionable': 'Questionable',
  'probable': 'Probable',
  'day-to-day': 'Day-To-Day',
  'suspended': 'Suspended',
};

function normalizeStatus(raw: string): InjuryReport['status'] {
  return STATUS_MAP[raw] || STATUS_MAP[raw.toLowerCase()] || 'Questionable';
}

// ─── Injury Report ───────────────────────────────────────────────────────────

/**
 * Fetch injury reports from ESPN
 */
export async function getInjuryReport(): Promise<InjuryReport[]> {
  // Return cached if fresh
  if (injuryCache && Date.now() - injuryCache.timestamp < CACHE_TTL) {
    console.log(`[Injuries] Returning cached injury report (${injuryCache.data.length} injuries)`);
    return injuryCache.data;
  }

  const injuries: InjuryReport[] = [];

  try {
    const res = await fetch(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries',
      { headers: { 'Accept': 'application/json' } }
    );

    if (!res.ok) {
      console.error(`[Injuries] ESPN API error: ${res.status}`);
      return injuries;
    }

    const data = await res.json() as any;

    // ESPN structure: { injuries: [ { displayName: "Atlanta Hawks", injuries: [...] }, ... ] }
    const teams = data?.injuries || [];
    for (const teamEntry of (Array.isArray(teams) ? teams : [])) {
      const teamName = teamEntry?.displayName || '';
      const teamAbbrev = resolveTeamAbbrev(teamName);

      const teamInjuries = teamEntry?.injuries || [];
      for (const injury of teamInjuries) {
        const athlete = injury?.athlete || {};
        const playerName = athlete?.displayName || athlete?.fullName || '';
        if (!playerName) continue;

        const statusRaw = injury?.status || injury?.type?.description || '';
        const description = injury?.longComment || injury?.shortComment || '';
        const lastUpdate = injury?.date || '';

        injuries.push({
          playerName,
          team: teamAbbrev,
          status: normalizeStatus(statusRaw),
          description,
          lastUpdate,
        });
      }
    }

    console.log(`[Injuries] Fetched ${injuries.length} injury reports from ESPN`);
  } catch (err) {
    console.error('[Injuries] Error fetching injury report:', err instanceof Error ? err.message : err);
  }

  injuryCache = { data: injuries, timestamp: Date.now() };
  return injuries;
}

// ─── Team Injury Impact ──────────────────────────────────────────────────────

/**
 * Calculate the impact of injuries on a team's remaining players.
 * Estimates usage and minutes boosts when key players are out.
 */
export async function getTeamInjuryImpact(
  team: string,
  injuries: InjuryReport[]
): Promise<TeamInjuryImpact> {
  const teamInjuries = injuries.filter(
    (inj) => inj.team.toUpperCase() === team.toUpperCase()
  );

  const outPlayers = teamInjuries.filter(
    (inj) => inj.status === 'Out' || inj.status === 'Suspended'
  );
  const questionablePlayers = teamInjuries.filter(
    (inj) => inj.status === 'Questionable' || inj.status === 'Day-To-Day' || inj.status === 'Doubtful'
  );

  const usageBoost = new Map<string, number>();
  const minutesBoost = new Map<string, number>();

  if (outPlayers.length === 0) {
    return { team, outPlayers, questionablePlayers, usageBoost, minutesBoost };
  }

  const db = getDatabase();

  // Get season averages for out players to estimate their production weight
  for (const outPlayer of outPlayers) {
    const avgRow = db.prepare(`
      SELECT 
        AVG(points) as avg_pts, AVG(rebounds) as avg_reb, AVG(assists) as avg_ast,
        AVG(minutes) as avg_min, COUNT(*) as games
      FROM player_game_logs
      WHERE player_name = ? AND league = 'NBA'
    `).get(outPlayer.playerName) as {
      avg_pts: number; avg_reb: number; avg_ast: number; avg_min: number; games: number;
    } | undefined;

    if (!avgRow || avgRow.games < 3) continue;

    // Determine role weight based on minutes and scoring
    const isStarter = avgRow.avg_min >= 25;
    const isHighUsage = avgRow.avg_pts >= 18;

    // Get active teammates from DB
    const teammates = db.prepare(`
      SELECT DISTINCT player_name, AVG(minutes) as avg_min, AVG(points) as avg_pts
      FROM player_game_logs
      WHERE league = 'NBA'
        AND player_name IN (
          SELECT DISTINCT player_name FROM player_game_logs
          WHERE opponent = ? OR player_name IN (
            SELECT player_name FROM player_game_logs WHERE league = 'NBA'
            GROUP BY player_name HAVING COUNT(*) >= 5
          )
        )
        AND player_name != ?
      GROUP BY player_name
      HAVING avg_min > 15
      ORDER BY avg_pts DESC
      LIMIT 8
    `).all(team, outPlayer.playerName) as Array<{
      player_name: string; avg_min: number; avg_pts: number;
    }>;

    // Distribute ~60% of out player's production proportionally
    const redistributionFactor = 0.6;
    const totalTeammateMinutes = teammates.reduce((s, t) => s + t.avg_min, 0);

    for (const teammate of teammates) {
      const share = totalTeammateMinutes > 0 ? teammate.avg_min / totalTeammateMinutes : 0;

      // Usage boost (as decimal, e.g., 0.15 = 15%)
      const ptsBoost = (avgRow.avg_pts * redistributionFactor * share) / Math.max(teammate.avg_pts, 1);
      const existing = usageBoost.get(teammate.player_name) || 0;
      usageBoost.set(teammate.player_name, existing + ptsBoost);

      // Minutes boost
      const minBoost = isStarter ? (8 + 4 * share) : (2 + 2 * share);
      const existingMin = minutesBoost.get(teammate.player_name) || 0;
      minutesBoost.set(teammate.player_name, existingMin + minBoost);
    }

    console.log(
      `[Injuries] ${outPlayer.playerName} (${team}) OUT: ` +
      `${avgRow.avg_pts.toFixed(1)}ppg/${avgRow.avg_min.toFixed(0)}min — ` +
      `redistributing to ${teammates.length} teammates`
    );
  }

  return { team, outPlayers, questionablePlayers, usageBoost, minutesBoost };
}

// ─── Player News ─────────────────────────────────────────────────────────────

/**
 * Fetch recent news headlines for a player from ESPN
 */
export async function getPlayerNews(playerName: string): Promise<string[]> {
  try {
    const res = await fetch(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news',
      { headers: { 'Accept': 'application/json' } }
    );

    if (!res.ok) {
      console.error(`[Injuries] ESPN News API error: ${res.status}`);
      return [];
    }

    const data = await res.json() as any;
    const articles = data?.articles || [];
    const headlines: string[] = [];

    const nameLower = playerName.toLowerCase();
    for (const article of articles) {
      const headline = article?.headline || '';
      const description = article?.description || '';
      if (
        headline.toLowerCase().includes(nameLower) ||
        description.toLowerCase().includes(nameLower)
      ) {
        headlines.push(headline);
      }
    }

    console.log(`[Injuries] Found ${headlines.length} news items for ${playerName}`);
    return headlines;
  } catch (err) {
    console.error('[Injuries] Error fetching player news:', err instanceof Error ? err.message : err);
    return [];
  }
}
