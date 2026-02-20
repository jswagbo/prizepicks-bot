/**
 * Pick Scorer
 * 
 * Scores PrizePicks projections to find the best value plays.
 * Combines matchup analysis with trend detection and home/away splits.
 */

import { type MatchupAnalysis } from './matchup-analyzer';
import { type PrizePicksProjection } from './prizepicks-client';
import { getDatabase } from '../core/db/database';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScoredPick {
  projection: PrizePicksProjection;
  matchup: MatchupAnalysis;
  pick: 'OVER' | 'UNDER';
  confidence: number; // 1-5 stars
  ev: number; // expected value edge as decimal
  totalScore: number;
  reasoning: string;
}

export interface ParlayPick {
  picks: ScoredPick[];
  combinedConfidence: number;
  correlationNote: string;
}

// ─── Score Constants ─────────────────────────────────────────────────────────

const MATCHUP_BONUS: Record<string, number> = {
  A: 0.05,
  B: 0.02,
  C: 0,
  D: -0.02,
  F: -0.05,
};

const TREND_BONUS = 0.03;
const HOME_BONUS = 0.01;

/**
 * Blowout penalty for OVER picks.
 * Starters get benched in blowouts, killing counting stats.
 * Scales with spread size: larger spread = bigger penalty.
 */
const BLOWOUT_SPREAD_THRESHOLD = 8; // spreads >= 8 start getting penalized
const BLOWOUT_PENALTY_PER_POINT = 0.008; // penalty per point of spread above threshold
const BLOWOUT_MAX_PENALTY = 0.08; // cap the penalty

// ─── Confidence Mapping ──────────────────────────────────────────────────────

/**
 * Map absolute score to 1-5 star confidence
 */
