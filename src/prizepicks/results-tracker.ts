/**
 * Results Tracker
 * 
 * Pulls actual box scores from ESPN, compares against our picks,
 * and tracks performance over time.
 */

import { getDatabase } from '../core/db/database';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PickResult {
  pickId: number;
  playerName: string;
  statType: string;
  line: number;
  pick: 'OVER' | 'UNDER';
  actualResult: number | null;
  hit: boolean | null;
}

export interface PerformanceStats {
  totalPicks: number;
  hits: number;
  misses: number;
  pending: number;
  hitRate: number;
  byConfidence: Record<number, { total: number; hits: number; rate: number }>;
  bySport: Record<string, { total: number; hits: number; rate: number }>;
  byStatType: Record<string, { total: number; hits: number; rate: number }>;
}

export interface Streak {
  type: 'hot' | 'cold';
  length: number;
  statType: string;
  league: string;
}

// ─── ESPN Box Score Parsing ──────────────────────────────────────────────────

const ESPN_BASE = 'https://site.api.espn.com/apis';

/**
 * Get completed game IDs for a given date
 */
async function getGameIds(date: string, league = 'nba'): Promise<string[]> {
  const dateFormatted = date.replace(/-/g, '');
  const sport = league === 'nba' ? 'basketball/nba' : `basketball/${league}`;
  const res = await fetch(
    `${ESPN_BASE}/site/v2/sports/${sport}/scoreboard?dates=${dateFormatted}`,
    { headers: { Accept: 'application/json' } }
  );
  if (!res.ok) return [];

  const data = (await res.json()) as { events?: Array<{ id: string; status?: { type?: { completed?: boolean } } }> };
  return (data.events || [])
    .filter((e) => e.status?.type?.completed)
    .map((e) => e.id);
}

/**
 * Fetch box score for a game and extract player stats
 */
async function getBoxScore(
  gameId: string,
  league = 'nba'
): Promise<Map<string, Record<string, number>>> {
  const sport = league === 'nba' ? 'basketball/nba' : `basketball/${league}`;
  const res = await fetch(
    `${ESPN_BASE}/site/v2/sports/${sport}/summary?event=${gameId}`,
    { headers: { Accept: 'application/json' } }
  );
  if (!res.ok) return new Map();

  const data = (await res.json()) as Record<string, unknown>;
  const playerStats = new Map<string, Record<string, number>>();

  // Parse boxscore from summary
  const boxscore = (data as any)?.boxscore;
  if (!boxscore?.players) return playerStats;

  for (const team of boxscore.players) {
    for (const statGroup of team.statistics || []) {
      const labels: string[] = statGroup.labels || [];
      for (const athlete of statGroup.athletes || []) {
        const name: string = athlete.athlete?.displayName || '';
        if (!name) continue;

        const stats: string[] = athlete.stats || [];
        const statMap: Record<string, number> = {};

        labels.forEach((label: string, i: number) => {
          const val = parseFloat(stats[i]);
          if (!isNaN(val)) {
            statMap[label.toUpperCase()] = val;
          }
        });

        // Compute derived
        statMap['PTS+REBS+ASTS'] =
          (statMap['PTS'] || 0) + (statMap['REB'] || 0) + (statMap['AST'] || 0);
        statMap['BLKS+STLS'] =
          (statMap['BLK'] || 0) + (statMap['STL'] || 0);

        playerStats.set(name.toLowerCase(), statMap);
      }
    }
  }

  return playerStats;
}

// ─── Stat Type Resolution ────────────────────────────────────────────────────

