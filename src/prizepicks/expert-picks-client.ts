/**
 * Expert Picks Client — Sportsbook Line Comparison
 *
 * Compares PrizePicks lines against DraftKings + FanDuel player props
 * via Odds-API.io. When PP lines diverge from sharp books, that's signal.
 *
 * Key insight: If PrizePicks sets a line at 25.5 but DraftKings has 22.5,
 * the UNDER has a significant edge — the books think the player will
 * score closer to 22.5, so PP's 25.5 UNDER is a gift.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BookLine {
  book: string;           // "DraftKings" | "FanDuel"
  playerName: string;
  statType: string;       // "Points", "Rebounds", "Assists", "Pts+Rebs+Asts", etc.
  line: number;           // e.g. 22.5
  overPrice: number;      // decimal odds, e.g. 1.83
  underPrice: number;     // decimal odds, e.g. 1.91
}

export interface LineComparison {
  playerName: string;
  statType: string;
  ppLine: number;
  books: BookLine[];
  avgBookLine: number;
  lineDiff: number;       // ppLine - avgBookLine (positive = PP line is higher than books)
  signal: 'OVER' | 'UNDER' | null;  // which side benefits from the discrepancy
  signalStrength: number; // 0-1 scale based on magnitude of divergence
  juiceSide?: 'OVER' | 'UNDER'; // which side books are juicing (lower price = more likely)
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
}

// ─── Stat Type Mapping ───────────────────────────────────────────────────────

/** Map PrizePicks stat names → Odds API label stat types */
const PP_TO_BOOK_STAT: Record<string, string> = {
  'Points': 'Points',
  'Rebounds': 'Rebounds',
  'Assists': 'Assists',
  'Pts+Rebs+Asts': 'Pts+Rebs+Asts',
  'Rebs+Asts': 'Rebs+Asts',
  'Pts+Asts': 'Pts+Asts',
  'Pts+Rebs': 'Pts+Rebs',
  'Blks+Stls': 'Blks+Stls', // may not exist in books
  'Blocked Shots': 'Blocks',
  'Steals': 'Steals',
  '3-PT Made': '3 Point FG',
  'Turnovers': 'Turnovers',
  'Fantasy Score': 'Fantasy Score',
  'Double Doubles': 'Double+Double',
  'Triple Doubles': 'Triple+Double',
};

