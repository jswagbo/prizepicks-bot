/**
 * Odds Service — Unified Player Props & Spreads Fetcher
 *
 * Primary: The Odds API (the-odds-api.com) — Pinnacle lines only
 * Fallback: odds-api.io (existing ODDS_API_KEY)
 *
 * Caches results for 30 minutes to avoid hammering APIs.
 */

import 'dotenv/config';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BookLine {
  book: string;           // "Pinnacle"
  playerName: string;
  statType: string;       // "Points", "Rebounds", "Assists", etc.
  line: number;           // e.g. 22.5
  overPrice: number;      // decimal odds, e.g. 1.83
  underPrice: number;     // decimal odds, e.g. 1.91
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

let playerPropsCache: { data: BookLine[]; timestamp: number } | null = null;
let spreadsCache: { data: Map<string, number>; timestamp: number } | null = null;
let pinnacleCache: { data: BookLine[]; timestamp: number } | null = null;
let totalsCache: { data: Map<string, number>; timestamp: number } | null = null;
let teamTotalsCache: { data: Map<string, number>; timestamp: number } | null = null;

// ─── The Odds API Stat Type Mapping ──────────────────────────────────────────

const ODDS_API_MARKET_MAP: Record<string, string> = {
  'player_points': 'Points',
  'player_rebounds': 'Rebounds',
  'player_assists': 'Assists',
  'player_threes': '3-PT Made',
  'player_blocks': 'Blocked Shots',
  'player_steals': 'Steals',
  'player_turnovers': 'Turnovers',
  'player_points_rebounds_assists': 'Pts+Rebs+Asts',
  'player_points_rebounds': 'Pts+Rebs',
  'player_points_assists': 'Pts+Asts',
  'player_rebounds_assists': 'Rebs+Asts',
  'player_blocks_steals': 'Blks+Stls',
  'player_double_double': 'Double Double',
  'player_first_basket': 'First Basket',
};

const PLAYER_PROP_MARKETS = [
  'player_points',
  'player_rebounds',
  'player_assists',
  'player_threes',
  'player_blocks',
  'player_steals',
  'player_turnovers',
  'player_points_rebounds_assists',
  'player_points_rebounds',
  'player_points_assists',
  'player_rebounds_assists',
  'player_blocks_steals',
  'player_double_double',
  'player_first_basket',
].join(',');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function americanToDecimal(american: number): number {
  if (american > 0) return (american / 100) + 1;
  return (100 / Math.abs(american)) + 1;
}

interface TheOddsApiEvent {
  id: string;
  sport_key: string;
  home_team: string;
  away_team: string;
  commence_time: string;
}

// ─── Primary: The Odds API (the-odds-api.com) ───────────────────────────────

async function fetchTheOddsApiProps(
  bookmakers: string = 'pinnacle'
): Promise<BookLine[]> {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    console.log('[OddsAPI] THE_ODDS_API_KEY not set, skipping');
    return [];
  }

  const lines: BookLine[] = [];

  try {
    console.log('[OddsAPI] Fetching NBA events...');
    const eventsRes = await fetch(
      `https://api.the-odds-api.com/v4/sports/basketball_nba/events?apiKey=${apiKey}`
    );
    if (!eventsRes.ok) {
      console.log(`[OddsAPI] Events HTTP ${eventsRes.status}`);
      return [];
    }

    const events = await eventsRes.json() as TheOddsApiEvent[];
    // Filter to today's events (or upcoming within ~18h for early fetches)
    const now = Date.now();
    const cutoff = now + 18 * 60 * 60 * 1000;
    const todayEvents = events.filter(e => {
      const t = new Date(e.commence_time).getTime();
      return t >= now - 2 * 60 * 60 * 1000 && t <= cutoff; // from 2h ago to 18h ahead
    });

    console.log(`[OddsAPI] ${todayEvents.length} upcoming events (of ${events.length} total)`);

    for (const event of todayEvents) {
      try {
        const oddsRes = await fetch(
          `https://api.the-odds-api.com/v4/sports/basketball_nba/events/${event.id}/odds` +
          `?apiKey=${apiKey}&regions=us,eu&markets=${PLAYER_PROP_MARKETS}&bookmakers=${bookmakers}`
        );
        if (!oddsRes.ok) {
          console.log(`[OddsAPI] Event ${event.id} HTTP ${oddsRes.status}`);
          continue;
        }

        // Log remaining credits from headers
        const remaining = oddsRes.headers.get('x-requests-remaining');
        if (remaining) console.log(`[OddsAPI] Credits remaining: ${remaining}`);

        const oddsData = await oddsRes.json() as any;

        for (const bookmaker of (oddsData.bookmakers || [])) {
          const bookName = bookmaker.title || bookmaker.key;

          for (const market of (bookmaker.markets || [])) {
            const statType = ODDS_API_MARKET_MAP[market.key];
            if (!statType) continue;

            // The Odds API returns outcomes as pairs: Over/Under for each player
            // Group by description (player name)
            const playerGroups = new Map<string, { over?: any; under?: any; line?: number }>();

            for (const outcome of (market.outcomes || [])) {
              const playerName = outcome.description;
              if (!playerName) continue;

              if (!playerGroups.has(playerName)) {
                playerGroups.set(playerName, {});
              }
              const group = playerGroups.get(playerName)!;

              if (outcome.name === 'Over') {
                group.over = outcome;
                group.line = outcome.point;
              } else if (outcome.name === 'Under') {
                group.under = outcome;
                if (group.line == null) group.line = outcome.point;
              }
            }

            for (const [playerName, group] of playerGroups) {
              if (group.line == null) continue;

              const overPrice = group.over?.price != null ? americanToDecimal(group.over.price) : 1.91;
              const underPrice = group.under?.price != null ? americanToDecimal(group.under.price) : 1.91;

              lines.push({
                book: bookName,
                playerName,
                statType,
                line: group.line,
                overPrice,
                underPrice,
              });
            }
          }
        }

        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.log(`[OddsAPI] Error for event ${event.id}:`, err instanceof Error ? err.message : err);
      }
    }

    console.log(`[OddsAPI] Fetched ${lines.length} lines from ${bookmakers}`);
  } catch (err) {
    console.error('[OddsAPI] Error:', err instanceof Error ? err.message : err);
  }

  return lines;
}

