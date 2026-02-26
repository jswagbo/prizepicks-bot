/**
 * PrizePicks API Client
 *
 * Fetches and parses projections from the PrizePicks API.
 * No API key needed — public endpoint.
 *
 * Fallback: If the API returns 403 (PerimeterX block), spawns a
 * Scrapling-based browser scraper (scripts/fetch-prizepicks.py)
 * that loads the web app and intercepts projections data.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';

export interface PrizePicksProjection {
  id: string;
  playerName: string;
  playerId: string;
  team: string;
  position: string;
  league: string;
  statType: string;
  line: number;
  startTime: string;
  description: string;
  isPromo: boolean;
  flashSaleLine: number | null;
  projectionType: string;
  imageUrl: string;
  /** "standard" = normal line, "demon" = juiced higher, "goblin" = juiced lower */
  oddsType: string;
  /** "team" = full game, "team_with_duration" = 1H/1Q props */
  eventType: string;
}

interface PPApiResponse {
  data: PPProjectionData[];
  included: PPIncludedItem[];
}

interface PPProjectionData {
  id: string;
  type: string;
  attributes: {
    stat_type: string;
    line_score: number;
    start_time: string;
    description: string;
    is_promo: boolean;
    flash_sale_line_score: number | null;
    projection_type: string;
    odds_type: string;
    event_type: string;
    [key: string]: unknown;
  };
  relationships: {
    new_player?: { data: { id: string; type: string } };
    league?: { data: { id: string; type: string } };
    [key: string]: unknown;
  };
}

interface PPIncludedItem {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
}

const API_BASE = 'https://api.prizepicks.com';

const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://app.prizepicks.com/',
  'Origin': 'https://app.prizepicks.com',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
};

/**
 * Parse the PrizePicks API response into clean typed objects
 */
function parseProjections(response: PPApiResponse): PrizePicksProjection[] {
  const playersMap = new Map<string, PPIncludedItem>();
  const leaguesMap = new Map<string, PPIncludedItem>();

  for (const item of response.included || []) {
    if (item.type === 'new_player') {
      playersMap.set(item.id, item);
    } else if (item.type === 'league') {
      leaguesMap.set(item.id, item);
    }
  }

  return (response.data || []).map((proj) => {
    const playerRef = proj.relationships?.new_player?.data;
    const leagueRef = proj.relationships?.league?.data;
    const player = playerRef ? playersMap.get(playerRef.id) : undefined;
    const league = leagueRef ? leaguesMap.get(leagueRef.id) : undefined;

    const playerAttrs = player?.attributes || {};
    const leagueAttrs = league?.attributes || {};

    return {
      id: proj.id,
      playerName: (playerAttrs.display_name as string) || (playerAttrs.name as string) || 'Unknown',
      playerId: player?.id || '',
      team: (playerAttrs.team as string) || '',
      position: (playerAttrs.position as string) || '',
      league: (leagueAttrs.name as string) || '',
      statType: proj.attributes.stat_type,
      line: proj.attributes.line_score,
      startTime: proj.attributes.start_time,
      description: proj.attributes.description || '',
      isPromo: proj.attributes.is_promo || false,
      flashSaleLine: proj.attributes.flash_sale_line_score,
      projectionType: proj.attributes.projection_type || '',
      imageUrl: (playerAttrs.image_url as string) || '',
      oddsType: proj.attributes.odds_type || 'standard',
      eventType: proj.attributes.event_type || 'team',
    };
  });
}

/**
 * Resolve the Python interpreter that has Scrapling installed.
 */
