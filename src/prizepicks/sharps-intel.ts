/**
 * Sharps Intel — Sharp Money & Expert Capper Signal Detection
 *
 * Aggregates signals from multiple sources:
 * 1. Pinnacle line comparison (sharpest book via The Odds API)
 * 2. Expert capper picks from Covers, OddsShark, Action Network articles
 * 3. Twitter/X sharp cappers (via web search — scrapes their posted picks)
 * 4. Line movement detection (tracks in SQLite)
 */

import { getDatabase } from '../core/db/database';
import { fetchPinnacleLines, fetchPlayerProps, type BookLine } from './odds-service';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SharpSignal {
  source: string;
  direction: 'OVER' | 'UNDER';
  confidence: number; // 0-1
  detail: string;
}

export interface SharpsReport {
  playerName: string;
  statType: string;
  signals: SharpSignal[];
  overallDirection: 'OVER' | 'UNDER' | 'NEUTRAL';
  sharpScore: number; // -1 to 1 (negative = UNDER, positive = OVER)
}

export interface ExpertPick {
  source: string;
  playerName: string;
  statType: string;
  pick: 'OVER' | 'UNDER';
  line: number;
  confidence?: number;
  reasoning?: string;
}

export interface LineMovement {
  playerName: string;
  statType: string;
  openingLine: number;
  currentLine: number;
  movement: number;
  direction: 'OVER' | 'UNDER';
  timestamp: number;
}

// ─── Name Matching ───────────────────────────────────────────────────────────

function namesMatch(a: string, b: string): boolean {
  const clean = (s: string) => s.toLowerCase().trim().replace(/\s+(jr\.?|sr\.?|iii|ii|iv)$/i, '');
  const aClean = clean(a);
  const bClean = clean(b);
  if (aClean === bClean) return true;

  const aParts = aClean.split(/\s+/);
  const bParts = bClean.split(/\s+/);
  if (aParts.length < 2 || bParts.length < 2) return false;
  if (aParts[aParts.length - 1] !== bParts[bParts.length - 1]) return false;
  if (aParts[0][0] !== bParts[0][0]) return false;
  return true;
}

// ─── PP to Book Stat Mapping ─────────────────────────────────────────────────

const PP_TO_BOOK_STAT: Record<string, string> = {
  'Points': 'Points',
  'Rebounds': 'Rebounds',
  'Assists': 'Assists',
  'Pts+Rebs+Asts': 'Pts+Rebs+Asts',
  'Rebs+Asts': 'Rebs+Asts',
  'Pts+Asts': 'Pts+Asts',
  'Pts+Rebs': 'Pts+Rebs',
  'Blks+Stls': 'Blks+Stls',
  'Blocked Shots': 'Blocked Shots',
  'Steals': 'Steals',
  '3-PT Made': '3-PT Made',
  'Turnovers': 'Turnovers',
};

// ─── Source 1: Pinnacle Line Comparison ──────────────────────────────────────

