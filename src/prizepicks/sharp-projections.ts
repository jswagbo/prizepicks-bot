/**
 * Sharp Projections — Dimers/StatsInsider API
 *
 * Fetches player projections from Dimers' backend (StatsInsider API).
 * This is a direct API call — no HTML scraping needed.
 *
 * API endpoints:
 *   - Round options: https://levy-edge.statsinsider.com.au/round/options?Sport=NBA
 *   - Box scores:   https://levy-edge.statsinsider.com.au/round/boxscores?Sport=NBA&Round={round}&Season={season}
 *
 * These are SUPPLEMENTARY signals. If the API is down, we return empty gracefully.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Map<playerName, Map<statType, projectedLine>> */
export type SharpProjectionMap = Map<string, Map<string, number>>;

interface RoundOption {
  Active: boolean;
  Round_Date: string;  // "2026-02-23"
  Round_Number: number;
  Year: number;
}

interface PlayerProjection {
  first_name: string;
  last_name: string;
  unique_name: string;
  points: number;
  rebounds: number;
  assists: number;
  pra: number;       // Pts+Rebs+Asts
  pr: number;        // Pts+Rebs
  pa: number;        // Pts+Asts
  three_points: number;
  blocks: number;
  steals: number;
  turnovers: number;
  fantasy: number;
}

interface BoxScoreGame {
  MatchData: {
    HomeTeam: { Nickname: string; Abv: string };
    AwayTeam: { Nickname: string; Abv: string };
    Date: string;
  };
  projBoxScore: {
    home: PlayerProjection[];
    away: PlayerProjection[];
  };
}

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─── Cache ───────────────────────────────────────────────────────────────────

const CACHE_TTL = 60 * 60 * 1000; // 1 hour

let dimersCache: { data: SharpProjectionMap; timestamp: number } | null = null;
let bettingProsCache: { data: SharpProjectionMap; timestamp: number } | null = null;
let combinedCache: { data: SharpProjectionMap; timestamp: number } | null = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const API_BASE = 'https://levy-edge.statsinsider.com.au';

function addProjection(
  map: SharpProjectionMap,
  playerName: string,
  statType: string,
  value: number
): void {
  if (value <= 0) return;
  const rounded = Math.round(value * 10) / 10;
  if (!map.has(playerName)) map.set(playerName, new Map());
  map.get(playerName)!.set(statType, rounded);
}

function mapPlayerToProjections(map: SharpProjectionMap, player: PlayerProjection): void {
  const name = `${player.first_name} ${player.last_name}`;
  addProjection(map, name, 'Points', player.points);
  addProjection(map, name, 'Rebounds', player.rebounds);
  addProjection(map, name, 'Assists', player.assists);
  addProjection(map, name, 'Pts+Rebs+Asts', player.pra);
  addProjection(map, name, 'Pts+Rebs', player.pr);
  addProjection(map, name, 'Pts+Asts', player.pa);
  addProjection(map, name, '3-PT Made', player.three_points);
  addProjection(map, name, 'Blocked Shots', player.blocks);
  addProjection(map, name, 'Steals', player.steals);
  addProjection(map, name, 'Turnovers', player.turnovers);
  addProjection(map, name, 'Fantasy Score', player.fantasy);
  // Compute Rebs+Asts (not provided directly)
  if (player.rebounds > 0 && player.assists > 0) {
    addProjection(map, name, 'Rebs+Asts', player.rebounds + player.assists);
  }
  // Compute Blks+Stls
  if (player.blocks > 0 && player.steals > 0) {
    addProjection(map, name, 'Blks+Stls', player.blocks + player.steals);
  }
}

// ─── Dimers / StatsInsider API ───────────────────────────────────────────────

/**
 * Find today's active round number and season from the StatsInsider API.
 */