// ─── Fallback: odds-api.io (existing) ────────────────────────────────────────

async function fetchOddsApiIoProps(): Promise<BookLine[]> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.log('[OddsIO] ODDS_API_KEY not set, skipping fallback');
    return [];
  }

  const allLines: BookLine[] = [];

  try {
    console.log('[OddsIO] Fetching events (fallback)...');
    const eventsRes = await fetch(
      `https://api.odds-api.io/v3/events?sport=basketball&league=usa-nba&apiKey=${apiKey}`
    );
    if (!eventsRes.ok) {
      console.error(`[OddsIO] Events API error: ${eventsRes.status}`);
      return [];
    }

    const events = (await eventsRes.json()) as Array<{
      id: number; home: string; away: string; date: string; status: string;
    }>;

    const todayStr = new Date().toISOString().slice(0, 10);
    const pendingEvents = events.filter(e =>
      e.status === 'pending' && e.date.slice(0, 10) === todayStr
    );

    console.log(`[OddsIO] ${pendingEvents.length} pending games today`);

    for (const event of pendingEvents) {
      try {
        const oddsRes = await fetch(
          `https://api.odds-api.io/v3/odds?sport=basketball&league=usa-nba` +
          `&eventId=${event.id}&oddsType=player_props` +
          `&bookmakers=Pinnacle&apiKey=${apiKey}`
        );
        if (!oddsRes.ok) continue;

        const oddsData = (await oddsRes.json()) as {
          bookmakers: Record<string, Array<{
            name: string;
            odds: Array<{ label: string; hdp: number; over: string; under: string }>;
          }>>;
        };

        for (const [bookName, markets] of Object.entries(oddsData.bookmakers || {})) {
          const propsMarket = markets.find(m => m.name === 'Player Props');
          if (!propsMarket) continue;

          for (const prop of propsMarket.odds) {
            const match = prop.label.match(/^(.+?)\s*\((.+)\)$/);
            if (!match) continue;

            const line = prop.hdp;
            const overPrice = parseFloat(prop.over);
            const underPrice = parseFloat(prop.under);

            if (line == null || isNaN(line) || isNaN(overPrice) || isNaN(underPrice)) continue;

            allLines.push({
              book: bookName,
              playerName: match[1].trim(),
              statType: match[2].trim(),
              line,
              overPrice,
              underPrice,
            });
          }
        }

        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.log(`[OddsIO] Error for event ${event.id}:`, err instanceof Error ? err.message : err);
      }
    }

    console.log(`[OddsIO] Fetched ${allLines.length} player prop lines`);
  } catch (err) {
    console.error('[OddsIO] Error:', err instanceof Error ? err.message : err);
  }

  return allLines;
}

