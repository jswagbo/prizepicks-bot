/**
 * NBA Stats Client
 * 
 * Uses free ESPN APIs to fetch player game logs, team stats, and schedules.
 * Caches game logs to SQLite to avoid redundant fetches.
 */

import { getDatabase } from '../core/db/database';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlayerSearchResult {
  id: string;
  name: string;
  team: string;
  position: string;
}

export interface GameLogEntry {
  gameDate: string;
  opponent: string;
  homeAway: 'home' | 'away';
  minutes: number;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  threePointersMade: number;
  fantasyScore: number;
  ptsRebsAsts: number;
  statJson: Record<string, unknown>;
}

export interface TodaysGame {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamId: string;
  awayTeamId: string;
  startTime: string;
  status: string;
  /** Point spread from ESPN odds (negative = home favored). Null if unavailable. */
  spread: number | null;
}

export interface TeamDefenseRanking {
  team: string;
  statType: string;
  rank: number;
  avgAllowed: number;
}

export interface PlayerAverages {
  playerName: string;
  games: number;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  threePointersMade: number;
  fantasyScore: number;
  ptsRebsAsts: number;
}

// ─── ESPN API Helpers ────────────────────────────────────────────────────────

const ESPN_BASE = 'https://site.api.espn.com/apis';

async function espnFetch(path: string): Promise<unknown> {
  const res = await fetch(`${ESPN_BASE}${path}`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`ESPN API error: ${res.status} ${res.statusText} for ${path}`);
  }
  return res.json();
}

// ─── Player Search ───────────────────────────────────────────────────────────

/**
 * Search for an NBA player by name, returns ESPN athlete ID.
 * Uses the site.web.api search endpoint (the old common/v3/athletes?search= returns 400).
 */
export async function searchPlayer(name: string): Promise<PlayerSearchResult | null> {
  // Primary: site.web.api search (reliable as of Feb 2026)
  const searchUrl = `https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(name)}&type=player&sport=basketball&league=nba&limit=3`;
  const res = await fetch(searchUrl, { headers: { 'Accept': 'application/json' } });
  
  if (res.ok) {
    const data = await res.json() as { items?: Array<{ id: string; displayName: string; teamRelationships?: Array<{ core: { abbreviation: string } }>; jersey?: string }> };
    const items = data.items || [];
    if (items.length > 0) {
      const athlete = items[0];
      const team = athlete.teamRelationships?.[0]?.core?.abbreviation || '';
      return {
        id: athlete.id,
        name: athlete.displayName,
        team,
        position: '', // search endpoint doesn't return position directly
      };
    }
  }

  // Fallback: old common/v3 endpoint (may return 400)
  try {
    const data = await espnFetch(
      `/common/v3/sports/basketball/nba/athletes?search=${encodeURIComponent(name)}`
    ) as { items?: Array<{ id: string; displayName: string; position?: { abbreviation: string }; team?: { shortDisplayName: string } }> };

    const items = data.items || [];
    if (items.length === 0) return null;

    const athlete = items[0];
    return {
      id: athlete.id,
      name: athlete.displayName,
      team: athlete.team?.shortDisplayName || '',
      position: athlete.position?.abbreviation || '',
    };
  } catch {
    return null;
  }
}

// ─── Game Log ────────────────────────────────────────────────────────────────

/**
 * Fetch a player's game log from ESPN and cache to SQLite
 */