function findScraplingPython(): string {
  const projectRoot = path.resolve(__dirname, '..', '..');
  // Check scrapling-env first (has Scrapling installed), then project venv
  const candidates = [
    path.join(process.env.HOME || '~', 'scrapling-env', 'bin', 'python3'),
    path.join(projectRoot, '.venv', 'bin', 'python3'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return 'python3';
}

/**
 * Run the Scrapling-based PrizePicks scraper as a child process.
 * Returns parsed projections or empty array on failure.
 */
function runScraperFallback(): PrizePicksProjection[] {
  const python = findScraplingPython();
  const scriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'fetch-prizepicks.py');

  if (!existsSync(scriptPath)) {
    console.error('[PrizePicks] Scraper script not found:', scriptPath);
    return [];
  }

  console.log(`[PrizePicks] API blocked, falling back to browser scraper`);
  console.log(`[PrizePicks] Running: ${python} ${scriptPath}`);

  try {
    const stdout = execFileSync(python, [scriptPath], {
      encoding: 'utf-8',
      timeout: 120_000, // 2 min — browser launch + page load
      maxBuffer: 10 * 1024 * 1024,
    });

    const raw = JSON.parse(stdout.trim());

    // Scraper returns raw API format: {data: [], included: []}
    if (raw && raw.data && Array.isArray(raw.data)) {
      const projections = parseProjections(raw as PPApiResponse);
      console.log(`[PrizePicks] Scraper returned ${projections.length} projections`);
      return projections;
    }

    // Legacy format: array of pre-parsed objects
    if (Array.isArray(raw) && raw.length > 0) {
      console.log(`[PrizePicks] Scraper returned ${raw.length} projections (legacy format)`);
      return raw.map((r: Record<string, unknown>) => ({
        id: String(r.id ?? ''),
        playerName: String(r.playerName ?? ''),
        playerId: String(r.playerId ?? ''),
        team: String(r.team ?? ''),
        position: String(r.position ?? ''),
        league: String(r.league ?? 'NBA'),
        statType: String(r.statType ?? ''),
        line: Number(r.line ?? 0),
        startTime: String(r.startTime ?? ''),
        description: String(r.description ?? ''),
        isPromo: Boolean(r.isPromo),
        flashSaleLine: r.flashSaleLine != null ? Number(r.flashSaleLine) : null,
        projectionType: String(r.projectionType ?? ''),
        imageUrl: String(r.imageUrl ?? ''),
        oddsType: String(r.oddsType ?? 'standard'),
        eventType: String(r.eventType ?? 'team'),
      }));
    }

    console.warn('[PrizePicks] Scraper returned no projections');
    return [];
  } catch (err) {
    console.error('[PrizePicks] Scraper failed:', (err as Error).message);
    return [];
  }
}

/**
 * Fetch all projections, optionally filtered by league.
 * Falls back to browser scraper if API returns 403 (PerimeterX block).
 */
export async function getProjections(league?: string): Promise<PrizePicksProjection[]> {
  const url = `${API_BASE}/projections?per_page=250&single_stat=true&game_mode=pickem`;

  let projections: PrizePicksProjection[];

  try {
    const res = await fetch(url, { headers: HEADERS });

    if (res.status === 403) {
      // PerimeterX block — fall back to browser scraper
      projections = runScraperFallback();
    } else if (!res.ok) {
      throw new Error(`PrizePicks API error: ${res.status} ${res.statusText}`);
    } else {
      const json = (await res.json()) as PPApiResponse;
      projections = parseProjections(json);

      // Filter to standard lines only (exclude demon/goblin juiced lines)
      // and full-game props only (exclude 1H/1Q duration props)
      const beforeFilter = projections.length;
      projections = projections.filter(
        (p) => p.oddsType === 'standard' && p.eventType === 'team'
      );
      console.log(`[PrizePicks] ${beforeFilter} total → ${projections.length} standard full-game lines (filtered ${beforeFilter - projections.length} demon/goblin/duration)`);
    }
  } catch (err) {
    // Network error or other fetch failure — try scraper
    console.warn(`[PrizePicks] API fetch failed: ${(err as Error).message}`);
    projections = runScraperFallback();
  }

  if (league) {
    projections = projections.filter(
      (p) => p.league.toUpperCase() === league.toUpperCase()
    );
  }

  return projections;
}

/**
 * Get today's projections
 */
export async function getTodaysProjections(league?: string): Promise<PrizePicksProjection[]> {
  return getProjections(league);
}

/**
 * Get projections filtered to a specific date (by start_time)
 */
export async function getProjectionsByDate(
  date: string,
  league?: string
): Promise<PrizePicksProjection[]> {
  const projections = await getProjections(league);
  return projections.filter((p) => p.startTime.startsWith(date));
}