// ─── Pinnacle Lines (via The Odds API) ───────────────────────────────────────

/**
 * Fetch Pinnacle-only lines. These are the sharpest book lines.
 * Cached separately since sharps-intel uses them independently.
 */
export async function fetchPinnacleLines(): Promise<BookLine[]> {
  if (pinnacleCache && Date.now() - pinnacleCache.timestamp < CACHE_TTL) {
    return pinnacleCache.data;
  }

  // Pinnacle lines come from The Odds API only
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    console.log('[Odds] No THE_ODDS_API_KEY — cannot fetch Pinnacle lines');
    return [];
  }

  const lines = await fetchTheOddsApiProps('pinnacle');
  pinnacleCache = { data: lines, timestamp: Date.now() };
  return lines;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch player props — tries The Odds API first, falls back to odds-api.io.
 * Results are cached for 30 minutes.
 */
export async function fetchPlayerProps(): Promise<BookLine[]> {
  if (playerPropsCache && Date.now() - playerPropsCache.timestamp < CACHE_TTL) {
    console.log(`[Odds] Returning cached props (${playerPropsCache.data.length} lines)`);
    return playerPropsCache.data;
  }

  // Primary: The Odds API (Pinnacle only)
  let lines = await fetchTheOddsApiProps('pinnacle');

  if (lines.length === 0) {
    console.log('[Odds] The Odds API returned 0 lines, falling back to odds-api.io...');
    lines = await fetchOddsApiIoProps();
  }

  if (lines.length === 0) {
    console.log('[Odds] Both sources returned 0 lines');
  }

  playerPropsCache = { data: lines, timestamp: Date.now() };
  return lines;
}

/**
 * Fetch game spreads for blowout detection.
 * Returns Map<"Team1 vs Team2", spread> (home team perspective).
 */
export async function fetchGameSpreads(): Promise<Map<string, number>> {
  if (spreadsCache && Date.now() - spreadsCache.timestamp < CACHE_TTL) {
    return spreadsCache.data;
  }

  const spreads = new Map<string, number>();

  // Try The Odds API first
  const theOddsKey = process.env.THE_ODDS_API_KEY;
  const oddsIoKey = process.env.ODDS_API_KEY;
  const apiKey = theOddsKey || oddsIoKey;

  if (theOddsKey) {
    try {
      const res = await fetch(
        `https://api.the-odds-api.com/v4/sports/basketball_nba/odds?apiKey=${theOddsKey}&regions=us,eu&markets=spreads&bookmakers=pinnacle`
      );
      if (res.ok) {
        const data = await res.json() as any[];
        for (const event of data) {
          for (const bookmaker of (event.bookmakers || [])) {
            for (const market of (bookmaker.markets || [])) {
              if (market.key !== 'spreads') continue;
              for (const outcome of (market.outcomes || [])) {
                if (outcome.point != null) {
                  const gameKey = `${event.home_team} vs ${event.away_team}`;
                  if (!spreads.has(gameKey)) {
                    spreads.set(gameKey, outcome.point);
                  }
                }
              }
            }
            break; // Only first bookmaker
          }
        }
        console.log(`[Odds] Fetched ${spreads.size} game spreads`);
      }
    } catch (err) {
      console.error('[Odds] Spreads error:', err instanceof Error ? err.message : err);
    }
  }

  spreadsCache = { data: spreads, timestamp: Date.now() };
  return spreads;
}

/**
 * Fetch Vegas over/under game totals for blowout detection and game-environment scoring.
 * Returns Map<"Team1 vs Team2", total> — home_team vs away_team format.
 * Cached for 30 minutes like spreads.
 */