export async function getGameLog(
  playerId: string,
  playerName: string,
  season?: string
): Promise<GameLogEntry[]> {
  const seasonParam = season ? `?season=${season}` : '';
  const data = await espnFetch(
    `/common/v3/sports/basketball/nba/athletes/${playerId}/gamelog${seasonParam}`
  ) as Record<string, unknown>;

  const entries: GameLogEntry[] = [];

  // ESPN gamelog structure (as of Feb 2026):
  // - Top-level `labels` array: ['MIN', 'FG', 'FG%', '3PT', '3P%', 'FT', 'FT%', 'REB', 'AST', 'BLK', 'STL', 'PF', 'TO', 'PTS']
  // - Top-level `events` dict: { [eventId]: { gameDate, opponent: { abbreviation }, homeAway } }
  // - `seasonTypes[].categories[].events[]`: { eventId, stats: string[] }
  const topLabels: string[] = (data as any)?.labels || [];
  const topEvents: Record<string, any> = (data as any)?.events || {};
  const seasonTypes = (data as any)?.seasonTypes || [];
  
  for (const st of seasonTypes) {
    const cats = st?.categories || [];
    for (const cat of cats) {
      const catEvents = cat?.events || [];
      // Use category-level labels if available, otherwise fall back to top-level
      const labels: string[] = (cat?.labels?.length > 0 ? cat.labels : topLabels);
      
      for (const event of catEvents) {
        const statsRaw: string[] = event?.stats || [];
        const eventId = String(event?.eventId || '');
        
        // Get event metadata from top-level events dict
        const eventMeta = topEvents[eventId] || {};
        const gameDate = event?.gameDate || eventMeta?.gameDate || '';
        const opponent = event?.opponent?.abbreviation || eventMeta?.opponent?.abbreviation || '';
        const homeAwayRaw = event?.homeAway || eventMeta?.homeAway || '';
        const homeAway = homeAwayRaw === 'home' ? 'home' as const : 'away' as const;

        // Map labels to stat values
        const statMap: Record<string, number> = {};
        labels.forEach((label: string, i: number) => {
          const raw = statsRaw[i] || '0';
          // Handle compound stats like '9-14' (made-attempted) — take the first number (made)
          const val = raw.includes('-') ? parseFloat(raw.split('-')[0]) || 0 : parseFloat(raw) || 0;
          statMap[label.toUpperCase()] = val;
        });

        const entry: GameLogEntry = {
          gameDate: gameDate.split('T')[0],
          opponent,
          homeAway,
          minutes: statMap['MIN'] || statMap['MINUTES'] || 0,
          points: statMap['PTS'] || 0,
          rebounds: statMap['REB'] || 0,
          assists: statMap['AST'] || 0,
          steals: statMap['STL'] || 0,
          blocks: statMap['BLK'] || 0,
          turnovers: statMap['TO'] || statMap['TOV'] || 0,
          threePointersMade: statMap['3PM'] || statMap['3PT'] || 0,
          fantasyScore: 0,
          ptsRebsAsts: 0,
          statJson: statMap,
        };

        // Compute derived stats
        entry.ptsRebsAsts = entry.points + entry.rebounds + entry.assists;
        entry.fantasyScore =
          entry.points * 1 +
          entry.rebounds * 1.2 +
          entry.assists * 1.5 +
          entry.steals * 3 +
          entry.blocks * 3 -
          entry.turnovers * 1;

        if (entry.gameDate) {
          entries.push(entry);
        }
      }
    }
  }

  // Cache to SQLite
  cacheGameLogs(playerName, 'NBA', entries);

  return entries;
}

/**
 * Cache game log entries to SQLite (upsert)
 */
function cacheGameLogs(playerName: string, league: string, entries: GameLogEntry[]): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO player_game_logs 
    (player_name, league, game_date, opponent, home_away, minutes,
     points, rebounds, assists, steals, blocks, turnovers,
     three_pointers_made, fantasy_score, pts_rebs_asts, stat_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows: GameLogEntry[]) => {
    for (const e of rows) {
      stmt.run(
        playerName, league, e.gameDate, e.opponent, e.homeAway, e.minutes,
        e.points, e.rebounds, e.assists, e.steals, e.blocks, e.turnovers,
        e.threePointersMade, e.fantasyScore, e.ptsRebsAsts,
        JSON.stringify(e.statJson)
      );
    }
  });

  insertMany(entries);
}

// ─── Today's Games ───────────────────────────────────────────────────────────

/**
 * Get today's NBA schedule
 */
export async function getTodaysGames(): Promise<TodaysGame[]> {
  const data = await espnFetch(
    '/site/v2/sports/basketball/nba/scoreboard'
  ) as { events?: Array<Record<string, unknown>> };

  return (data.events || []).map((event: any) => {
    const competition = event.competitions?.[0] || {};
    const competitors = competition.competitors || [];
    const home = competitors.find((c: any) => c.homeAway === 'home') || {};
    const away = competitors.find((c: any) => c.homeAway === 'away') || {};

    // Extract spread from ESPN odds if available
    const odds = competition.odds?.[0] || {};
    let spread: number | null = null;
    if (odds.spread !== undefined && odds.spread !== null) {
      spread = parseFloat(odds.spread);
    } else if (odds.details) {
      // Parse from details string like "MIN -13.5"
      const match = (odds.details as string).match(/([-+]?\d+\.?\d*)/);
      if (match) spread = parseFloat(match[1]);
    }

    return {
      gameId: event.id || '',
      homeTeam: home.team?.abbreviation || '',
      awayTeam: away.team?.abbreviation || '',
      homeTeamId: home.team?.id || '',
      awayTeamId: away.team?.id || '',
      startTime: event.date || '',
      status: event.status?.type?.description || '',
      spread,
    };
  });
}