function scoreToConfidence(absScore: number): number {
  if (absScore >= 0.12) return 5;
  if (absScore >= 0.08) return 4;
  if (absScore >= 0.05) return 3;
  if (absScore >= 0.02) return 2;
  return 1;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Score a single projection using matchup data
 */
export function scoreProjection(
  projection: PrizePicksProjection,
  matchup: MatchupAnalysis
): ScoredPick {
  // Base edge: how far our model line is from PrizePicks line
  const baseEdge = matchup.prizePicksLine !== 0
    ? (matchup.estimatedLine - matchup.prizePicksLine) / matchup.prizePicksLine
    : 0;

  // Matchup bonus based on opponent defense grade
  const matchupBonus = MATCHUP_BONUS[matchup.matchupGrade] || 0;

  // Trend bonus: hot = last3 > last10 > season, cold = inverse
  let trendBonus = 0;
  if (matchup.last3Avg > matchup.last10Avg && matchup.last10Avg > matchup.seasonAvg) {
    trendBonus = TREND_BONUS; // Hot streak — favors OVER
  } else if (matchup.last3Avg < matchup.last10Avg && matchup.last10Avg < matchup.seasonAvg) {
    trendBonus = -TREND_BONUS; // Cold streak — favors UNDER
  }

  // Home court bonus
  const homeBonus = matchup.homeAway === 'home' ? HOME_BONUS : 0;

  // Blowout penalty: penalize OVERs in games with large spreads
  // Starters get benched early in blowouts → counting stats suffer
  let blowoutPenalty = 0;
  if (matchup.gameSpread !== null && matchup.gameSpread !== undefined) {
    const absSpread = Math.abs(matchup.gameSpread);
    if (absSpread >= BLOWOUT_SPREAD_THRESHOLD) {
      const excessSpread = absSpread - BLOWOUT_SPREAD_THRESHOLD;
      blowoutPenalty = Math.min(
        excessSpread * BLOWOUT_PENALTY_PER_POINT,
        BLOWOUT_MAX_PENALTY
      );
    }
  }

  // Total score (blowout penalty only applies against OVERs)
  const rawScore = baseEdge + matchupBonus + trendBonus + homeBonus;
  const totalScore = rawScore > 0 ? rawScore - blowoutPenalty : rawScore;

  // Pick direction
  const pick: 'OVER' | 'UNDER' = totalScore > 0 ? 'OVER' : 'UNDER';
  const confidence = scoreToConfidence(Math.abs(totalScore));

  // Build reasoning
  const reasons: string[] = [];
  if (Math.abs(baseEdge) > 0.02) {
    reasons.push(
      `Model line ${matchup.estimatedLine} vs PP line ${matchup.prizePicksLine} (${(baseEdge * 100).toFixed(1)}% edge)`
    );
  }
  if (matchup.matchupGrade === 'A' || matchup.matchupGrade === 'B') {
    reasons.push(`Favorable matchup (${matchup.matchupGrade}) vs ${matchup.opponent}`);
  } else if (matchup.matchupGrade === 'D' || matchup.matchupGrade === 'F') {
    reasons.push(`Tough matchup (${matchup.matchupGrade}) vs ${matchup.opponent}`);
  }
  if (trendBonus > 0) {
    reasons.push(`Hot trend: L3 ${matchup.last3Avg} > L10 ${matchup.last10Avg} > SZN ${matchup.seasonAvg}`);
  } else if (trendBonus < 0) {
    reasons.push(`Cold trend: L3 ${matchup.last3Avg} < L10 ${matchup.last10Avg} < SZN ${matchup.seasonAvg}`);
  }
  if (homeBonus > 0) {
    reasons.push('Home court advantage');
  }
  if (blowoutPenalty > 0 && rawScore > 0) {
    const absSpread = Math.abs(matchup.gameSpread!);
    reasons.push(`⚠️ Blowout risk: ${absSpread}pt spread → OVER penalized (-${(blowoutPenalty * 100).toFixed(1)}%)`);
  }

  return {
    projection,
    matchup,
    pick,
    confidence,
    ev: Math.round(Math.abs(totalScore) * 10000) / 10000,
    totalScore: Math.round(totalScore * 10000) / 10000,
    reasoning: reasons.join('. ') || 'Marginal edge detected',
  };
}

/**
 * Rank an array of projections by absolute edge (best first)
 */
export function rankProjections(scoredPicks: ScoredPick[]): ScoredPick[] {
  return [...scoredPicks].sort((a, b) => Math.abs(b.totalScore) - Math.abs(a.totalScore));
}

/**
 * Build the best 4-pick parlay from top picks.
 * Tries to avoid correlated picks (same game / same team).
 */
export function buildParlay(topPicks: ScoredPick[]): ParlayPick {
  const ranked = rankProjections(topPicks);
  const selected: ScoredPick[] = [];
  const usedGames = new Set<string>(); // track by opponent to avoid same-game correlation

  for (const pick of ranked) {
    if (selected.length >= 4) break;

    // Avoid picking multiple players from the same game
    const gameKey = [pick.projection.team, pick.matchup.opponent].sort().join('-');
    if (usedGames.has(gameKey)) continue;

    selected.push(pick);
    usedGames.add(gameKey);
  }

  const combinedConfidence = selected.length > 0
    ? Math.round(selected.reduce((s, p) => s + p.confidence, 0) / selected.length)
    : 0;

  const correlationNote = selected.length < 4
    ? `Only ${selected.length} uncorrelated picks available`
    : 'All picks from different games for max independence';

  return {
    picks: selected,
    combinedConfidence,
    correlationNote,
  };
}

/**
 * Save scored picks to the database
 */
export function savePicks(date: string, picks: ScoredPick[]): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO prizepicks_picks 
    (date, player_name, team, opponent, league, stat_type, line, pick,
     confidence, ev_estimate, reasoning, last5_avg, last10_avg, season_avg,
     matchup_grade, home_away)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction((rows: ScoredPick[]) => {
    for (const p of rows) {
      stmt.run(
        date,
        p.projection.playerName,
        p.projection.team,
        p.matchup.opponent,
        p.projection.league,
        p.projection.statType,
        p.projection.line,
        p.pick,
        p.confidence,
        p.ev,
        p.reasoning,
        p.matchup.last5Avg,
        p.matchup.last10Avg,
        p.matchup.seasonAvg,
        p.matchup.matchupGrade,
        p.matchup.homeAway
      );
    }
  });

  insertAll(picks);
}