export async function getPinnacleSignal(
  playerName: string,
  statType: string,
  ppLine: number
): Promise<SharpSignal | null> {
  try {
    const pinnacleLines = await fetchPinnacleLines();
    if (pinnacleLines.length === 0) return null;

    const bookStat = PP_TO_BOOK_STAT[statType] || statType;
    const matching = pinnacleLines.filter(l =>
      namesMatch(l.playerName, playerName) && l.statType === bookStat
    );

    if (matching.length === 0) return null;

    const pinnLine = matching[0].line;
    const diff = ppLine - pinnLine;
    const absDiff = Math.abs(diff);

    if (absDiff <= 1.5) return null;

    const direction: 'OVER' | 'UNDER' = diff > 0 ? 'UNDER' : 'OVER';
    const confidence = Math.min(1, absDiff / 5);

    return {
      source: 'Pinnacle',
      direction,
      confidence,
      detail: `Pinnacle line ${pinnLine} vs PP ${ppLine} (${diff > 0 ? '+' : ''}${diff.toFixed(1)})`,
    };
  } catch (err) {
    console.error('[Sharps] Pinnacle signal error:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Source 2: Expert Capper Picks (Covers, OddsShark, Action Network) ──────

const EXPERT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

let expertPicksCache: { data: ExpertPick[]; timestamp: number } | null = null;
const EXPERT_CACHE_TTL = 60 * 60 * 1000; // 1 hour

function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x2019;/g, "'");
}

/** Map raw stat names from articles to PrizePicks stat names */
function mapStatName(raw: string): string | null {
  const lower = raw.toLowerCase().trim();
  if (lower.includes('points') && lower.includes('rebound') && lower.includes('assist')) return 'Pts+Rebs+Asts';
  if (lower.includes('points') && lower.includes('rebound')) return 'Pts+Rebs';
  if (lower.includes('points') && lower.includes('assist')) return 'Pts+Asts';
  if (lower.includes('rebound') && lower.includes('assist')) return 'Rebs+Asts';
  if (lower.includes('block') && lower.includes('steal')) return 'Blks+Stls';
  if (lower.includes('point') || lower === 'pts') return 'Points';
  if (lower.includes('rebound') || lower === 'reb' || lower === 'rebs') return 'Rebounds';
  if (lower.includes('assist') || lower === 'ast' || lower === 'asts') return 'Assists';
  if (lower.includes('3-pointer') || lower.includes('three') || lower.includes('3-pt') || lower === 'threes' || lower === '3pm') return '3-PT Made';
  if (lower.includes('steal')) return 'Steals';
  if (lower.includes('block')) return 'Blocked Shots';
  if (lower.includes('turnover')) return 'Turnovers';
  return null;
}

/**
 * Extract player prop picks from article HTML.
 * Handles both short (o/u) and long (Over/Under) formats.
 */
function extractPicksFromHtml(html: string, source: string): ExpertPick[] {
  html = decodeHtmlEntities(html);
  const seen = new Set<string>();
  const picks: ExpertPick[] = [];

  const addPick = (name: string, direction: 'OVER' | 'UNDER', line: number, rawStat: string) => {
    if (name.length < 4 || name.length > 40 || /^[a-z]/.test(name) || isNaN(line)) return;
    if (!name.includes(' ')) return;
    const statType = mapStatName(rawStat);
    if (!statType) return;
    const key = `${name.toLowerCase()}|${statType}|${direction}`;
    if (seen.has(key)) return;
    seen.add(key);
    picks.push({ source, playerName: name, statType, pick: direction, line });
  };

  // Short format: "Name o22.5 Points Scored (-120)"
  const shortRe = /(?:>|\s)([\w][\w '.'-]{2,35}?)\s+(o|u)([\d.]+)\s+([\w\s+]+?)\s*\([+-]\d+\)/g;
  let m;
  while ((m = shortRe.exec(html)) !== null) {
    addPick(m[1].trim(), m[2] === 'o' ? 'OVER' : 'UNDER', parseFloat(m[3]), m[4].trim());
  }

  // Long format: "Name Over/Under 22.5 points"
  const longRe = /([\w][\w '.'-]{2,35}?)\s+(Over|Under)\s+([\d.]+)\s+(points|rebounds|assists|threes|blocks|steals|turnovers|three-pointers?|3-pointers?)/gi;
  while ((m = longRe.exec(html)) !== null) {
    addPick(m[1].trim(), m[2].toUpperCase() as 'OVER' | 'UNDER', parseFloat(m[3]), m[4].trim());
  }

  // Twitter-style format: "Name OVER 22.5 PTS" or "Name U 22.5 REB"
  const twitterRe = /([\w][\w '.'-]{2,35}?)\s+(OVER|UNDER|O|U)\s+([\d.]+)\s+(PTS|REB|AST|BLK|STL|3PM|TO|PRA|PA|PR|RA|BS|points?|rebounds?|assists?|threes?|blocks?|steals?)/gi;
  while ((m = twitterRe.exec(html)) !== null) {
    const dir = m[2].toUpperCase().startsWith('O') ? 'OVER' : 'UNDER';
    addPick(m[1].trim(), dir as 'OVER' | 'UNDER', parseFloat(m[3]), m[4].trim());
  }

  return picks;
}

// ─── Covers.com Expert Picks ─────────────────────────────────────────────────

async function fetchCoversPicks(): Promise<ExpertPick[]> {
  const picks: ExpertPick[] = [];

  try {
    console.log('[Sharps] Fetching Covers.com picks...');
    const listRes = await fetch('https://www.covers.com/picks/nba', { headers: EXPERT_HEADERS });
    if (!listRes.ok) {
      console.log(`[Sharps] Covers listing HTTP ${listRes.status}`);
      return [];
    }

    const listHtml = await listRes.text();
    const articleUrls = new Set<string>();
    const urlRe = /href="(https:\/\/www\.covers\.com\/nba\/[^"]*(?:prediction|prop|pick|best)[^"]+)"/gi;
    let urlMatch;
    while ((urlMatch = urlRe.exec(listHtml)) !== null) {
      articleUrls.add(urlMatch[1]);
    }

    console.log(`[Sharps] Covers: found ${articleUrls.size} articles`);

    if (articleUrls.size === 0) {
      picks.push(...extractPicksFromHtml(listHtml, 'Covers Expert'));
    } else {
      const results = await Promise.allSettled(
        [...articleUrls].slice(0, 8).map(async (url) => {
          const res = await fetch(url, { headers: EXPERT_HEADERS });
          if (!res.ok) return [];
          const html = await res.text();
          return extractPicksFromHtml(html, 'Covers Expert');
        })
      );

      const globalSeen = new Set<string>();
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        for (const pick of result.value) {
          const key = `${pick.playerName.toLowerCase()}|${pick.statType}|${pick.pick}`;
          if (globalSeen.has(key)) continue;
          globalSeen.add(key);
          picks.push(pick);
        }
      }
    }

    console.log(`[Sharps] Covers: ${picks.length} prop picks`);
  } catch (err) {
    console.error('[Sharps] Covers error:', err instanceof Error ? err.message : err);
  }

  return picks;
}

