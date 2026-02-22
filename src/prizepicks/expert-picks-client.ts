/**
 * Expert Picks Client — Sportsbook Line Comparison
 *
 * Compares PrizePicks lines against DraftKings + FanDuel player props
 * via Odds-API.io. When PP lines diverge significantly from sharp books,
 * that's a signal — but big discrepancies need investigation, not blind trust.
 *
 * Key insight: If PrizePicks sets a line at 25.5 but DraftKings has 22.5,
 * the UNDER looks appealing — but we should check WHY they differ before
 * acting on it (injury return, role change, recent hot/cold streak, etc.)
 */

import { getDatabase } from '../core/db/database';
import { getInjuryReport, type InjuryReport } from './injury-news-client';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BookLine {
  book: string;           // "DraftKings" | "FanDuel"
  playerName: string;
  statType: string;       // "Points", "Rebounds", "Assists", "Pts+Rebs+Asts", etc.
  line: number;           // e.g. 22.5
  overPrice: number;      // decimal odds, e.g. 1.83
  underPrice: number;     // decimal odds, e.g. 1.91
}

export interface DiscrepancyResearch {
  reason: string;           // human-readable explanation of why lines might differ
  factors: string[];        // individual factors found
  trustLevel: 'high' | 'medium' | 'low'; // how much to trust the discrepancy as a signal
}