async function getTodayRound(): Promise<{ round: number; season: number } | null> {
  try {
    const res = await fetch(`${API_BASE}/round/options?Sport=NBA`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.log(`[SharpProj] Round options HTTP ${res.status}`);
      return null;
    }
    const rounds = (await res.json()) as RoundOption[];
    // Find today's active round
    const today = new Date().toISOString().slice(0, 10);
    const todayRound = rounds.find(r => r.Active && r.Round_Date === today);
    if (todayRound) {
      return { round: todayRound.Round_Number, season: todayRound.Year };
    }
    // Fallback: most recent active round
    const active = rounds.filter(r => r.Active).sort((a, b) => b.Round_Number - a.Round_Number);
    if (active.length > 0) {
      return { round: active[0].Round_Number, season: active[0].Year };
    }
    console.log('[SharpProj] No active round found');
    return null;
  } catch (err) {
    console.log(`[SharpProj] Round options error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Fetch Dimers player projections via StatsInsider API.
 * Returns projections for every player in today's games.
 */
async function fetchDimersProjections(): Promise<SharpProjectionMap> {
  if (dimersCache && Date.now() - dimersCache.timestamp < CACHE_TTL) {
    return dimersCache.data;
  }

  const map: SharpProjectionMap = new Map();

  try {
    const roundInfo = await getTodayRound();
    if (!roundInfo) {
      console.log('[SharpProj] Cannot determine today\'s round — skipping Dimers');
      dimersCache = { data: map, timestamp: Date.now() };
      return map;
    }

    console.log(`[SharpProj] Fetching Dimers projections: Round ${roundInfo.round}, Season ${roundInfo.season}...`);
    const res = await fetch(
      `${API_BASE}/round/boxscores?Sport=NBA&Round=${roundInfo.round}&Season=${roundInfo.season}`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!res.ok) {
      console.log(`[SharpProj] Dimers boxscores HTTP ${res.status}`);
      dimersCache = { data: map, timestamp: Date.now() };
      return map;
    }

    const games = (await res.json()) as BoxScoreGame[];
    let playerCount = 0;

    for (const game of games) {
      const home = game.MatchData.HomeTeam.Nickname;
      const away = game.MatchData.AwayTeam.Nickname;

      for (const player of game.projBoxScore.home || []) {
        mapPlayerToProjections(map, player);
        playerCount++;
      }
      for (const player of game.projBoxScore.away || []) {
        mapPlayerToProjections(map, player);
        playerCount++;
      }

      console.log(`[SharpProj] ${away} @ ${home}: ${(game.projBoxScore.away || []).length + (game.projBoxScore.home || []).length} players`);
    }

    console.log(`[SharpProj] Dimers: ${map.size} players, ${playerCount} projections across ${games.length} games`);
  } catch (err) {
    console.log(`[SharpProj] Dimers error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  dimersCache = { data: map, timestamp: Date.now() };
  return map;
}

// ─── BettingPros (via Python/Scrapling helper) ──────────────────────────────

interface BettingProsProp {
  playerName: string;
  statType: string;
  projection: number;
  side: string;
  ev: number;
  betRating: number;
  diff: number;
  probability: number;
  team: string;
}

/**
 * Fetch BettingPros projections via the Python helper script.
 * Uses Scrapling DynamicFetcher to render the JS-heavy page and extract
 * embedded prop data (projections, EV, bet ratings).
 *
 * Returns top 25 props sorted by biggest divergence (highest EV).
 */
async function fetchBettingProsProjections(): Promise<SharpProjectionMap> {
  if (bettingProsCache && Date.now() - bettingProsCache.timestamp < CACHE_TTL) {
    return bettingProsCache.data;
  }

  const map: SharpProjectionMap = new Map();

  try {
    // Find the Python script
    const scriptPath = join(process.cwd(), 'scripts', 'fetch-bettingpros.py');

    if (!existsSync(scriptPath)) {
      console.log('[SharpProj] BettingPros script not found — skipping');
      bettingProsCache = { data: map, timestamp: Date.now() };
      return map;
    }

    // Use project .venv if available, otherwise system python3
    const localVenv = join(process.cwd(), '.venv', 'bin', 'python3');
    const venvPython = existsSync(localVenv) ? localVenv : 'python3';

    console.log('[SharpProj] Fetching BettingPros projections via Scrapling...');

    const output = execSync(`${venvPython} "${scriptPath}"`, {
      timeout: 60000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const props: BettingProsProp[] = JSON.parse(output.trim());

    for (const prop of props) {
      if (!prop.playerName || !prop.statType || prop.projection <= 0) continue;
      if (!map.has(prop.playerName)) map.set(prop.playerName, new Map());
      map.get(prop.playerName)!.set(prop.statType, Math.round(prop.projection * 10) / 10);
    }

    console.log(`[SharpProj] BettingPros: ${props.length} props, ${map.size} players`);
  } catch (err) {
    console.log(`[SharpProj] BettingPros error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  bettingProsCache = { data: map, timestamp: Date.now() };
  return map;
}

// ─── Combined Sharp Projections ─────────────────────────────────────────────

/**
 * Fetch and merge Dimers + BettingPros projections.
 * When both sources have a projection for the same player/stat, average them.
 */
async function getAllSharpProjections(): Promise<SharpProjectionMap> {
  if (combinedCache && Date.now() - combinedCache.timestamp < CACHE_TTL) {
    return combinedCache.data;
  }

  const [dimers, bettingPros] = await Promise.all([
    fetchDimersProjections().catch((): SharpProjectionMap => new Map()),
    fetchBettingProsProjections().catch((): SharpProjectionMap => new Map()),
  ]);

  // Merge: Dimers is primary (full coverage), BettingPros supplements
  const merged: SharpProjectionMap = new Map();

  // Copy all Dimers data
  for (const [player, stats] of dimers) {
    merged.set(player, new Map(stats));
  }

  // Merge BettingPros — average when both have data, add when only BP has it
  for (const [player, stats] of bettingPros) {
    // Find matching player in merged (fuzzy match)
    let targetKey = player;
    if (!merged.has(player)) {
      for (const existing of merged.keys()) {
        if (namesMatchFuzzy(existing, player)) {
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
        // Average Dimers + BettingPros
        const avg = Math.round(((mergedStats.get(stat)! + val) / 2) * 10) / 10;
        mergedStats.set(stat, avg);
      } else {
        mergedStats.set(stat, val);
      }
    }
  }

  const dimersCount = [...dimers.values()].reduce((s, m) => s + m.size, 0);
  const bpCount = [...bettingPros.values()].reduce((s, m) => s + m.size, 0);
  const mergedCount = [...merged.values()].reduce((s, m) => s + m.size, 0);
  console.log(`[SharpProj] Combined: Dimers ${dimersCount} + BettingPros ${bpCount} → ${mergedCount} total projections for ${merged.size} players`);

  combinedCache = { data: merged, timestamp: Date.now() };
  return merged;
}

// ─── Public API ──────────────────────────────────────────────────────────────

function namesMatchFuzzy(a: string, b: string): boolean {
  const clean = (s: string) =>
    s.toLowerCase().trim().replace(/\s+(jr\.?|sr\.?|iii|ii|iv)$/i, '');
  const aC = clean(a);
  const bC = clean(b);
  if (aC === bC) return true;
  const aParts = aC.split(/\s+/);
  const bParts = bC.split(/\s+/);
  if (aParts.length < 2 || bParts.length < 2) return false;
  // Last name match + first 3 chars of first name
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
 * Get a sharp model projection for a player/stat type.
 * Returns null if no projection found (graceful fallback).
 */
export async function getSharpProjection(
  playerName: string,
  statType: string
): Promise<number | null> {
  try {
    const all = await getAllSharpProjections();

    // Find player by name (exact or fuzzy match)
    let found: Map<string, number> | undefined;

    if (all.has(playerName)) {
      found = all.get(playerName);
    } else {
      for (const [key, stats] of all) {
        if (namesMatchFuzzy(key, playerName)) {
          found = stats;
          break;
        }
      }
    }

    if (!found) return null;
    return found.get(statType) ?? null;
  } catch (err) {
    console.log(`[SharpProj] getSharpProjection error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
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
  const pct = ppLine !== 0 ? ((diff / ppLine) * 100).toFixed(1) : '0';
  const agrees = (diff > 0 && pickDirection === 'OVER') || (diff < 0 && pickDirection === 'UNDER');
  const agreesStr = agrees ? '✅ agrees' : '⚠️ conflicts';
  return `Sharp models project ${sharpProj} (${agreesStr} with ${pickDirection}, ${diff > 0 ? '+' : ''}${pct}%)`;
}
