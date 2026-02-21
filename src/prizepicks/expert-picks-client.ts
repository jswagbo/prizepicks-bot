/**
 * Expert Picks Client
 * 
 * Scrapes expert/sharp picks and consensus data from free sources.
 * Used to validate our model's picks against public/expert opinion.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExpertPick {
  source: string; // "ESPN", "Covers", "ActionNetwork", "PrizePicks Popular"
  playerName: string;
  statType: string;
  pick: 'OVER' | 'UNDER';
  line: number;
  confidence?: number;
  reasoning?: string;
}

export interface ConsensusData {
  playerName: string;
  statType: string;
  overPercent: number; // % of public on OVER
  underPercent: number;
  sharpMoney?: 'OVER' | 'UNDER'; // which side sharp money is on
  expertPicks: ExpertPick[];
}

// ─── In-Memory Cache ─────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour
const expertPicksCache = new Map<string, CacheEntry<ExpertPick[]>>();
const consensusCache = new Map<string, CacheEntry<ConsensusData>>();

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  
  const age = Date.now() - entry.timestamp;
  if (age > CACHE_DURATION_MS) {
    cache.delete(key);
    return null;
  }
  
  return entry.data;
}

function setCache<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

// ─── Fetch Helpers ───────────────────────────────────────────────────────────

async function safeFetch(url: string, source: string): Promise<unknown> {
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      },
    });
    
    if (!res.ok) {
      console.log(`[Expert Picks] ${source} returned ${res.status}`);
      return null;
    }
    
    return res.json();
  } catch (err) {
    console.log(`[Expert Picks] ${source} fetch failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── ESPN Expert Picks ───────────────────────────────────────────────────────

/**
 * Try to fetch ESPN expert picks/consensus.
 * ESPN doesn't have a public player props expert picks API,
 * so this is a placeholder that returns empty for now.
 */
async function fetchESPNPicks(): Promise<ExpertPick[]> {
  console.log('[Expert Picks] ESPN: Not available (no public player props expert picks API)');
  return [];
}

// ─── Covers.com Consensus ────────────────────────────────────────────────────

/**
 * Scrape Covers.com for public betting consensus.
 * Note: Covers.com primarily shows game totals/spreads, not player props.
 * This is a placeholder — web scraping would be needed for real data.
 */
async function fetchCoversPicks(): Promise<ExpertPick[]> {
  console.log('[Expert Picks] Covers.com: Skipped (requires web scraping, not API-based)');
  return [];
}

// ─── Action Network ──────────────────────────────────────────────────────────

/**
 * Check Action Network for free consensus data.
 * Their API is mostly locked behind authentication, so this returns empty.
 */
async function fetchActionNetworkPicks(): Promise<ExpertPick[]> {
  console.log('[Expert Picks] Action Network: Not available (requires auth/subscription)');
  return [];
}

// ─── PrizePicks Popular Picks ────────────────────────────────────────────────

/**
 * Extract popularity/consensus from PrizePicks API if available.
 * The PrizePicks API may include popularity metadata in projection attributes.
 * This is speculative — would need to inspect actual API responses.
 */