export interface LineComparison {
  playerName: string;
  statType: string;
  ppLine: number;
  books: BookLine[];
  avgBookLine: number;
  lineDiff: number;       // ppLine - avgBookLine (positive = PP line is higher)
  signal: 'OVER' | 'UNDER' | null;
  signalStrength: number; // 0-1 scale
  juiceSide?: 'OVER' | 'UNDER';
  research?: DiscrepancyResearch; // investigation into WHY lines differ
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

export interface ConsensusData {
  playerName: string;
  statType: string;
  overPercent: number;
  underPercent: number;
  sharpMoney?: 'OVER' | 'UNDER';
  expertPicks: ExpertPick[];
  lineComparison?: LineComparison;
}

// ─── Stat Type Mapping ───────────────────────────────────────────────────────

const PP_TO_BOOK_STAT: Record<string, string> = {
  'Points': 'Points',
  'Rebounds': 'Rebounds',
  'Assists': 'Assists',
  'Pts+Rebs+Asts': 'Pts+Rebs+Asts',
  'Rebs+Asts': 'Rebs+Asts',
  'Pts+Asts': 'Pts+Asts',
  'Pts+Rebs': 'Pts+Rebs',
  'Blks+Stls': 'Blks+Stls',
  'Blocked Shots': 'Blocks',
  'Steals': 'Steals',
  '3-PT Made': '3 Point FG',
  'Turnovers': 'Turnovers',
  'Fantasy Score': 'Fantasy Score',
  'Double Doubles': 'Double+Double',
  'Triple Doubles': 'Triple+Double',
};

const BOOK_TO_PP_STAT: Record<string, string> = {};
for (const [pp, book] of Object.entries(PP_TO_BOOK_STAT)) {
  BOOK_TO_PP_STAT[book] = pp;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

let bookPropsCache: { data: BookLine[]; timestamp: number } | null = null;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ─── Name Matching ───────────────────────────────────────────────────────────

/**
 * Match player names between PP and sportsbooks.
 * Handles "Desmond Bane" vs "D. Bane" style differences.
 */
function namesMatch(a: string, b: string): boolean {
  // Strip suffixes like Jr., Sr., III, II, IV
  const clean = (s: string) => s.toLowerCase().trim().replace(/\s+(jr\.?|sr\.?|iii|ii|iv)$/i, '');
  const aClean = clean(a);
  const bClean = clean(b);
  if (aClean === bClean) return true;

  const aParts = aClean.split(/\s+/);
  const bParts = bClean.split(/\s+/);
  if (aParts.length < 2 || bParts.length < 2) return false;

  // Last names must match exactly
  if (aParts[aParts.length - 1] !== bParts[bParts.length - 1]) return false;
  // First initial must match
  if (aParts[0][0] !== bParts[0][0]) return false;

  return true;
}

// ─── Core: Fetch Player Props from Books ─────────────────────────────────────

export async function fetchBookPlayerProps(): Promise<BookLine[]> {
  if (bookPropsCache && Date.now() - bookPropsCache.timestamp < CACHE_TTL) {
    console.log(`[Books] Returning cached props (${bookPropsCache.data.length} lines)`);
    return bookPropsCache.data;
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error('[Books] ODDS_API_KEY not set');
    return [];
  }

  const allLines: BookLine[] = [];

  try {
    const eventsRes = await fetch(
      `https://api.odds-api.io/v3/events?sport=basketball&league=usa-nba&apiKey=${apiKey}`
    );
    if (!eventsRes.ok) {
      console.error(`[Books] Events API error: ${eventsRes.status}`);
      return [];
    }

    const events = (await eventsRes.json()) as Array<{
      id: number; home: string; away: string; date: string; status: string;
    }>;

    const todayStr = new Date().toISOString().slice(0, 10);
    const pendingEvents = events.filter(e =>
      e.status === 'pending' && e.date.slice(0, 10) === todayStr
    );

    console.log(`[Books] ${pendingEvents.length} pending games today`);

    for (const event of pendingEvents) {
      try {
        const oddsRes = await fetch(
          `https://api.odds-api.io/v3/odds?sport=basketball&league=usa-nba` +
          `&eventId=${event.id}&oddsType=player_props` +
          `&bookmakers=DraftKings,FanDuel&apiKey=${apiKey}`
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

            // Skip malformed lines (Double+Double often has undefined hdp)
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
        console.log(`[Books] Error for event ${event.id}:`,
          err instanceof Error ? err.message : err);
      }
    }

    console.log(`[Books] Fetched ${allLines.length} player prop lines across ${pendingEvents.length} games`);
  } catch (err) {
    console.error('[Books] Error:', err instanceof Error ? err.message : err);
  }

  bookPropsCache = { data: allLines, timestamp: Date.now() };
  return allLines;
}

// ─── Discrepancy Research ────────────────────────────────────────────────────

/**
 * When PP line diverges significantly from books, investigate WHY.
 * Checks recent performance, injuries, and trends to explain the gap.
 */
async function researchDiscrepancy(
  playerName: string,
  statType: string,
  ppLine: number,
  avgBookLine: number,
  lineDiff: number
): Promise<DiscrepancyResearch> {
  const factors: string[] = [];
  let trustLevel: 'high' | 'medium' | 'low' = 'medium';

  const db = getDatabase();
  const direction = lineDiff > 0 ? 'higher' : 'lower';

  // 1. Check recent game logs for hot/cold streaks
  try {
    const recentGames = db.prepare(`
      SELECT points, rebounds, assists, 
             points + rebounds + assists as pra,
             minutes, game_date
      FROM player_game_logs
      WHERE player_name = ? AND league = 'NBA'
      ORDER BY game_date DESC
      LIMIT 10
    `).all(playerName) as Array<{
      points: number; rebounds: number; assists: number;
      pra: number; minutes: number; game_date: string;
    }>;

    if (recentGames.length >= 3) {
      // Figure out which stat column to check
      const statCol = getStatColumn(statType);
      if (statCol) {
        const last3 = recentGames.slice(0, 3);
        const last3Avg = last3.reduce((s, g) => s + getStatValue(g, statCol), 0) / last3.length;
        const last10Avg = recentGames.reduce((s, g) => s + getStatValue(g, statCol), 0) / recentGames.length;

        // Is the player on a streak that might explain the PP line?
        if (last3Avg > last10Avg * 1.15) {
          factors.push(`🔥 Hot streak: L3 avg ${last3Avg.toFixed(1)} vs L10 avg ${last10Avg.toFixed(1)} — PP may be chasing recency`);
          if (direction === 'higher') {
            // PP line is higher AND player is hot → PP might be right, books haven't caught up
            trustLevel = 'low'; // Don't blindly take UNDER when player is hot
          }
        } else if (last3Avg < last10Avg * 0.85) {
          factors.push(`❄️ Cold streak: L3 avg ${last3Avg.toFixed(1)} vs L10 avg ${last10Avg.toFixed(1)}`);
          if (direction === 'lower') {
            trustLevel = 'low'; // Don't blindly take OVER when player is cold
          }
        }

        // Check minutes trend (role change?)
        const last3Min = last3.reduce((s, g) => s + g.minutes, 0) / last3.length;
        const last10Min = recentGames.reduce((s, g) => s + g.minutes, 0) / recentGames.length;
        if (Math.abs(last3Min - last10Min) > 4) {
          const minDir = last3Min > last10Min ? 'up' : 'down';
          factors.push(`⏱️ Minutes shift: L3 ${last3Min.toFixed(0)}min vs L10 ${last10Min.toFixed(0)}min (${minDir}) — possible role change`);
          trustLevel = 'low'; // Role changes make discrepancies unreliable
        }

        // Check game-to-game variance (high variance = less reliable signal)
        const values = recentGames.map(g => getStatValue(g, statCol));
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
        const stdDev = Math.sqrt(variance);
        const cv = mean > 0 ? stdDev / mean : 0;
        if (cv > 0.4) {
          factors.push(`📊 High variance: CV=${(cv * 100).toFixed(0)}% — this player is inconsistent, line gaps less meaningful`);
        }
      }
    } else {
      factors.push(`⚠️ Limited data: only ${recentGames.length} recent games in DB`);
      trustLevel = 'low';
    }
  } catch (err) {
    // DB errors shouldn't crash the pipeline
  }

  // 2. Check if player is on the injury report
  try {
    const injuries = await getInjuryReport();
    const playerInjury = injuries.find(
      inj => namesMatch(inj.playerName, playerName)
    );
    if (playerInjury) {
      factors.push(`🏥 ${playerInjury.status}: ${playerInjury.description.slice(0, 100)}`);
      if (['Questionable', 'Day-To-Day', 'Doubtful'].includes(playerInjury.status)) {
        trustLevel = 'low'; // Injury uncertainty makes everything unreliable
      }
    }

    // Check for teammate injuries that could boost usage
    const playerTeamGames = db.prepare(`
      SELECT DISTINCT opponent FROM player_game_logs 
      WHERE player_name = ? AND league = 'NBA' 
      ORDER BY game_date DESC LIMIT 1
    `).get(playerName) as { opponent: string } | undefined;
    
    // Find teammates who are OUT
    if (playerTeamGames) {
      const teamPlayers = db.prepare(`
        SELECT DISTINCT player_name FROM player_game_logs
        WHERE league = 'NBA' AND player_name != ?
        ORDER BY game_date DESC LIMIT 50
      `).all(playerName) as Array<{ player_name: string }>;

      const outTeammates = injuries.filter(inj =>
        inj.status === 'Out' &&
        teamPlayers.some(tp => namesMatch(tp.player_name, inj.playerName))
      );

      if (outTeammates.length > 0) {
        const names = outTeammates.map(t => t.playerName).join(', ');
        factors.push(`🔄 Teammate(s) OUT: ${names} — could boost usage/minutes`);
      }
    }
  } catch (err) {
    // Injury check failed — non-fatal
  }

  // 3. Build summary
  if (factors.length === 0) {
    factors.push('No obvious explanation found — discrepancy may be real edge or PP-specific market dynamics');
    trustLevel = 'medium';
  }

  const reason = factors.join(' | ');
  return { reason, factors, trustLevel };
}

/** Map PP stat types to DB columns */
function getStatColumn(statType: string): string | null {
  const map: Record<string, string> = {
    'Points': 'points',
    'Rebounds': 'rebounds',
    'Assists': 'assists',
    'Pts+Rebs+Asts': 'pra',
    'Pts+Rebs': 'pts_rebs',
    'Pts+Asts': 'pts_asts',
    'Rebs+Asts': 'rebs_asts',
    'Steals': 'steals',
    'Blocked Shots': 'blocks',
    '3-PT Made': 'three_pointers_made',
    'Turnovers': 'turnovers',
  };
  return map[statType] || null;
}

/** Extract stat value from game row, including combos */
function getStatValue(game: any, col: string): number {
  if (col === 'pra') return (game.points || 0) + (game.rebounds || 0) + (game.assists || 0);
  if (col === 'pts_rebs') return (game.points || 0) + (game.rebounds || 0);
  if (col === 'pts_asts') return (game.points || 0) + (game.assists || 0);
  if (col === 'rebs_asts') return (game.rebounds || 0) + (game.assists || 0);
  return game[col] || 0;
}

// ─── Line Comparison ─────────────────────────────────────────────────────────

/**
 * Compare a PrizePicks projection against sportsbook lines.
 * For significant discrepancies, researches WHY the lines differ.
 */
export async function compareLines(
  playerName: string,
  ppStatType: string,
  ppLine: number,
  bookLines: BookLine[]
): Promise<LineComparison | null> {
  const bookStatType = PP_TO_BOOK_STAT[ppStatType] || ppStatType;

  const matching = bookLines.filter(bl =>
    namesMatch(bl.playerName, playerName) && bl.statType === bookStatType
  );

  if (matching.length === 0) return null;

  const avgBookLine = matching.reduce((s, bl) => s + bl.line, 0) / matching.length;
  const lineDiff = ppLine - avgBookLine;
  const absDiff = Math.abs(lineDiff);

  // Signal thresholds — must be meaningful
  // For high lines (>15), need bigger absolute gap
  // For low lines (<5), even 0.5 matters
  let threshold: number;
  if (ppLine > 20) threshold = 2.0;
  else if (ppLine > 10) threshold = 1.5;
  else threshold = 1.0;

  let signal: 'OVER' | 'UNDER' | null = null;
  if (absDiff >= threshold) {
    signal = lineDiff > 0 ? 'UNDER' : 'OVER';
  }

  const signalStrength = Math.min(1, absDiff / Math.max(ppLine * 0.1, 1));

  const avgOverPrice = matching.reduce((s, bl) => s + bl.overPrice, 0) / matching.length;
  const avgUnderPrice = matching.reduce((s, bl) => s + bl.underPrice, 0) / matching.length;
  const juiceSide: 'OVER' | 'UNDER' | undefined =
    Math.abs(avgOverPrice - avgUnderPrice) >= 0.08
      ? (avgOverPrice < avgUnderPrice ? 'OVER' : 'UNDER')
      : undefined;

  // Research big discrepancies (≥ threshold)
  let research: DiscrepancyResearch | undefined;
  if (absDiff >= threshold) {
    research = await researchDiscrepancy(playerName, ppStatType, ppLine, avgBookLine, lineDiff);
  }

  return {
    playerName,
    statType: ppStatType,
    ppLine,
    books: matching,
    avgBookLine: Math.round(avgBookLine * 10) / 10,
    lineDiff: Math.round(lineDiff * 10) / 10,
    signal,
    signalStrength: Math.round(signalStrength * 100) / 100,
    juiceSide,
    research,
  };
}

// ─── Covers.com Expert Picks (from individual game articles) ─────────────────

let coversCache: { data: ExpertPick[]; timestamp: number } | null = null;
const COVERS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

const COVERS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'text/html',
};

function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x2019;/g, "'");
}