// ─── Team Defense Rankings ───────────────────────────────────────────────────

/**
 * Fetch and cache team defensive rankings.
 * Uses cached game logs to compute average stats allowed per team.
 * Falls back to a simple ranking from the DB if available.
 */
export async function getTeamDefenseRankings(): Promise<TeamDefenseRanking[]> {
  const db = getDatabase();

  // Check if we have recent cached rankings (< 24h old)
  const cached = db.prepare(`
    SELECT team, stat_type, rank, avg_allowed 
    FROM team_defense_rankings 
    WHERE league = 'NBA' 
      AND updated_at > datetime('now', '-24 hours')
  `).all() as Array<{ team: string; stat_type: string; rank: number; avg_allowed: number }>;

  if (cached.length > 0) {
    return cached.map((r) => ({
      team: r.team,
      statType: r.stat_type,
      rank: r.rank,
      avgAllowed: r.avg_allowed,
    }));
  }

  // Compute from game logs: for each opponent, average the stat scored against them
  const statTypes = ['points', 'rebounds', 'assists', 'steals', 'blocks', 'three_pointers_made'];
  const rankings: TeamDefenseRanking[] = [];

  for (const stat of statTypes) {
    const rows = db.prepare(`
      SELECT opponent, AVG(${stat}) as avg_stat, COUNT(*) as games
      FROM player_game_logs
      WHERE league = 'NBA' AND opponent IS NOT NULL AND opponent != ''
      GROUP BY opponent
      HAVING games >= 5
      ORDER BY avg_stat ASC
    `).all() as Array<{ opponent: string; avg_stat: number; games: number }>;

    rows.forEach((row, idx) => {
      const ranking: TeamDefenseRanking = {
        team: row.opponent,
        statType: stat.charAt(0).toUpperCase() + stat.slice(1).replace(/_/g, ' '),
        rank: idx + 1,
        avgAllowed: row.avg_stat,
      };
      rankings.push(ranking);

      // Cache to DB
      db.prepare(`
        INSERT OR REPLACE INTO team_defense_rankings (team, league, stat_type, rank, avg_allowed, updated_at)
        VALUES (?, 'NBA', ?, ?, ?, datetime('now'))
      `).run(row.opponent, ranking.statType, ranking.rank, ranking.avgAllowed);
    });
  }

  return rankings;
}

// ─── Player Averages ─────────────────────────────────────────────────────────

/**
 * Compute player averages over last N games from cached game logs.
 * If no cached data, fetches from ESPN first.
 */
export async function getPlayerAverages(
  playerName: string,
  games: number
): Promise<PlayerAverages | null> {
  const db = getDatabase();

  let rows = db.prepare(`
    SELECT * FROM player_game_logs
    WHERE player_name = ? AND league = 'NBA'
    ORDER BY game_date DESC
    LIMIT ?
  `).all(playerName, games) as Array<Record<string, unknown>>;

  // If no cached data, try to fetch
  if (rows.length === 0) {
    const player = await searchPlayer(playerName);
    if (!player) return null;
    await getGameLog(player.id, playerName);

    rows = db.prepare(`
      SELECT * FROM player_game_logs
      WHERE player_name = ? AND league = 'NBA'
      ORDER BY game_date DESC
      LIMIT ?
    `).all(playerName, games) as Array<Record<string, unknown>>;
  }

  if (rows.length === 0) return null;

  const avg = (field: string) =>
    rows.reduce((sum, r) => sum + ((r[field] as number) || 0), 0) / rows.length;

  return {
    playerName,
    games: rows.length,
    points: avg('points'),
    rebounds: avg('rebounds'),
    assists: avg('assists'),
    steals: avg('steals'),
    blocks: avg('blocks'),
    turnovers: avg('turnovers'),
    threePointersMade: avg('three_pointers_made'),
    fantasyScore: avg('fantasy_score'),
    ptsRebsAsts: avg('pts_rebs_asts'),
  };
}