// ─── OddsShark Expert Picks ──────────────────────────────────────────────────

async function fetchOddsSharkPicks(): Promise<ExpertPick[]> {
  try {
    console.log('[Sharps] Fetching OddsShark picks...');
    const res = await fetch('https://www.oddsshark.com/nba/prop-bets', { headers: EXPERT_HEADERS });
    if (!res.ok) {
      console.log(`[Sharps] OddsShark HTTP ${res.status}`);
      return [];
    }

    const html = await res.text();
    const picks = extractPicksFromHtml(html, 'OddsShark');
    console.log(`[Sharps] OddsShark: ${picks.length} picks`);
    return picks;
  } catch (err) {
    console.error('[Sharps] OddsShark error:', err instanceof Error ? err.message : err);
    return [];
  }
}

// ─── Action Network Expert Picks ─────────────────────────────────────────────

async function fetchActionNetworkPicks(): Promise<ExpertPick[]> {
  try {
    console.log('[Sharps] Fetching Action Network picks...');
    const res = await fetch('https://www.actionnetwork.com/nba/props', { headers: EXPERT_HEADERS });
    if (!res.ok) {
      console.log(`[Sharps] Action Network HTTP ${res.status}`);
      return [];
    }

    const html = await res.text();
    const picks = extractPicksFromHtml(html, 'Action Network');
    console.log(`[Sharps] Action Network: ${picks.length} picks`);
    return picks;
  } catch (err) {
    console.error('[Sharps] Action Network error:', err instanceof Error ? err.message : err);
    return [];
  }
}

// ─── Twitter/X Sharp Cappers (via web search) ────────────────────────────────

/**
 * Known sharp cappers on Twitter/X who post NBA player prop picks.
 * We search for their recent tweets via web search (no API needed).
 */
const SHARP_CAPPERS = [
  'PropsGawd',
  'PropStarz',
  'NBAPickOfTheDay',
  'LightningLockz',
  'propsdotcash',
  'UnderTheBoardNBA',
  'PropBetGuy',
];

let twitterCache: { data: ExpertPick[]; timestamp: number } | null = null;
const TWITTER_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