/**
 * Extract player prop picks from a Covers.com article HTML.
 * Uses two regex patterns to catch both short (o/u) and long (Over/Under) formats.
 */
function extractPicksFromArticle(html: string): ExpertPick[] {
  html = decodeHtmlEntities(html);
  // Dedupe by player+stat+direction
  const seen = new Set<string>();
  const picks: ExpertPick[] = [];

  const addPick = (name: string, direction: 'OVER' | 'UNDER', line: number, rawStat: string) => {
    if (name.length < 4 || name.length > 40 || /^[a-z]/.test(name) || isNaN(line)) return;
    // Skip single-word names (last name only like "Brooks") — we'll get the full name from another match
    if (!name.includes(' ')) return;
    const statType = mapCoversStat(rawStat);
    if (!statType) return;
    const key = `${name.toLowerCase()}|${statType}|${direction}`;
    if (seen.has(key)) return;
    seen.add(key);
    picks.push({ source: 'Covers Expert', playerName: name, statType, pick: direction, line });
  };

  // Short format: "Name o22.5 Points Scored (-120)"
  const shortRe = /(?:>|\s)([\w][\w '.'-]{2,35}?)\s+(o|u)([\d.]+)\s+([\w\s+]+?)\s*\([+-]\d+\)/g;
  let m;
  while ((m = shortRe.exec(html)) !== null) {
    addPick(m[1].trim(), m[2] === 'o' ? 'OVER' : 'UNDER', parseFloat(m[3]), m[4].trim());
  }

  // Long format: "Name Over/Under 22.5 points"
  const longRe = /([\w][\w '.'-]{2,35}?)\s+(Over|Under)\s+([\d.]+)\s+(points|rebounds|assists|threes|blocks|steals|turnovers)/gi;
  while ((m = longRe.exec(html)) !== null) {
    addPick(m[1].trim(), m[2].toUpperCase() as 'OVER' | 'UNDER', parseFloat(m[3]), m[4].trim());
  }

  return picks;
}