export async function fetchGameTotals(): Promise<Map<string, number>> {
  if (totalsCache && Date.now() - totalsCache.timestamp < CACHE_TTL) {
    return totalsCache.data;
  }

  const totals = new Map<string, number>();

  const theOddsKey = process.env.THE_ODDS_API_KEY;
  if (!theOddsKey) {
    console.log('[Odds] No THE_ODDS_API_KEY — cannot fetch game totals');
    totalsCache = { data: totals, timestamp: Date.now() };
    return totals;
  }

  try {
    const res = await fetch(
      `https://api.the-odds-api.com/v4/sports/basketball_nba/odds` +
        `?apiKey=${theOddsKey}&regions=us,eu&markets=totals&bookmakers=pinnacle`
    );

    if (res.ok) {
      const data = (await res.json()) as any[];
      for (const event of data) {
        const gameKey = `${event.home_team} vs ${event.away_team}`;
        let foundTotal = false;

        for (const bookmaker of event.bookmakers || []) {
          if (foundTotal) break;
          for (const market of bookmaker.markets || []) {
            if (market.key !== 'totals') continue;
            for (const outcome of market.outcomes || []) {
              if (outcome.name === 'Over' && outcome.point != null) {
                totals.set(gameKey, outcome.point);
                foundTotal = true;
                break;
              }
            }
            if (foundTotal) break;
          }
        }
      }
      console.log(`[Odds] Fetched ${totals.size} game totals`);

      // Log remaining credits
      const remaining = res.headers.get('x-requests-remaining');
      if (remaining) console.log(`[OddsAPI] Credits remaining: ${remaining}`);
    } else {
      console.log(`[Odds] Totals HTTP ${res.status}`);
    }
  } catch (err) {
    console.error('[Odds] Totals error:', err instanceof Error ? err.message : err);
  }

  totalsCache = { data: totals, timestamp: Date.now() };
  return totals;
}

/**
 * Fetch team-specific over/under totals from The Odds API.
 * Returns Map<teamName, expectedTotal> — e.g. "Los Angeles Lakers" → 118.5
 * Cached for 30 minutes like other functions.
 *
 * More precise than game total / 2 because it accounts for pace asymmetry
 * between teams (fast team vs slow team = different team totals even if
 * the combined game total is the same).
 */
export async function fetchTeamTotals(): Promise<Map<string, number>> {
  if (teamTotalsCache && Date.now() - teamTotalsCache.timestamp < CACHE_TTL) {
    return teamTotalsCache.data;
  }

  const teamTotals = new Map<string, number>();

  const theOddsKey = process.env.THE_ODDS_API_KEY;
  if (!theOddsKey) {
    console.log('[Odds] No THE_ODDS_API_KEY — cannot fetch team totals');
    teamTotalsCache = { data: teamTotals, timestamp: Date.now() };
    return teamTotals;
  }

  try {
    // team_totals requires the per-event endpoint, not the bulk /odds endpoint (returns 422)
    console.log('[Odds] Fetching events for team totals...');
    const eventsRes = await fetch(
      `https://api.the-odds-api.com/v4/sports/basketball_nba/events?apiKey=${theOddsKey}`
    );
    if (!eventsRes.ok) {
      console.log(`[Odds] Team totals events HTTP ${eventsRes.status}`);
      teamTotalsCache = { data: teamTotals, timestamp: Date.now() };
      return teamTotals;
    }

    const events = await eventsRes.json() as TheOddsApiEvent[];
    const now = Date.now();
    const cutoff = now + 18 * 60 * 60 * 1000;
    const todayEvents = events.filter(e => {
      const t = new Date(e.commence_time).getTime();
      return t >= now - 2 * 60 * 60 * 1000 && t <= cutoff;
    });

    console.log(`[Odds] Fetching team totals for ${todayEvents.length} events...`);

    for (const event of todayEvents) {
      try {
        const res = await fetch(
          `https://api.the-odds-api.com/v4/sports/basketball_nba/events/${event.id}/odds` +
            `?apiKey=${theOddsKey}&regions=us,eu&markets=team_totals&bookmakers=pinnacle`
        );
        if (!res.ok) {
          console.log(`[Odds] Team totals event ${event.id} HTTP ${res.status}`);
          continue;
        }

        const remaining = res.headers.get('x-requests-remaining');
        if (remaining) console.log(`[OddsAPI] Credits remaining: ${remaining}`);

        const oddsData = await res.json() as any;
        for (const bookmaker of oddsData.bookmakers || []) {
          for (const market of bookmaker.markets || []) {
            if (market.key !== 'team_totals') continue;
            for (const outcome of market.outcomes || []) {
              if (outcome.name === 'Over' && outcome.description && outcome.point != null) {
                if (!teamTotals.has(outcome.description)) {
                  teamTotals.set(outcome.description, outcome.point);
                }
              }
            }
          }
          break; // Only first bookmaker per event
        }

        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.log(`[Odds] Team totals event ${event.id} error:`, err instanceof Error ? err.message : err);
      }
    }

    console.log(`[Odds] Fetched ${teamTotals.size} team totals`);
  } catch (err) {
    console.error('[Odds] Team totals error:', err instanceof Error ? err.message : err);
  }

  teamTotalsCache = { data: teamTotals, timestamp: Date.now() };
  return teamTotals;
}
