/**
 * PrizePicks API Client
 * 
 * Fetches and parses projections from the PrizePicks API.
 * No API key needed — public endpoint.
 */

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
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://app.prizepicks.com/',
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
    };
  });
}

/**
 * Fetch all projections, optionally filtered by league
 */
export async function getProjections(league?: string): Promise<PrizePicksProjection[]> {
  const url = `${API_BASE}/projections?per_page=250&single_stat=true&game_mode=pickem`;
  const res = await fetch(url, { headers: HEADERS });

  if (!res.ok) {
    throw new Error(`PrizePicks API error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as PPApiResponse;
  let projections = parseProjections(json);

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
