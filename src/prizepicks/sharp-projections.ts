/**
 * Sharp Projections Scraper
 *
 * Scrapes player projection lines from sharp model sites:
 *   - Dimers.com  — https://www.dimers.com/nba/player-projections
 *   - BettingPros — https://www.bettingpros.com/nba/picks/prop-bets/
 *
 * These are SUPPLEMENTARY signals only. If scraping fails (anti-bot, 403, etc.)
 * we return empty gracefully — nothing crashes.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Map<playerName, Map<statType, projectedLine>> */
export type SharpProjectionMap = Map<string, Map<string, number>>;

// ─── Cache ───────────────────────────────────────────────────────────────────

const CACHE_TTL = 60 * 60 * 1000; // 1 hour

let dimersCache: { data: SharpProjectionMap; timestamp: number } | null = null;
let bettingProsCache: { data: SharpProjectionMap; timestamp: number } | null = null;

// ─── Shared Helpers ───────────────────────────────────────────────────────────

const SCRAPE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Cache-Control': 'no-cache',
};

function normalizeStatType(raw: string): string | null {
  const lower = raw.toLowerCase().trim();
  if (lower.includes('point') || lower === 'pts') return 'Points';
  if (lower.includes('rebound') || lower === 'reb' || lower === 'rebs') return 'Rebounds';
  if (lower.includes('assist') || lower === 'ast' || lower === 'asts') return 'Assists';
  if (
    lower.includes('3-pt') ||
    lower.includes('3pt') ||
    lower.includes('three') ||
    lower === 'threes' ||
    lower === '3pm'
  )
    return '3-PT Made';
  if (lower.includes('steal')) return 'Steals';
  if (lower.includes('block')) return 'Blocked Shots';
  if (lower.includes('turnover') || lower === 'to') return 'Turnovers';
  if (lower.includes('pts') && lower.includes('reb') && lower.includes('ast'))
    return 'Pts+Rebs+Asts';
  if (lower.includes('pts') && lower.includes('reb')) return 'Pts+Rebs';
  if (lower.includes('pts') && lower.includes('ast')) return 'Pts+Asts';
  if (lower.includes('reb') && lower.includes('ast')) return 'Rebs+Asts';
  if (lower.includes('blk') && lower.includes('stl')) return 'Blks+Stls';
  return null;
}

function addProjection(
  map: SharpProjectionMap,
  playerName: string,
  statType: string,
  value: number
): void {
  if (!map.has(playerName)) map.set(playerName, new Map());
  map.get(playerName)!.set(statType, value);
}

// ─── Dimers.com ───────────────────────────────────────────────────────────────

/**
 * Scrape Dimers.com NBA player projections.
 * Expected HTML contains tables/rows with player name + projected stats.
 *
 * The Dimers projections page is JavaScript-heavy; if the raw HTML scrape
 * doesn't yield data we return empty gracefully.
 */
