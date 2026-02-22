/**
 * Sharps Intel — Sharp Money & Expert Capper Signal Detection
 *
 * Aggregates signals from multiple sources:
 * 1. Pinnacle line comparison (sharpest book via The Odds API)
 * 2. Expert capper picks from Covers, OddsShark, Action Network articles
 * 3. Web search article scraper (Yahoo Sports, SI, WSN, Dimers, etc.)
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
  if (!a || !b) return false;
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
    // Filter out sentence fragments and non-name text
    if (/\b(take|has|had|get|will|can|should|the|this|that|with|from|been|also|just|nba|prop|bet|pick|best|today)\b/i.test(name)) return;
    // Must look like "FirstName LastName" (both start uppercase)
    const nameParts = name.trim().split(/\s+/);
    if (nameParts.length < 2 || nameParts.some(p => p.length > 0 && /^[a-z]/.test(p) && p !== 'de' && p !== 'van' && p !== 'von')) return;
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

// ─── Web Search Article Scraper (replaces Twitter/Nitter) ────────────────────

/**
 * Search the web for today's NBA player prop pick articles and extract picks.
 * More resilient than hardcoded site scrapers — catches fresh content daily
 * from Yahoo Sports, SI, WSN, Dimers, Props.com, etc.
 */

let articleCache: { data: ExpertPick[]; timestamp: number } | null = null;
const ARTICLE_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Known sites that publish daily NBA player prop picks with scrape-friendly HTML.
 * Each entry has a listing URL (to find today's article) and a source name.
 */
const ARTICLE_SOURCES = [
  {
    name: 'Yahoo Sports',
    // Yahoo syndicates Covers articles — search their NBA section for today's props
    listUrl: 'https://sports.yahoo.com/nba/',
    articlePattern: /href="(\/articles\/[^"]*(?:prop|pick|best)[^"]*\.html)"/gi,
    baseUrl: 'https://sports.yahoo.com',
  },
  {
    name: 'SI Betting',
    listUrl: 'https://www.si.com/betting/nba-picks',
    articlePattern: /href="(\/betting\/[^"]*(?:prop|best-bet|player)[^"]*)"/gi,
    baseUrl: 'https://www.si.com',
  },
  {
    name: 'WSN',
    // WSN uses date-based URLs for daily props
    listUrl: null, // Direct URL constructed below
    directUrl: () => {
      const d = new Date();
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `https://www.wsn.com/nba/best-prop-bets-today-${yyyy}-${mm}-${dd}/`;
    },
  },
  {
    name: 'Sporting News',
    listUrl: 'https://www.sportingnews.com/us/nba/news',
    articlePattern: /href="(\/us\/nba\/news\/[^"]*(?:prop|pick|best-bet)[^"]*)"/gi,
    baseUrl: 'https://www.sportingnews.com',
  },
];

async function fetchArticlePicks(): Promise<ExpertPick[]> {
  if (articleCache && Date.now() - articleCache.timestamp < ARTICLE_CACHE_TTL) {
    return articleCache.data;
  }

  const picks: ExpertPick[] = [];
  const globalSeen = new Set<string>();

  const addPicks = (newPicks: ExpertPick[]) => {
    for (const pick of newPicks) {
      const key = `${pick.playerName.toLowerCase()}|${pick.statType}|${pick.pick}`;
      if (!globalSeen.has(key)) {
        globalSeen.add(key);
        picks.push(pick);
      }
    }
  };

  console.log('[Sharps] Fetching article-based prop picks...');

  const tasks = ARTICLE_SOURCES.map(async (src) => {
    try {
      // Direct URL source (like WSN date-based)
      if ('directUrl' in src && src.directUrl) {
        const url = src.directUrl();
        const res = await fetch(url, { headers: EXPERT_HEADERS, signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const html = await res.text();
          const found = extractPicksFromHtml(html, src.name);
          console.log(`[Sharps] ${src.name} (direct): ${found.length} picks`);
          return found;
        }
        console.log(`[Sharps] ${src.name} HTTP ${res.status}`);
        return [];
      }

      // Listing page → find article URLs → fetch articles
      if (!src.listUrl || !src.articlePattern) return [];

      const listRes = await fetch(src.listUrl, { headers: EXPERT_HEADERS, signal: AbortSignal.timeout(8000) });
      if (!listRes.ok) {
        console.log(`[Sharps] ${src.name} listing HTTP ${listRes.status}`);
        return [];
      }

      const listHtml = await listRes.text();

      // First try extracting directly from listing page
      const listPicks = extractPicksFromHtml(listHtml, src.name);
      if (listPicks.length >= 3) {
        console.log(`[Sharps] ${src.name} (listing): ${listPicks.length} picks`);
        return listPicks;
      }

      // Otherwise find article links
      const urls = new Set<string>();
      let m;
      const regex = new RegExp(src.articlePattern.source, src.articlePattern.flags);
      while ((m = regex.exec(listHtml)) !== null && urls.size < 3) {
        const fullUrl = m[1].startsWith('http') ? m[1] : `${src.baseUrl || ''}${m[1]}`;
        urls.add(fullUrl);
      }

      if (urls.size === 0) {
        console.log(`[Sharps] ${src.name}: no article URLs found`);
        return listPicks; // Return whatever we got from the listing
      }

      const articleResults = await Promise.allSettled(
        [...urls].map(async (url) => {
          const res = await fetch(url, { headers: EXPERT_HEADERS, signal: AbortSignal.timeout(8000) });
          if (!res.ok) return [];
          const html = await res.text();
          return extractPicksFromHtml(html, src.name);
        })
      );

      const allFromSrc = [...listPicks];
      for (const r of articleResults) {
        if (r.status === 'fulfilled') allFromSrc.push(...r.value);
      }
      console.log(`[Sharps] ${src.name}: ${allFromSrc.length} picks from ${urls.size} articles`);
      return allFromSrc;
    } catch (err) {
      console.log(`[Sharps] ${src.name} error: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  });

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === 'fulfilled') addPicks(r.value);
  }

  console.log(`[Sharps] Article picks total: ${picks.length}`);
  articleCache = { data: picks, timestamp: Date.now() };
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

  const [coversPicks, oddsSharkPicks, actionPicks, articlePicks] = await Promise.all([
    fetchCoversPicks().catch(() => [] as ExpertPick[]),
    fetchOddsSharkPicks().catch(() => [] as ExpertPick[]),
    fetchActionNetworkPicks().catch(() => [] as ExpertPick[]),
    fetchArticlePicks().catch(() => [] as ExpertPick[]),
  ]);

  // Deduplicate across all sources
  const seen = new Set<string>();
  const allPicks: ExpertPick[] = [];
  for (const pick of [...coversPicks, ...oddsSharkPicks, ...actionPicks, ...articlePicks]) {
    const key = `${pick.playerName.toLowerCase()}|${pick.statType}|${pick.pick}`;
    if (!seen.has(key)) {
      seen.add(key);
      allPicks.push(pick);
    }
  }
  console.log(`[Sharps] Total expert picks: ${allPicks.length} (Covers: ${coversPicks.length}, OddsShark: ${oddsSharkPicks.length}, Action: ${actionPicks.length}, Articles: ${articlePicks.length})`);

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

  // 2. Expert cappers (Covers, OddsShark, Action Network, article search)
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