/**
 * Scrape Covers.com: fetch the NBA picks listing for today's article URLs,
 * then fetch each article and extract player prop picks.
 */
async function fetchCoversPicks(): Promise<ExpertPick[]> {
  if (coversCache && Date.now() - coversCache.timestamp < COVERS_CACHE_TTL) {
    console.log(`[Covers] Returning cached picks (${coversCache.data.length})`);
    return coversCache.data;
  }

  const picks: ExpertPick[] = [];

  try {
    // Step 1: Get article URLs from listing page
    const listRes = await fetch('https://www.covers.com/picks/nba', { headers: COVERS_HEADERS });
    if (!listRes.ok) {
      console.log(`[Covers] Listing page HTTP ${listRes.status}`);
      coversCache = { data: [], timestamp: Date.now() };
      return [];
    }

    const listHtml = await listRes.text();
    const articleUrls = new Set<string>();
    const urlRe = /href="(https:\/\/www\.covers\.com\/nba\/[^"]*prediction[^"]+)"/g;
    let urlMatch;
    while ((urlMatch = urlRe.exec(listHtml)) !== null) {
      articleUrls.add(urlMatch[1]);
    }

    console.log(`[Covers] Found ${articleUrls.size} game articles`);

    if (articleUrls.size === 0) {
      // Fallback: extract whatever picks exist on the listing page itself
      picks.push(...extractPicksFromArticle(listHtml));
    } else {
      // Step 2: Fetch articles in parallel (max 6 concurrent)
      const urls = [...articleUrls];
      const results = await Promise.allSettled(
        urls.map(async (url) => {
          const res = await fetch(url, { headers: COVERS_HEADERS });
          if (!res.ok) return [];
          const html = await res.text();
          return extractPicksFromArticle(html);
        })
      );

      // Dedupe across articles
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

    console.log(`[Covers] Scraped ${picks.length} prop picks from ${articleUrls.size} articles`);
  } catch (err) {
    console.error('[Covers] Error:', err instanceof Error ? err.message : err);
  }

  coversCache = { data: picks, timestamp: Date.now() };
  return picks;
}

/** Map Covers.com stat names to PrizePicks stat names */
function mapCoversStat(raw: string): string | null {
  const lower = raw.toLowerCase().trim();
  if (lower.includes('points')) return 'Points';
  if (lower.includes('rebound')) return 'Rebounds';
  if (lower.includes('assist')) return 'Assists';
  if (lower.includes('3-pointer') || lower.includes('three') || lower.includes('3-pt') || lower === 'threes') return '3-PT Made';
  if (lower.includes('steal')) return 'Steals';
  if (lower.includes('block')) return 'Blocked Shots';
  if (lower.includes('turnover')) return 'Turnovers';
  return null; // Unknown stat — skip
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch expert picks from real sources:
 * 1. Covers.com (expert analysis + computer model picks with star ratings)
 * 
 * Returns actual expert/model prop picks with reasoning.
 */
export async function getExpertPicks(): Promise<ExpertPick[]> {
  const coversPicks = await fetchCoversPicks().catch(() => [] as ExpertPick[]);
  
  console.log(`[Expert Picks] Total: ${coversPicks.length} picks (Covers: ${coversPicks.length})`);
  return coversPicks;
}

/**
 * Get consensus for a specific player/stat by comparing against sportsbook lines.
 * Includes line comparison research for discrepancies.
 */
export async function getConsensusForPick(
  playerName: string,
  statType: string,
  ppLine?: number
): Promise<ConsensusData | null> {
  const bookLines = await fetchBookPlayerProps();
  if (bookLines.length === 0) return null;

  const bookStatType = PP_TO_BOOK_STAT[statType] || statType;

  const matching = bookLines.filter(bl =>
    namesMatch(bl.playerName, playerName) && bl.statType === bookStatType
  );

  if (matching.length === 0) return null;

  const avgOverPrice = matching.reduce((s, l) => s + l.overPrice, 0) / matching.length;
  const avgUnderPrice = matching.reduce((s, l) => s + l.underPrice, 0) / matching.length;

  // Implied probability from odds
  const overProb = (1 / avgOverPrice) * 100;
  const underProb = (1 / avgUnderPrice) * 100;
  const total = overProb + underProb;
  const overPercent = Math.round((overProb / total) * 100);
  const underPercent = 100 - overPercent;

  // Sharp money: only flag if clear lean (≥55%)
  const sharpMoney: 'OVER' | 'UNDER' | undefined =
    overPercent >= 55 ? 'OVER' :
    underPercent >= 55 ? 'UNDER' : undefined;

  // Line comparison with research (if PP line provided)
  let lineComparison: LineComparison | undefined;
  if (ppLine != null) {
    lineComparison = await compareLines(playerName, statType, ppLine, bookLines) || undefined;
  }

  // Also include Covers expert picks for this player/stat
  const coversPicks = await fetchCoversPicks().catch(() => [] as ExpertPick[]);
  const coversMatching = coversPicks.filter(cp =>
    namesMatch(cp.playerName, playerName) &&
    cp.statType === statType
  );

  const allExpertPicks: ExpertPick[] = [
    ...matching.map(bl => ({
      source: bl.book,
      playerName: bl.playerName,
      statType,
      pick: (bl.overPrice < bl.underPrice ? 'OVER' : 'UNDER') as 'OVER' | 'UNDER',
      line: bl.line,
      reasoning: `${bl.book}: line ${bl.line} (o${bl.overPrice.toFixed(2)} u${bl.underPrice.toFixed(2)})`,
    })),
    ...coversMatching,
  ];

  return {
    playerName,
    statType,
    overPercent,
    underPercent,
    sharpMoney,
    expertPicks: allExpertPicks,
    lineComparison,
  };
}