async function fetchDimersProjections(): Promise<SharpProjectionMap> {
  if (dimersCache && Date.now() - dimersCache.timestamp < CACHE_TTL) {
    return dimersCache.data;
  }

  const map: SharpProjectionMap = new Map();

  try {
    console.log('[SharpProj] Fetching Dimers projections...');
    const res = await fetch('https://www.dimers.com/nba/player-projections', {
      headers: SCRAPE_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.log(`[SharpProj] Dimers HTTP ${res.status} — skipping`);
      dimersCache = { data: map, timestamp: Date.now() };
      return map;
    }

    const html = await res.text();

    // Dimers renders a table-like structure. Try to parse JSON data from embedded scripts.
    // Pattern: "__NEXT_DATA__" or "window.__PRELOADED_STATE__" embedded JSON
    const jsonMatch =
      html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/) ||
      html.match(/window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});\s*<\/script>/);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);

        // Walk the parsed JSON looking for player projection objects
        // Dimers structure varies; we search recursively for player name + stat patterns
        const extract = (obj: unknown, depth = 0): void => {
          if (depth > 8 || !obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) {
            for (const item of obj) extract(item, depth + 1);
            return;
          }
          const record = obj as Record<string, unknown>;
          // Look for objects that have playerName/name + a numeric projection value
          const nameKey = Object.keys(record).find(
            (k) =>
              k.toLowerCase().includes('player') ||
              k.toLowerCase() === 'name' ||
              k.toLowerCase() === 'athlete'
          );
          if (nameKey && typeof record[nameKey] === 'string') {
            const playerName = record[nameKey] as string;
            // Check for stat projections
            for (const [key, val] of Object.entries(record)) {
              if (typeof val !== 'number') continue;
              const statType = normalizeStatType(key);
              if (statType && val > 0 && val < 100) {
                addProjection(map, playerName, statType, Math.round(val * 10) / 10);
              }
            }
          }
          for (const val of Object.values(record)) extract(val, depth + 1);
        };

        extract(parsed);
        console.log(`[SharpProj] Dimers: parsed ${map.size} player projections from JSON`);
      } catch {
        // JSON parse failed — fall through to regex scrape
      }
    }

    // Fallback: regex parse table rows for patterns like:
    //   "LeBron James   28.4   7.8   6.2"
    if (map.size === 0) {
      // Try to parse stat headers and data rows from HTML tables
      const tableMatch = html.match(/<table[\s\S]*?<\/table>/gi);
      if (tableMatch) {
        for (const table of tableMatch.slice(0, 10)) {
          const headers: string[] = [];
          const thRe = /<th[^>]*>(.*?)<\/th>/gi;
          let thMatch;
          while ((thMatch = thRe.exec(table)) !== null) {
            headers.push(thMatch[1].replace(/<[^>]+>/g, '').trim());
          }

          const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
          let rowMatch;
          while ((rowMatch = rowRe.exec(table)) !== null) {
            const cells: string[] = [];
            const tdRe = /<td[^>]*>(.*?)<\/td>/gi;
            let tdMatch;
            while ((tdMatch = tdRe.exec(rowMatch[1])) !== null) {
              cells.push(tdMatch[1].replace(/<[^>]+>/g, '').trim());
            }
            if (cells.length < 2) continue;
            const playerName = cells[0];
            if (!playerName || !playerName.includes(' ')) continue;
            for (let i = 1; i < cells.length && i < headers.length; i++) {
              const val = parseFloat(cells[i]);
              if (isNaN(val) || val <= 0) continue;
              const statType = normalizeStatType(headers[i]);
              if (statType) addProjection(map, playerName, statType, Math.round(val * 10) / 10);
            }
          }
        }
      }

      console.log(
        `[SharpProj] Dimers (regex fallback): ${map.size} player projections`
      );
    }
  } catch (err) {
    console.log(
      `[SharpProj] Dimers error (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  dimersCache = { data: map, timestamp: Date.now() };
  return map;
}

// ─── BettingPros ─────────────────────────────────────────────────────────────

/**
 * Scrape BettingPros NBA prop analyzer for model projections.
 * Returns projected lines from their consensus model.
 */
async function fetchBettingProsProjections(): Promise<SharpProjectionMap> {
  if (bettingProsCache && Date.now() - bettingProsCache.timestamp < CACHE_TTL) {
    return bettingProsCache.data;
  }

  const map: SharpProjectionMap = new Map();

  try {
    console.log('[SharpProj] Fetching BettingPros projections...');
    const res = await fetch('https://www.bettingpros.com/nba/picks/prop-bets/', {
      headers: SCRAPE_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.log(`[SharpProj] BettingPros HTTP ${res.status} — skipping`);
      bettingProsCache = { data: map, timestamp: Date.now() };
      return map;
    }

    const html = await res.text();

    // BettingPros embeds data in JSON-LD or app state scripts
    const jsonMatch =
      html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/) ||
      html.match(/window\.__APP_STATE__\s*=\s*({[\s\S]*?});\s*<\/script>/);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);

        // BettingPros prop structure typically has:
        // player { name, projections: { pts, reb, ast, ... } }
        const extract = (obj: unknown, depth = 0): void => {
          if (depth > 8 || !obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) {
            for (const item of obj) extract(item, depth + 1);
            return;
          }
          const record = obj as Record<string, unknown>;

          // BettingPros often has { player: { name }, projection: number, type: "Points" }
          if (
            typeof record['projection'] === 'number' &&
            typeof record['type'] === 'string'
          ) {
            // Find player name nearby
            const playerObj = record['player'] as Record<string, unknown> | undefined;
            const playerName =
              typeof playerObj?.['name'] === 'string'
                ? playerObj['name']
                : typeof playerObj?.['full_name'] === 'string'
                ? (playerObj['full_name'] as string)
                : null;

            if (playerName && playerName.includes(' ')) {
              const statType = normalizeStatType(record['type'] as string);
              const val = record['projection'] as number;
              if (statType && val > 0 && val < 100) {
                addProjection(map, playerName, statType, Math.round(val * 10) / 10);
              }
            }
          }

          for (const val of Object.values(record)) extract(val, depth + 1);
        };

        extract(parsed);
        console.log(`[SharpProj] BettingPros: ${map.size} projections from JSON`);
      } catch {
        // ignore
      }
    }

    // Fallback: parse HTML prop cards
    // Pattern: <div class="player-name">LeBron James</div> ... <span class="projection">28.4</span>
    if (map.size === 0) {
      const cardRe =
        /<(?:div|span)[^>]*class="[^"]*(?:player[_-]name|athlete[_-]name)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/gi;
      const projRe =
        /<(?:div|span)[^>]*class="[^"]*(?:projection|proj[_-]line|model[_-]projection)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/gi;

      const players: string[] = [];
      const projections: { value: number; stat: string }[] = [];

      let m;
      while ((m = cardRe.exec(html)) !== null) {
        const name = m[1].replace(/<[^>]+>/g, '').trim();
        if (name && name.includes(' ')) players.push(name);
      }

      while ((m = projRe.exec(html)) !== null) {
        const text = m[1].replace(/<[^>]+>/g, '').trim();
        const val = parseFloat(text);
        if (!isNaN(val) && val > 0) {
          projections.push({ value: val, stat: 'Points' }); // default
        }
      }

      // Basic pairing (imprecise but supplementary)
      for (let i = 0; i < Math.min(players.length, projections.length); i++) {
        const { value, stat } = projections[i];
        const statType = normalizeStatType(stat);
        if (statType) addProjection(map, players[i], statType, Math.round(value * 10) / 10);
      }

      console.log(`[SharpProj] BettingPros (regex fallback): ${map.size} projections`);
    }
  } catch (err) {
    console.log(
      `[SharpProj] BettingPros error (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  bettingProsCache = { data: map, timestamp: Date.now() };
  return map;
}

// ─── Cached combined projections ─────────────────────────────────────────────

let combinedCache: { data: SharpProjectionMap; timestamp: number } | null = null;
const COMBINED_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch and merge projections from all sharp model sources.
 * When the same player appears in multiple sources, we average the values.
 */
async function getAllSharpProjections(): Promise<SharpProjectionMap> {
  if (combinedCache && Date.now() - combinedCache.timestamp < COMBINED_CACHE_TTL) {
    return combinedCache.data;
  }

  const [dimers, bettingPros] = await Promise.all([
    fetchDimersProjections().catch((): SharpProjectionMap => new Map()),
    fetchBettingProsProjections().catch((): SharpProjectionMap => new Map()),
  ]);

  // Merge: for each player/stat, average available values
  const merged: SharpProjectionMap = new Map();

  for (const [player, stats] of dimers) {
    if (!merged.has(player)) merged.set(player, new Map());
    for (const [stat, val] of stats) {
      merged.get(player)!.set(stat, val);
    }
  }

  for (const [player, stats] of bettingPros) {
    // Try to find matching player in merged (normalize names)
    let targetKey = player;
    if (!merged.has(player)) {
      // Look for close match
      for (const existing of merged.keys()) {
        if (namesMatchSimple(existing, player)) {
          targetKey = existing;
          break;
        }
      }
      if (!merged.has(targetKey)) {
        merged.set(targetKey, new Map());
      }
    }

    const mergedStats = merged.get(targetKey)!;
    for (const [stat, val] of stats) {
      if (mergedStats.has(stat)) {
        // Average the two sources
        mergedStats.set(stat, Math.round(((mergedStats.get(stat)! + val) / 2) * 10) / 10);
      } else {
        mergedStats.set(stat, val);
      }
    }
  }

  console.log(`[SharpProj] Combined: ${merged.size} players with projections`);
  combinedCache = { data: merged, timestamp: Date.now() };
  return merged;
}

function namesMatchSimple(a: string, b: string): boolean {
  const clean = (s: string) => s.toLowerCase().trim().replace(/[^a-z\s]/g, '');
  return clean(a) === clean(b);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get a sharp model projection for a player/stat type.
 * Averages Dimers + BettingPros projections when both are available.
 *
 * Returns null if no sharp projection found (graceful fallback).
 */
export async function getSharpProjection(
  playerName: string,
  statType: string
): Promise<number | null> {
  try {
    const all = await getAllSharpProjections();

    // Find player by name (exact or close match)
    let found: Map<string, number> | undefined;

    if (all.has(playerName)) {
      found = all.get(playerName);
    } else {
      // Try partial match (last name + first initial)
      for (const [key, stats] of all) {
        if (namesMatchFuzzy(key, playerName)) {
          found = stats;
          break;
        }
      }
    }

    if (!found) return null;
    const val = found.get(statType);
    return val ?? null;
  } catch (err) {
    console.log(
      `[SharpProj] getSharpProjection error (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

function namesMatchFuzzy(a: string, b: string): boolean {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .trim()
      .replace(/\s+(jr\.?|sr\.?|iii|ii|iv)$/i, '');
  const aC = clean(a);
  const bC = clean(b);
  if (aC === bC) return true;
  const aParts = aC.split(/\s+/);
  const bParts = bC.split(/\s+/);
  if (aParts.length < 2 || bParts.length < 2) return false;
  // Last names must match exactly
  if (aParts[aParts.length - 1] !== bParts[bParts.length - 1]) return false;
  // First names must share at least 3 chars (not just initial)
  // Prevents "Kyshawn George" matching "Keyonte George"
  const aFirst = aParts[0];
  const bFirst = bParts[0];
  const minLen = Math.min(aFirst.length, bFirst.length);
  if (minLen >= 3) {
    return aFirst.slice(0, 3) === bFirst.slice(0, 3);
  }
  // Short first names: must match fully
  return aFirst === bFirst;
}

/**
 * Build a human-readable note for the reasoning string.
 */
export function describeSharpProjection(
  playerName: string,
  statType: string,
  sharpProj: number,
  ppLine: number,
  pickDirection: 'OVER' | 'UNDER'
): string {
  const diff = sharpProj - ppLine;
  const agrees = (diff > 0 && pickDirection === 'OVER') || (diff < 0 && pickDirection === 'UNDER');
  const agreesStr = agrees ? 'agrees with' : 'conflicts with';
  return `Dimers projects ${sharpProj} (${agreesStr} ${pickDirection})`;
}