async function fetchPrizePicksPopular(): Promise<ExpertPick[]> {
  try {
    const res = await fetch('https://api.prizepicks.com/projections?league_id=7', {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!res.ok) {
      console.log(`[Expert Picks] PrizePicks API error: ${res.status}`);
      return [];
    }
    
    const data = await res.json() as any;
    const picks: ExpertPick[] = [];
    
    // Check if API includes popularity data (this is hypothetical)
    // Real implementation would inspect actual response structure
    for (const proj of data.data || []) {
      const attrs = proj.attributes || {};
      const popularity = attrs.popularity_percent; // hypothetical field
      
      if (popularity && popularity > 70) {
        // If more than 70% of users pick one side, it's "popular"
        const playerData = data.included?.find(
          (i: any) => i.type === 'new_player' && i.id === proj.relationships?.new_player?.data?.id
        );
        
        if (playerData) {
          picks.push({
            source: 'PrizePicks Popular',
            playerName: playerData.attributes?.name || '',
            statType: attrs.stat_type || '',
            pick: popularity > 50 ? 'OVER' : 'UNDER',
            line: attrs.line_score || 0,
            confidence: Math.round(popularity / 20), // convert % to 1-5 scale
          });
        }
      }
    }
    
    console.log(`[Expert Picks] PrizePicks Popular: ${picks.length} picks found`);
    return picks;
    
  } catch (err) {
    console.log('[Expert Picks] PrizePicks Popular error:', err instanceof Error ? err.message : err);
    return [];
  }
}

// ─── Main Exports ────────────────────────────────────────────────────────────

/**
 * Fetch expert picks from all available sources.
 * Returns cached data if available (1 hour TTL).
 */
export async function getExpertPicks(): Promise<ExpertPick[]> {
  const cacheKey = 'all-expert-picks';
  const cached = getCached(expertPicksCache, cacheKey);
  if (cached) {
    console.log('[Expert Picks] Using cached data');
    return cached;
  }

  console.log('[Expert Picks] Fetching from all sources...');
  
  // Fetch from all sources in parallel, ignore failures
  const [espn, covers, actionNetwork, prizePicksPopular] = await Promise.all([
    fetchESPNPicks().catch(() => []),
    fetchCoversPicks().catch(() => []),
    fetchActionNetworkPicks().catch(() => []),
    fetchPrizePicksPopular().catch(() => []),
  ]);

  const allPicks = [...espn, ...covers, ...actionNetwork, ...prizePicksPopular];
  
  console.log(`[Expert Picks] Total: ${allPicks.length} expert picks collected`);
  console.log(`[Expert Picks] Sources: ESPN=${espn.length}, Covers=${covers.length}, ActionNetwork=${actionNetwork.length}, PP Popular=${prizePicksPopular.length}`);
  
  setCache(expertPicksCache, cacheKey, allPicks);
  return allPicks;
}

/**
 * Get consensus data for a specific player/stat combination.
 * Aggregates expert picks and calculates OVER/UNDER percentages.
 */
export async function getConsensusForPick(
  playerName: string,
  statType: string
): Promise<ConsensusData | null> {
  const cacheKey = `${playerName}-${statType}`;
  const cached = getCached(consensusCache, cacheKey);
  if (cached) return cached;

  const allPicks = await getExpertPicks();
  
  // Filter picks for this specific player/stat
  const matchingPicks = allPicks.filter(
    (p) =>
      p.playerName.toLowerCase() === playerName.toLowerCase() &&
      p.statType.toLowerCase().includes(statType.toLowerCase())
  );

  if (matchingPicks.length === 0) {
    return null;
  }

  // Calculate consensus
  const overCount = matchingPicks.filter((p) => p.pick === 'OVER').length;
  const underCount = matchingPicks.filter((p) => p.pick === 'UNDER').length;
  const total = overCount + underCount;

  const overPercent = total > 0 ? (overCount / total) * 100 : 50;
  const underPercent = 100 - overPercent;

  // Determine sharp money (if 70%+ of "high confidence" picks agree)
  const highConfidencePicks = matchingPicks.filter((p) => (p.confidence || 0) >= 4);
  let sharpMoney: 'OVER' | 'UNDER' | undefined;
  
  if (highConfidencePicks.length >= 2) {
    const sharpOvers = highConfidencePicks.filter((p) => p.pick === 'OVER').length;
    const sharpTotal = highConfidencePicks.length;
    const sharpOverPercent = (sharpOvers / sharpTotal) * 100;
    
    if (sharpOverPercent >= 70) sharpMoney = 'OVER';
    else if (sharpOverPercent <= 30) sharpMoney = 'UNDER';
  }

  const consensus: ConsensusData = {
    playerName,
    statType,
    overPercent,
    underPercent,
    sharpMoney,
    expertPicks: matchingPicks,
  };

  setCache(consensusCache, cacheKey, consensus);
  return consensus;
}