function resolveStatKey(statType: string): string {
  const map: Record<string, string> = {
    'Points': 'PTS',
    'Rebounds': 'REB',
    'Assists': 'AST',
    'Steals': 'STL',
    'Blocks': 'BLK',
    'Turnovers': 'TO',
    '3-PT Made': '3PM',
    'Fantasy Score': 'FPTS',
    'Pts+Rebs+Asts': 'PTS+REBS+ASTS',
    'Blks+Stls': 'BLKS+STLS',
  };
  return map[statType] || statType.toUpperCase();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check results for a specific date: pull box scores, compare to our picks
 */
export async function checkResults(date: string): Promise<PickResult[]> {
  const db = getDatabase();

  // Get our picks for this date
  const picks = db.prepare(`
    SELECT id, player_name, stat_type, line, pick, league
    FROM prizepicks_picks
    WHERE date = ? AND hit IS NULL
  `).all(date) as Array<{
    id: number; player_name: string; stat_type: string;
    line: number; pick: string; league: string;
  }>;

  if (picks.length === 0) return [];

  // Fetch all box scores for the date
  const gameIds = await getGameIds(date);
  const allPlayerStats = new Map<string, Record<string, number>>();

  for (const gid of gameIds) {
    const boxScore = await getBoxScore(gid);
    for (const [name, stats] of boxScore) {
      allPlayerStats.set(name, stats);
    }
  }

  // Match picks to results
  const results: PickResult[] = [];
  for (const pick of picks) {
    const stats = allPlayerStats.get(pick.player_name.toLowerCase());
    const statKey = resolveStatKey(pick.stat_type);
    const actual = stats?.[statKey] ?? null;

    let hit: boolean | null = null;
    if (actual !== null) {
      hit = pick.pick === 'OVER' ? actual > pick.line : actual < pick.line;
    }

    results.push({
      pickId: pick.id,
      playerName: pick.player_name,
      statType: pick.stat_type,
      line: pick.line,
      pick: pick.pick as 'OVER' | 'UNDER',
      actualResult: actual,
      hit,
    });
  }

  return results;
}

/**
 * Update the DB with actual results for a date
 */
export async function updatePickResults(date: string): Promise<number> {
  const results = await checkResults(date);
  const db = getDatabase();

  let updated = 0;
  const stmt = db.prepare(`
    UPDATE prizepicks_picks
    SET actual_result = ?, hit = ?, resolved_at = datetime('now')
    WHERE id = ?
  `);

  for (const r of results) {
    if (r.actualResult !== null) {
      stmt.run(r.actualResult, r.hit ? 1 : 0, r.pickId);
      updated++;
    }
  }

  // Update performance summary
  if (updated > 0) {
    const summary = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END) as hits,
        SUM(CASE WHEN hit = 0 THEN 1 ELSE 0 END) as misses
      FROM prizepicks_picks
      WHERE date = ? AND hit IS NOT NULL
    `).get(date) as { total: number; hits: number; misses: number };

    db.prepare(`
      INSERT OR REPLACE INTO prizepicks_performance (date, total_picks, hits, misses, hit_rate)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      date,
      summary.total,
      summary.hits,
      summary.misses,
      summary.total > 0 ? summary.hits / summary.total : 0
    );
  }

  return updated;
}

/**
 * Get performance stats over the last N days
 */
export function getPerformanceStats(days?: number): PerformanceStats {
  const db = getDatabase();
  const dateFilter = days
    ? `AND date >= date('now', '-${days} days')`
    : '';

  const picks = db.prepare(`
    SELECT * FROM prizepicks_picks
    WHERE 1=1 ${dateFilter}
  `).all() as Array<Record<string, unknown>>;

  const resolved = picks.filter((p) => p.hit !== null);
  const hits = resolved.filter((p) => p.hit === 1);

  // By confidence
  const byConfidence: Record<number, { total: number; hits: number; rate: number }> = {};
  for (let c = 1; c <= 5; c++) {
    const confPicks = resolved.filter((p) => p.confidence === c);
    const confHits = confPicks.filter((p) => p.hit === 1);
    byConfidence[c] = {
      total: confPicks.length,
      hits: confHits.length,
      rate: confPicks.length > 0 ? confHits.length / confPicks.length : 0,
    };
  }

  // By sport
  const bySport: Record<string, { total: number; hits: number; rate: number }> = {};
  const leagues = [...new Set(resolved.map((p) => p.league as string))];
  for (const league of leagues) {
    const lPicks = resolved.filter((p) => p.league === league);
    const lHits = lPicks.filter((p) => p.hit === 1);
    bySport[league] = {
      total: lPicks.length,
      hits: lHits.length,
      rate: lPicks.length > 0 ? lHits.length / lPicks.length : 0,
    };
  }

  // By stat type
  const byStatType: Record<string, { total: number; hits: number; rate: number }> = {};
  const statTypes = [...new Set(resolved.map((p) => p.stat_type as string))];
  for (const st of statTypes) {
    const sPicks = resolved.filter((p) => p.stat_type === st);
    const sHits = sPicks.filter((p) => p.hit === 1);
    byStatType[st] = {
      total: sPicks.length,
      hits: sHits.length,
      rate: sPicks.length > 0 ? sHits.length / sPicks.length : 0,
    };
  }

  return {
    totalPicks: picks.length,
    hits: hits.length,
    misses: resolved.length - hits.length,
    pending: picks.length - resolved.length,
    hitRate: resolved.length > 0 ? hits.length / resolved.length : 0,
    byConfidence,
    bySport,
    byStatType,
  };
}

/**
 * Get current hot/cold streaks
 */
export function getStreaks(): Streak[] {
  const db = getDatabase();
  const recentPicks = db.prepare(`
    SELECT player_name, stat_type, league, hit
    FROM prizepicks_picks
    WHERE hit IS NOT NULL
    ORDER BY date DESC, id DESC
    LIMIT 100
  `).all() as Array<{ player_name: string; stat_type: string; league: string; hit: number }>;

  if (recentPicks.length === 0) return [];

  // Overall streak
  const streaks: Streak[] = [];
  let currentStreak = 0;
  let streakType: 'hot' | 'cold' = recentPicks[0].hit === 1 ? 'hot' : 'cold';

  for (const pick of recentPicks) {
    const isHit = pick.hit === 1;
    if ((streakType === 'hot' && isHit) || (streakType === 'cold' && !isHit)) {
      currentStreak++;
    } else {
      break;
    }
  }

  streaks.push({
    type: streakType,
    length: currentStreak,
    statType: 'Overall',
    league: 'ALL',
  });

  return streaks;
}
