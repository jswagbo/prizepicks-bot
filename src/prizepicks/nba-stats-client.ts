/**
 * NBA Stats Client
 * 
 * Uses free ESPN APIs to fetch player game logs, team stats, and schedules.
 * Caches game logs to SQLite to avoid redundant fetches.
 */

import { getDatabase } from '../core/db/database';
import { execSync } from 'child_process';
import path from 'path';

// Path to Python venv and stats script
const VENV_PYTHON = path.resolve(__dirname, '../../.venv/bin/python3');
const STATS_SCRIPT = path.resolve(__dirname, '../../scripts/nba-stats.py');

/**
 * Call the Python nba_api bridge script and return parsed JSON.
 */
function callPythonStats(args: string[]): unknown | null {
  try {
    const result = execSync(
      `${VENV_PYTHON} ${STATS_SCRIPT} ${args.map(a => JSON.stringify(a)).join(' ')}`,
      { timeout: 30000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
    return JSON.parse(result.trim());
  } catch (err) {
    console.error('[NBA Stats] Python bridge error:', err instanceof Error ? err.message : err);
    return null;
  }
}

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
 * Search for an NBA player by name, returns athlete ID.
 * Primary: nba_api (Python) — most reliable, pulls from NBA.com
 * Fallback: ESPN site.web.api search
 */
export async function searchPlayer(name: string): Promise<PlayerSearchResult | null> {
  // Primary: nba_api via Python bridge
  const pyResult = callPythonStats(['player-search', name]) as PlayerSearchResult | null;
  if (pyResult?.id) {
    return pyResult;
  }

  // Fallback: ESPN site.web.api search
  try {
    const searchUrl = `https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(name)}&type=player&sport=basketball&league=nba&limit=3`;
    const res = await fetch(searchUrl, { headers: { 'Accept': 'application/json' } });
    
    if (res.ok) {
      const data = await res.json() as { items?: Array<{ id: string; displayName: string; teamRelationships?: Array<{ core: { abbreviation: string } }> }> };
      const items = data.items || [];
      if (items.length > 0) {
        const athlete = items[0];
        const team = athlete.teamRelationships?.[0]?.core?.abbreviation || '';
        return { id: athlete.id, name: athlete.displayName, team, position: '' };
      }
    }
  } catch {}

  return null;
}

// ─── Game Log ────────────────────────────────────────────────────────────────

/**
 * Fetch a player's game log and cache to SQLite.
 * Primary: nba_api (Python) — reliable NBA.com data
 * Fallback: ESPN gamelog API
 */
export async function getGameLog(
  playerId: string,
  playerName: string,
  season?: string
): Promise<GameLogEntry[]> {
  // Try nba_api first
  const pyArgs = ['game-log', playerName];
  if (season) { pyArgs.push('--season', season); }
  const pyResult = callPythonStats(pyArgs) as GameLogEntry[] | null;
  if (pyResult && pyResult.length > 0) {
    cacheGameLogs(playerName, 'NBA', pyResult);
    return pyResult;
  }

  // Fallback to ESPN
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

// ─── Odds API ────────────────────────────────────────────────────────────────

const ODDS_API_BASE = 'https://api.odds-api.io/v3';

interface OddsApiEvent {
  id: number;
  home: string;
  away: string;
  date: string;
  sport: { slug: string };
  league: { slug: string };
}

/**
 * Odds API response structure:
 * bookmakers: { "DraftKings": [ { name: "Spread", odds: [ { hdp: -1.5, home: "1.89", away: "1.93" }, ... ] }, ... ] }
 * The first spread entry (smallest absolute hdp) is the primary line.
 */

/**
 * Fetch NBA spreads from Odds-API.io.
 * Returns a map of "HOME_FULL_NAME vs AWAY_FULL_NAME" → spread (number, negative = home favored).
 * Free tier: max 2 bookmakers (DraftKings + FanDuel).
 */
async function fetchOddsApiSpreads(): Promise<Map<string, number>> {
  const spreads = new Map<string, number>();
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.log('[Odds API] No ODDS_API_KEY set, skipping');
    return spreads;
  }

  try {
    // Step 1: Get today's NBA events
    // Filter by date range: today to tomorrow (RFC3339)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 2); // 2 days out to catch evening games
    const fromDate = today.toISOString();
    const toDate = tomorrow.toISOString();
    
    const eventsRes = await fetch(
      `${ODDS_API_BASE}/events?sport=basketball&league=usa-nba&from=${fromDate}&to=${toDate}&apiKey=${apiKey}`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!eventsRes.ok) {
      console.error('[Odds API] Events fetch failed:', eventsRes.status);
      return spreads;
    }
    const events = (await eventsRes.json()) as OddsApiEvent[];
    console.log(`[Odds API] Found ${events.length} NBA events today`);
    if (!events.length) return spreads;

    // Step 2: Fetch odds for events in batches of 10
    for (let i = 0; i < events.length; i += 10) {
      const batch = events.slice(i, i + 10);
      const eventIds = batch.map(e => e.id).join(',');
      const oddsRes = await fetch(
        `${ODDS_API_BASE}/odds/multi?eventIds=${eventIds}&bookmakers=DraftKings,FanDuel&apiKey=${apiKey}`,
        { headers: { 'Accept': 'application/json' } }
      );
      if (!oddsRes.ok) {
        console.error('[Odds API] Odds fetch failed:', oddsRes.status);
        continue;
      }
      const oddsData = (await oddsRes.json()) as Array<{
        id: number;
        home: string;
        away: string;
        bookmakers: Record<string, Array<{ name: string; odds: Array<{ hdp?: number; home?: string; away?: string }> }>>;
      }>;

      for (const game of oddsData) {
        // Find spread from DraftKings first, then FanDuel
        for (const bk of ['DraftKings', 'FanDuel']) {
          const markets = game.bookmakers?.[bk] || [];
          const spreadMarket = markets.find(m => m.name === 'Spread');
          if (spreadMarket?.odds?.length) {
            // First entry is the primary line
            const primarySpread = spreadMarket.odds[0]?.hdp;
            if (primarySpread !== undefined) {
              spreads.set(`${game.home} vs ${game.away}`, primarySpread);
              console.log(`[Odds API] ${game.home} vs ${game.away}: spread ${primarySpread} (${bk})`);
              break;
            }
          }
        }
      }
    }

    console.log(`[Odds API] Got spreads for ${spreads.size}/${events.length} games`);
  } catch (err) {
    console.error('[Odds API] Error:', err instanceof Error ? err.message : err);
  }

  return spreads;
}

// NBA team name → abbreviation mapping for matching Odds API names to ESPN abbreviations
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

function teamNameToAbbrev(name: string): string {
  return TEAM_ABBREV[name] || name;
}

// ─── Today's Games ───────────────────────────────────────────────────────────

/**
 * Get today's NBA schedule with spreads.
 * Sources: nba_api (games) + ESPN (fallback) + Odds-API.io (spreads)
 */
export async function getTodaysGames(): Promise<TodaysGame[]> {
  // Try nba_api first for game list
  const pyGames = callPythonStats(['today-games']) as TodaysGame[] | null;
  
  // Also fetch ESPN for fallback game data
  const data = await espnFetch(
    '/site/v2/sports/basketball/nba/scoreboard'
  ) as { events?: Array<Record<string, unknown>> };

  const espnGames = (data.events || []).map((event: any) => {
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

  // Fetch spreads from Odds API (most reliable source — also provides game list)
  const oddsApiSpreads = await fetchOddsApiSpreads();

  // Determine base game list
  let games: TodaysGame[];
  if (pyGames && pyGames.length > 0) {
    // Merge ESPN spreads into nba_api games
    for (const game of pyGames) {
      const espnMatch = espnGames.find(
        (eg: TodaysGame) => eg.homeTeam === game.homeTeam || eg.awayTeam === game.awayTeam
      );
      if (espnMatch?.spread != null) {
        game.spread = espnMatch.spread;
      }
    }
    games = pyGames;
  } else {
    games = espnGames;
  }

  // Build a set of teams already in our game list
  const teamsInGames = new Set<string>();
  for (const g of games) {
    teamsInGames.add(g.homeTeam);
    teamsInGames.add(g.awayTeam);
  }

  // Overlay Odds API spreads AND add missing games from Odds API
  // (handles case where ESPN/nba_api shows yesterday's slate but Odds API has today's)
  if (oddsApiSpreads.size > 0) {
    for (const [matchup, spread] of oddsApiSpreads) {
      const parts = matchup.split(' vs ');
      const homeAbbr = teamNameToAbbrev(parts[0]?.trim());
      const awayAbbr = teamNameToAbbrev(parts[1]?.trim());

      // Try to match to existing game
      const existingGame = games.find(
        g => (g.homeTeam === homeAbbr && g.awayTeam === awayAbbr) ||
             (g.homeTeam === awayAbbr && g.awayTeam === homeAbbr)
      );

      if (existingGame) {
        // Update spread on existing game
        if (existingGame.homeTeam === awayAbbr) {
          existingGame.spread = -spread;
        } else {
          existingGame.spread = spread;
        }
        console.log(`[Odds API] Matched ${existingGame.awayTeam} @ ${existingGame.homeTeam} → spread: ${existingGame.spread}`);
      } else {
        // Game not in ESPN/nba_api list (exact pair not found) — add from Odds API
        // This handles early-morning when ESPN shows yesterday's slate
        games.push({
          gameId: `odds-${homeAbbr}-${awayAbbr}`,
          homeTeam: homeAbbr,
          awayTeam: awayAbbr,
          homeTeamId: '',
          awayTeamId: '',
          startTime: '',
          status: 'Scheduled',
          spread,
        });
        teamsInGames.add(homeAbbr);
        teamsInGames.add(awayAbbr);
        console.log(`[Odds API] Added game: ${awayAbbr} @ ${homeAbbr} (spread: ${spread}) — not in ESPN/nba_api`);
      }
    }
  }

  return games;
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
