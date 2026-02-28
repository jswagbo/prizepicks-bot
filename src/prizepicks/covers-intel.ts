/**
 * Covers Intel — Scrapes expert picks from Covers.com
 *
 * ONLY source: https://www.covers.com/picks/nba
 * Returns a simple list of expert picks for annotation in reports.
 * NOT used for scoring — purely informational.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CoversExpertPick {
  playerName: string;
  statType: string;
  pick: 'OVER' | 'UNDER';
  line: number;
  expertName: string;
  source: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  Accept: 'text/html,application/xhtml+xml',
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

function mapStatName(raw: string): string | null {
  const lower = raw.toLowerCase().trim();
  if (
    lower.includes('points') &&
    lower.includes('rebound') &&
    lower.includes('assist')
  )
    return 'Pts+Rebs+Asts';
  if (lower.includes('points') && lower.includes('rebound'))
    return 'Pts+Rebs';
  if (lower.includes('points') && lower.includes('assist'))
    return 'Pts+Asts';
  if (lower.includes('rebound') && lower.includes('assist'))
    return 'Rebs+Asts';
  if (lower.includes('block') && lower.includes('steal')) return 'Blks+Stls';
  if (lower.includes('point') || lower === 'pts') return 'Points';
  if (lower.includes('rebound') || lower === 'reb' || lower === 'rebs')
    return 'Rebounds';
  if (lower.includes('assist') || lower === 'ast' || lower === 'asts')
    return 'Assists';
  if (
    lower.includes('3-pointer') ||
    lower.includes('three') ||
    lower.includes('3-pt') ||
    lower === 'threes' ||
    lower === '3pm'
  )
    return '3-PT Made';
  if (lower.includes('steal')) return 'Steals';
  if (lower.includes('block')) return 'Blocked Shots';
  if (lower.includes('turnover')) return 'Turnovers';
  return null;
}

function namesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const clean = (s: string) =>
    s
      .toLowerCase()
      .trim()
      .replace(/\s+(jr\.?|sr\.?|iii|ii|iv)$/i, '');
  const aClean = clean(a);
  const bClean = clean(b);
  if (aClean === bClean) return true;
  const aParts = aClean.split(/\s+/);
  const bParts = bClean.split(/\s+/);
  if (aParts.length < 2 || bParts.length < 2) return false;
  if (aParts[aParts.length - 1] !== bParts[bParts.length - 1]) return false;
  const aFirst = aParts[0];
  const bFirst = bParts[0];
  const minLen = Math.min(aFirst.length, bFirst.length);
  if (minLen >= 3) {
    return aFirst.slice(0, 3) === bFirst.slice(0, 3);
  }
  return aFirst === bFirst;
}

/**
 * Extract player prop picks from HTML content.
 */
function extractPicksFromHtml(
  html: string,
  expertName: string
): CoversExpertPick[] {
  html = decodeHtmlEntities(html);
  const seen = new Set<string>();
  const picks: CoversExpertPick[] = [];

  const addPick = (
    name: string,
    direction: 'OVER' | 'UNDER',
    line: number,
    rawStat: string
  ) => {
    if (
      name.length < 4 ||
      name.length > 40 ||
      /^[a-z]/.test(name) ||
      isNaN(line)
    )
      return;
    if (!name.includes(' ')) return;
    if (
      /\b(take|has|had|get|will|can|should|the|this|that|with|from|been|also|just|nba|prop|bet|pick|best|today)\b/i.test(
        name
      )
    )
      return;
    const nameParts = name.trim().split(/\s+/);
    if (
      nameParts.length < 2 ||
      nameParts.some(
        (p) =>
          p.length > 0 &&
          /^[a-z]/.test(p) &&
          p !== 'de' &&
          p !== 'van' &&
          p !== 'von'
      )
    )
      return;
    const statType = mapStatName(rawStat);
    if (!statType) return;
    const key = `${name.toLowerCase()}|${statType}|${direction}`;
    if (seen.has(key)) return;
    seen.add(key);
    picks.push({
      source: 'Covers',
      playerName: name,
      statType,
      pick: direction,
      line,
      expertName,
    });
  };

  // Short format: "Name o22.5 Points Scored (-120)"
  const shortRe =
    /(?:>|\s)([\w][\w '.'-]{2,35}?)\s+(o|u)([\d.]+)\s+([\w\s+]+?)\s*\([+-]\d+\)/g;
  let m;
  while ((m = shortRe.exec(html)) !== null) {
    addPick(
      m[1].trim(),
      m[2] === 'o' ? 'OVER' : 'UNDER',
      parseFloat(m[3]),
      m[4].trim()
    );
  }

  // Long format: "Name Over/Under 22.5 points"
  const longRe =
    /([\w][\w '.'-]{2,35}?)\s+(Over|Under)\s+([\d.]+)\s+(points|rebounds|assists|threes|blocks|steals|turnovers|three-pointers?|3-pointers?)/gi;
  while ((m = longRe.exec(html)) !== null) {
    addPick(
      m[1].trim(),
      m[2].toUpperCase() as 'OVER' | 'UNDER',
      parseFloat(m[3]),
      m[4].trim()
    );
  }

  // Twitter-style format: "Name OVER 22.5 PTS"
  const twitterRe =
    /([\w][\w '.'-]{2,35}?)\s+(OVER|UNDER|O|U)\s+([\d.]+)\s+(PTS|REB|AST|BLK|STL|3PM|TO|PRA|PA|PR|RA|BS|points?|rebounds?|assists?|threes?|blocks?|steals?)/gi;
  while ((m = twitterRe.exec(html)) !== null) {
    const dir = m[2].toUpperCase().startsWith('O') ? 'OVER' : 'UNDER';
    addPick(
      m[1].trim(),
      dir as 'OVER' | 'UNDER',
      parseFloat(m[3]),
      m[4].trim()
    );
  }

  return picks;
}