/** Reverse map for matching book labels back to PP stat types */
const BOOK_TO_PP_STAT: Record<string, string> = {};
for (const [pp, book] of Object.entries(PP_TO_BOOK_STAT)) {
  BOOK_TO_PP_STAT[book] = pp;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

let bookPropsCache: { data: BookLine[]; timestamp: number } | null = null;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes (lines move)

// ─── Core: Fetch Player Props from Books ─────────────────────────────────────

/**
 * Fetch all player props from DraftKings + FanDuel for today's NBA games.
 */
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
    // 1. Get today's events
    const eventsRes = await fetch(
      `https://api.odds-api.io/v3/events?sport=basketball&league=usa-nba&apiKey=${apiKey}`
    );
    if (!eventsRes.ok) {
      console.error(`[Books] Events API error: ${eventsRes.status}`);
      return [];
    }

    const events = (await eventsRes.json()) as Array<{
      id: number;
      home: string;
      away: string;
      date: string;
      status: string;
    }>;

    // Filter to pending/today games only
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const pendingEvents = events.filter(e => {
      const eventDate = e.date.slice(0, 10);
      return e.status === 'pending' && eventDate === todayStr;
    });

    console.log(`[Books] ${pendingEvents.length} pending games today`);

    // 2. Fetch player props for each game (with small delay to avoid rate limits)
    for (const event of pendingEvents) {
      try {
        const oddsRes = await fetch(
          `https://api.odds-api.io/v3/odds?sport=basketball&league=usa-nba` +
          `&eventId=${event.id}&oddsType=player_props` +
          `&bookmakers=DraftKings,FanDuel&apiKey=${apiKey}`
        );

        if (!oddsRes.ok) {
          console.log(`[Books] Props error for event ${event.id}: ${oddsRes.status}`);
          continue;
        }

        const oddsData = (await oddsRes.json()) as {
          bookmakers: Record<string, Array<{
            name: string;
            odds: Array<{
              label: string;
              hdp: number;
              over: string;
              under: string;
            }>;
          }>>;
        };

        for (const [bookName, markets] of Object.entries(oddsData.bookmakers || {})) {
          const propsMarket = markets.find(m => m.name === 'Player Props');
          if (!propsMarket) continue;

          for (const prop of propsMarket.odds) {
            // Parse label: "Desmond Bane (Points)" → player="Desmond Bane", stat="Points"
            const match = prop.label.match(/^(.+?)\s*\((.+)\)$/);
            if (!match) continue;

            allLines.push({
              book: bookName,
              playerName: match[1].trim(),
              statType: match[2].trim(),
              line: prop.hdp,
              overPrice: parseFloat(prop.over),
              underPrice: parseFloat(prop.under),
            });
          }
        }

        // Small delay between requests
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.log(`[Books] Error fetching props for event ${event.id}:`,
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

// ─── Line Comparison ─────────────────────────────────────────────────────────

/**
 * Compare a PrizePicks projection against sportsbook lines.
 * Returns signal direction + strength when lines diverge.
 */
export function compareLines(
  playerName: string,
  ppStatType: string,
  ppLine: number,
  bookLines: BookLine[]
): LineComparison | null {
  // Normalize stat type for matching
  const bookStatType = PP_TO_BOOK_STAT[ppStatType] || ppStatType;

  // Find matching book lines (fuzzy match on player name)
  const playerNameLower = playerName.toLowerCase();
  const matching = bookLines.filter(bl => {
    const bookNameLower = bl.playerName.toLowerCase();
    // Exact match or last-name match
    return (
      bookNameLower === playerNameLower ||
      bookNameLower.split(' ').pop() === playerNameLower.split(' ').pop() &&
      bookNameLower.split(' ')[0][0] === playerNameLower.split(' ')[0][0]
    ) && bl.statType === bookStatType;
  });

  if (matching.length === 0) return null;

  // Average line across books
  const avgBookLine = matching.reduce((s, bl) => s + bl.line, 0) / matching.length;
  const lineDiff = ppLine - avgBookLine;

  // Determine signal: if PP line is HIGHER than books, UNDER is the play
  // (books think actual will be lower than what PP is offering)
  let signal: 'OVER' | 'UNDER' | null = null;
  const absDiff = Math.abs(lineDiff);

  // Need at least 1.0 point divergence to be meaningful for counting stats,
  // or 0.5 for combo stats
  const threshold = ppLine > 15 ? 1.5 : 1.0;
  if (absDiff >= threshold) {
    signal = lineDiff > 0 ? 'UNDER' : 'OVER';
  }

  // Signal strength: 0-1 based on divergence relative to line
  // 2-point diff on a 20-point line = 10% = strong signal
  const signalStrength = Math.min(1, absDiff / (ppLine * 0.15));

  // Check which side books are juicing (lower price = more likely outcome)
  // Average the juice across books
  const avgOverPrice = matching.reduce((s, bl) => s + bl.overPrice, 0) / matching.length;
  const avgUnderPrice = matching.reduce((s, bl) => s + bl.underPrice, 0) / matching.length;
  const juiceSide: 'OVER' | 'UNDER' | undefined =
    avgOverPrice < avgUnderPrice ? 'OVER' :
    avgUnderPrice < avgOverPrice ? 'UNDER' : undefined;

  return {
    playerName,
    statType: ppStatType,
    ppLine,
    books: matching,
    avgBookLine,
    lineDiff: Math.round(lineDiff * 10) / 10,
    signal,
    signalStrength: Math.round(signalStrength * 100) / 100,
    juiceSide,
  };
}

// ─── Public API (compatible with pick-scorer interface) ──────────────────────

/**
 * Fetch "expert picks" — actually sportsbook line comparisons.
 * Returns ExpertPick[] for backward compatibility with pick-scorer.
 */
export async function getExpertPicks(): Promise<ExpertPick[]> {
  const bookLines = await fetchBookPlayerProps();
  if (bookLines.length === 0) return [];

  // Convert book lines into ExpertPick format for compatibility
  // Group by player+stat, find consensus across books
  const grouped = new Map<string, BookLine[]>();
  for (const bl of bookLines) {
    const key = `${bl.playerName}|${bl.statType}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(bl);
  }

  const picks: ExpertPick[] = [];
  for (const [, lines] of grouped) {
    if (lines.length < 1) continue;
    const first = lines[0];
    const avgOverPrice = lines.reduce((s, l) => s + l.overPrice, 0) / lines.length;
    const avgUnderPrice = lines.reduce((s, l) => s + l.underPrice, 0) / lines.length;

    // Only generate a "pick" if books clearly lean one way (juice differential)
    const juiceDiff = Math.abs(avgOverPrice - avgUnderPrice);
    if (juiceDiff < 0.15) continue; // not enough lean

    const ppStat = BOOK_TO_PP_STAT[first.statType] || first.statType;
    picks.push({
      source: 'Sportsbooks',
      playerName: first.playerName,
      statType: ppStat,
      pick: avgOverPrice < avgUnderPrice ? 'OVER' : 'UNDER',
      line: first.line,
      confidence: Math.min(5, Math.round(juiceDiff * 10)),
      reasoning: `DK/FD juice: over=${avgOverPrice.toFixed(2)} under=${avgUnderPrice.toFixed(2)}`,
    });
  }

  console.log(`[Books] Generated ${picks.length} expert picks from sportsbook juice`);
  return picks;
}

/**
 * Get consensus for a specific player/stat by comparing against sportsbook lines.
 */
export async function getConsensusForPick(
  playerName: string,
  statType: string
): Promise<ConsensusData | null> {
  const bookLines = await fetchBookPlayerProps();
  if (bookLines.length === 0) return null;

  const bookStatType = PP_TO_BOOK_STAT[statType] || statType;
  const playerNameLower = playerName.toLowerCase();

  const matching = bookLines.filter(bl => {
    const bookNameLower = bl.playerName.toLowerCase();
    return (
      bookNameLower === playerNameLower ||
      (bookNameLower.split(' ').pop() === playerNameLower.split(' ').pop() &&
       bookNameLower.split(' ')[0][0] === playerNameLower.split(' ')[0][0])
    ) && bl.statType === bookStatType;
  });

  if (matching.length === 0) return null;

  const avgOverPrice = matching.reduce((s, l) => s + l.overPrice, 0) / matching.length;
  const avgUnderPrice = matching.reduce((s, l) => s + l.underPrice, 0) / matching.length;

  // Convert odds to implied probability
  const overProb = (1 / avgOverPrice) * 100;
  const underProb = (1 / avgUnderPrice) * 100;
  const total = overProb + underProb;
  const overPercent = Math.round((overProb / total) * 100);
  const underPercent = 100 - overPercent;

  const sharpMoney: 'OVER' | 'UNDER' | undefined =
    overPercent >= 55 ? 'OVER' :
    underPercent >= 55 ? 'UNDER' : undefined;

  return {
    playerName,
    statType,
    overPercent,
    underPercent,
    sharpMoney,
    expertPicks: matching.map(bl => ({
      source: bl.book,
      playerName: bl.playerName,
      statType,
      pick: (bl.overPrice < bl.underPrice ? 'OVER' : 'UNDER') as 'OVER' | 'UNDER',
      line: bl.line,
      reasoning: `${bl.book}: ${bl.line} (o${bl.overPrice} u${bl.underPrice})`,
    })),
  };
}