async function fetchTwitterSharpPicks(): Promise<ExpertPick[]> {
  if (twitterCache && Date.now() - twitterCache.timestamp < TWITTER_CACHE_TTL) {
    return twitterCache.data;
  }

  const picks: ExpertPick[] = [];

  try {
    console.log('[Sharps] Searching for Twitter capper picks...');

    // Search for recent NBA prop picks from known cappers
    const searchQueries = [
      'NBA player props picks today OVER UNDER site:x.com',
      'NBA prop bet today "OVER" OR "UNDER" points rebounds assists site:x.com',
    ];

    for (const query of searchQueries) {
      try {
        const res = await fetch(
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
          { headers: EXPERT_HEADERS }
        );
        if (!res.ok) continue;

        const html = await res.text();
        // Extract any prop picks mentioned in search result snippets
        const snippetPicks = extractPicksFromHtml(html, 'Twitter Sharp');
        picks.push(...snippetPicks);

        await new Promise(r => setTimeout(r, 500));
      } catch {
        // Search failed, non-fatal
      }
    }

    // Also check Nitter mirrors for specific cappers (more reliable than X directly)
    for (const capper of SHARP_CAPPERS.slice(0, 3)) {
      try {
        // Try nitter.net or similar public mirrors
        const mirrors = [
          `https://nitter.privacydev.net/${capper}`,
          `https://nitter.poast.org/${capper}`,
        ];

        for (const url of mirrors) {
          try {
            const res = await fetch(url, {
              headers: EXPERT_HEADERS,
              signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) continue;

            const html = await res.text();
            const capperPicks = extractPicksFromHtml(html, `@${capper}`);
            if (capperPicks.length > 0) {
              picks.push(...capperPicks);
              console.log(`[Sharps] @${capper}: ${capperPicks.length} picks`);
              break; // Got data from this mirror, move to next capper
            }
          } catch {
            continue; // Try next mirror
          }
        }

        await new Promise(r => setTimeout(r, 300));
      } catch {
        // Capper fetch failed, non-fatal
      }
    }

    console.log(`[Sharps] Twitter total: ${picks.length} picks`);
  } catch (err) {
    console.error('[Sharps] Twitter search error:', err instanceof Error ? err.message : err);
  }

  twitterCache = { data: picks, timestamp: Date.now() };
  return picks;
}

// ─── Source 3: Line Movement Detection ───────────────────────────────────────

/**
 * Record current lines into line_movements table for tracking.
 */
export async function recordLineMovements(): Promise<void> {
  try {
    const lines = await fetchPlayerProps();
    if (lines.length === 0) return;

    const db = getDatabase();
    const todayStr = new Date().toISOString().slice(0, 10);
    const now = Date.now();

    const stmt = db.prepare(`
      INSERT INTO line_movements (player_name, stat_type, source, line, timestamp, game_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertAll = db.transaction((rows: BookLine[]) => {
      for (const line of rows) {
        stmt.run(line.playerName, line.statType, line.book, line.line, now, todayStr);
      }
    });

    insertAll(lines);
    console.log(`[Sharps] Recorded ${lines.length} line movements`);
  } catch (err) {
    console.error('[Sharps] Record line movements error:', err instanceof Error ? err.message : err);
  }
}

/**
 * Detect line movement for a player/stat by comparing earliest vs latest recorded lines today.
 */
export async function getLineMovement(
  playerName: string,
  statType: string
): Promise<LineMovement | null> {
  try {
    const db = getDatabase();
    const todayStr = new Date().toISOString().slice(0, 10);

    const earliest = db.prepare(`
      SELECT line, timestamp FROM line_movements
      WHERE player_name = ? AND stat_type = ? AND game_date = ?
      ORDER BY timestamp ASC LIMIT 1
    `).get(playerName, statType, todayStr) as { line: number; timestamp: number } | undefined;

    const latest = db.prepare(`
      SELECT line, timestamp FROM line_movements
      WHERE player_name = ? AND stat_type = ? AND game_date = ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(playerName, statType, todayStr) as { line: number; timestamp: number } | undefined;

    if (!earliest || !latest) return null;

    const movement = latest.line - earliest.line;
    if (Math.abs(movement) < 1.0) return null;

    return {
      playerName,
      statType,
      openingLine: earliest.line,
      currentLine: latest.line,
      movement,
      direction: movement > 0 ? 'OVER' : 'UNDER',
      timestamp: latest.timestamp,
    };
  } catch (err) {
    console.error('[Sharps] Line movement error:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Fetch All Expert Picks ──────────────────────────────────────────────────

/**
 * Fetch all expert picks from all sources.
 * Cached for 1 hour.
 */
export async function getAllExpertPicks(): Promise<ExpertPick[]> {
  if (expertPicksCache && Date.now() - expertPicksCache.timestamp < EXPERT_CACHE_TTL) {
    console.log(`[Sharps] Returning cached expert picks (${expertPicksCache.data.length})`);
    return expertPicksCache.data;
  }

  const [coversPicks, oddsSharkPicks, actionPicks, twitterPicks] = await Promise.all([
    fetchCoversPicks().catch(() => [] as ExpertPick[]),
    fetchOddsSharkPicks().catch(() => [] as ExpertPick[]),
    fetchActionNetworkPicks().catch(() => [] as ExpertPick[]),
    fetchTwitterSharpPicks().catch(() => [] as ExpertPick[]),
  ]);

  const allPicks = [...coversPicks, ...oddsSharkPicks, ...actionPicks, ...twitterPicks];
  console.log(`[Sharps] Total expert picks: ${allPicks.length} (Covers: ${coversPicks.length}, OddsShark: ${oddsSharkPicks.length}, Action: ${actionPicks.length}, Twitter: ${twitterPicks.length})`);

  expertPicksCache = { data: allPicks, timestamp: Date.now() };
  return allPicks;
}

// ─── Expert Pick Signal ──────────────────────────────────────────────────────

function getExpertSignal(
  playerName: string,
  statType: string,
  expertPicks: ExpertPick[]
): SharpSignal | null {
  const matching = expertPicks.filter(ep =>
    namesMatch(ep.playerName, playerName) && ep.statType === statType
  );

  if (matching.length === 0) return null;

  const overCount = matching.filter(p => p.pick === 'OVER').length;
  const underCount = matching.filter(p => p.pick === 'UNDER').length;
  if (overCount === 0 && underCount === 0) return null;

  const total = overCount + underCount;
  const direction: 'OVER' | 'UNDER' = overCount >= underCount ? 'OVER' : 'UNDER';
  const majorityCount = Math.max(overCount, underCount);
  const confidence = majorityCount / total;

  const sources = [...new Set(matching.map(p => p.source))];

  return {
    source: 'Expert Cappers',
    direction,
    confidence,
    detail: `${total} expert(s) from ${sources.join(', ')}: ${overCount} OVER, ${underCount} UNDER`,
  };
}

// ─── Aggregated Sharp Report ─────────────────────────────────────────────────

/**
 * Get a complete sharps report for a player/stat/line.
 * Aggregates Pinnacle lines, expert capper picks, and line movements.
 */
export async function getSharpsReport(
  playerName: string,
  statType: string,
  ppLine: number
): Promise<SharpsReport> {
  const signals: SharpSignal[] = [];

  const [pinnacleSignal, lineMovement, expertPicks] = await Promise.all([
    getPinnacleSignal(playerName, statType, ppLine).catch(() => null),
    getLineMovement(playerName, statType).catch(() => null),
    getAllExpertPicks().catch(() => [] as ExpertPick[]),
  ]);

  // 1. Pinnacle (sharpest book)
  if (pinnacleSignal) {
    signals.push(pinnacleSignal);
  }

  // 2. Expert cappers (Covers, OddsShark, Action Network, Twitter sharps)
  const expertSignal = getExpertSignal(playerName, statType, expertPicks);
  if (expertSignal) {
    signals.push(expertSignal);
  }

  // 3. Line Movement
  if (lineMovement) {
    signals.push({
      source: 'Line Movement',
      direction: lineMovement.direction,
      confidence: Math.min(1, Math.abs(lineMovement.movement) / 3),
      detail: `Line moved ${lineMovement.movement > 0 ? '+' : ''}${lineMovement.movement.toFixed(1)} (${lineMovement.openingLine} → ${lineMovement.currentLine})`,
    });
  }

  // Calculate overall direction and sharp score
  let weightedOver = 0;
  let weightedUnder = 0;

  const sourceWeights: Record<string, number> = {
    'Pinnacle': 1.5,         // Sharpest book, highest weight
    'Line Movement': 1.2,    // Sharp money moves lines
    'Expert Cappers': 1.0,   // Real humans with track records
  };

  for (const signal of signals) {
    const weight = sourceWeights[signal.source] || 1.0;
    const value = signal.confidence * weight;
    if (signal.direction === 'OVER') weightedOver += value;
    else weightedUnder += value;
  }

  const totalWeight = weightedOver + weightedUnder;
  let overallDirection: 'OVER' | 'UNDER' | 'NEUTRAL' = 'NEUTRAL';
  let sharpScore = 0;

  if (totalWeight > 0) {
    sharpScore = (weightedOver - weightedUnder) / totalWeight;
    if (sharpScore > 0.15) overallDirection = 'OVER';
    else if (sharpScore < -0.15) overallDirection = 'UNDER';
  }

  return {
    playerName,
    statType,
    signals,
    overallDirection,
    sharpScore,
  };
}