// ─── Cache ──────────────────────────────────────────────────────────────────

let coversCache: { data: CoversExpertPick[]; timestamp: number } | null = null;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch all expert picks from Covers.com/picks/nba.
 * Cached for 1 hour.
 */
export async function getCoversExpertPicks(): Promise<CoversExpertPick[]> {
  if (coversCache && Date.now() - coversCache.timestamp < CACHE_TTL) {
    console.log(
      `[Covers] Returning cached picks (${coversCache.data.length})`
    );
    return coversCache.data;
  }

  const picks: CoversExpertPick[] = [];

  try {
    console.log('[Covers] Fetching Covers.com picks...');
    const listRes = await fetch('https://www.covers.com/picks/nba', {
      headers: HEADERS,
    });
    if (!listRes.ok) {
      console.log(`[Covers] HTTP ${listRes.status}`);
      return [];
    }

    const listHtml = await listRes.text();
    const articleUrls = new Set<string>();
    const urlRe =
      /href="(https:\/\/www\.covers\.com\/nba\/[^"]*(?:prediction|prop|pick|best)[^"]+)"/gi;
    let urlMatch;
    while ((urlMatch = urlRe.exec(listHtml)) !== null) {
      articleUrls.add(urlMatch[1]);
    }

    console.log(`[Covers] Found ${articleUrls.size} articles`);

    if (articleUrls.size === 0) {
      picks.push(...extractPicksFromHtml(listHtml, 'Covers Expert'));
    } else {
      const results = await Promise.allSettled(
        [...articleUrls].slice(0, 8).map(async (url) => {
          const res = await fetch(url, { headers: HEADERS });
          if (!res.ok) return [];
          const html = await res.text();
          // Try to extract expert name from URL
          const nameMatch = url.match(/\/([^/]+?)(?:-prediction|-prop|-pick)/i);
          const expertName = nameMatch
            ? nameMatch[1].replace(/-/g, ' ')
            : 'Covers Expert';
          return extractPicksFromHtml(html, expertName);
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

    console.log(`[Covers] ${picks.length} expert picks extracted`);
  } catch (err) {
    console.error(
      '[Covers] Error:',
      err instanceof Error ? err.message : err
    );
  }

  coversCache = { data: picks, timestamp: Date.now() };
  return picks;
}

/**
 * Check if a Covers expert agrees or disagrees with a given pick.
 * Returns 'agree', 'contradict', or null (no data).
 */
export async function checkCoversAlignment(
  playerName: string,
  statType: string,
  pickDirection: 'OVER' | 'UNDER'
): Promise<{ alignment: 'agree' | 'contradict'; expertName: string } | null> {
  const picks = await getCoversExpertPicks();

  const matching = picks.filter(
    (p) => namesMatch(p.playerName, playerName) && p.statType === statType
  );

  if (matching.length === 0) return null;

  // Use the first match
  const expert = matching[0];
  const alignment =
    expert.pick === pickDirection ? 'agree' : 'contradict';

  return { alignment, expertName: expert.expertName };
}
