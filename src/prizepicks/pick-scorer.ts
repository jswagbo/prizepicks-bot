/**
 * Pick Scorer
 * 
 * Scores PrizePicks projections to find the best value plays.
 * Combines matchup analysis with trend detection and home/away splits.
 * Integrates injury reports and expert consensus for additional edge.
 */

import { type MatchupAnalysis } from './matchup-analyzer';
import { type PrizePicksProjection } from './prizepicks-client';
import { getDatabase } from '../core/db/database';
import { type InjuryReport, type TeamInjuryImpact, getInjuryReport, getTeamInjuryImpact } from './injury-news-client';
import { type ConsensusData, getConsensusForPick } from './expert-picks-client';
import { getSharpsReport, type SharpsReport } from './sharps-intel';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScoredPick {
  projection: PrizePicksProjection;
  matchup: MatchupAnalysis;
  pick: 'OVER' | 'UNDER';
  confidence: number; // 1-5 stars
  ev: number; // expected value edge as decimal
  totalScore: number;
  reasoning: string;
  injuryContext?: string; // e.g., "Booker OUT → +15% usage boost"
  expertConsensus?: string; // e.g., "3/4 experts agree UNDER"
  sharpSignal?: 'AGREE' | 'DISAGREE' | 'NEUTRAL';
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
 * Score a single projection using matchup data, injury reports, and expert consensus
 */
export async function scoreProjection(
  projection: PrizePicksProjection,
  matchup: MatchupAnalysis,
  injuries?: InjuryReport[]
): Promise<ScoredPick> {
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

  // ─── Injury Adjustments ──────────────────────────────────────────────────

  let injuryBonus = 0;
  let injuryContext: string | undefined;
  let playerInjuryFlag = false;

  if (injuries && injuries.length > 0) {
    // Check if the player themselves is injured/questionable
    const playerInjury = injuries.find(
      (inj) => inj.playerName.toLowerCase() === projection.playerName.toLowerCase()
    );
    
    if (playerInjury && ['Questionable', 'Doubtful', 'Day-To-Day'].includes(playerInjury.status)) {
      playerInjuryFlag = true;
      injuryContext = `⚠️ ${playerInjury.status}: ${playerInjury.description}`;
      console.log(`[Scorer] ${projection.playerName} is ${playerInjury.status}`);
    }

    // Check for teammate injuries that boost this player's usage
    try {
      const teamImpact = await getTeamInjuryImpact(projection.team, injuries);
      
      if (teamImpact.outPlayers.length > 0) {
        const usageBoostPercent = teamImpact.usageBoost.get(projection.team) || 0;
        
        if (usageBoostPercent > 0) {
          injuryBonus = usageBoostPercent; // Add usage boost to score
          
          const outPlayerNames = teamImpact.outPlayers.map((p) => p.playerName).join(', ');
          injuryContext = injuryContext 
            ? `${injuryContext} | Teammates OUT: ${outPlayerNames} → +${(usageBoostPercent * 100).toFixed(0)}% usage`
            : `Teammates OUT: ${outPlayerNames} → +${(usageBoostPercent * 100).toFixed(0)}% usage boost`;
          
          console.log(`[Scorer] ${projection.playerName}: ${injuryContext}`);
        }
      }
    } catch (err) {
      console.error(`[Scorer] Error calculating injury impact for ${projection.team}:`, err);
    }
  }

  // ─── Expert Consensus ────────────────────────────────────────────────────

  let expertBonus = 0;
  let expertConsensus: string | undefined;
  let sharpSignal: 'AGREE' | 'DISAGREE' | 'NEUTRAL' = 'NEUTRAL';

  try {
    const consensus = await getConsensusForPick(projection.playerName, projection.statType, projection.line);
    
    if (consensus && consensus.expertPicks.length >= 2) {
      const ourPickDirection = (baseEdge + matchupBonus + trendBonus + homeBonus + injuryBonus) > 0 ? 'OVER' : 'UNDER';
      const expertAgreePercent = ourPickDirection === 'OVER' ? consensus.overPercent : consensus.underPercent;
      
      // Consensus bonus: if 60%+ of experts agree with our pick
      if (expertAgreePercent >= 60) {
        expertBonus = 0.02;
        expertConsensus = `${consensus.expertPicks.length} experts: ${expertAgreePercent.toFixed(0)}% agree ${ourPickDirection}`;
      }
      
      // Sharp money bonus: if sharp money agrees, add extra edge
      if (consensus.sharpMoney && consensus.sharpMoney === ourPickDirection) {
        expertBonus += 0.03;
        sharpSignal = 'AGREE';
        expertConsensus = expertConsensus 
          ? `${expertConsensus} | Sharp money agrees ✓`
          : `Sharp money on ${ourPickDirection}`;
      } else if (consensus.sharpMoney && consensus.sharpMoney !== ourPickDirection) {
        sharpSignal = 'DISAGREE';
        expertConsensus = expertConsensus 
          ? `${expertConsensus} | ⚠️ Sharp money on ${consensus.sharpMoney} (opposite)`
          : `⚠️ Sharp money on ${consensus.sharpMoney} (opposite)`;
      }

      // Line comparison research — adjust trust based on investigation
      const lc = (consensus as any).lineComparison;
      if (lc?.research) {
        const research = lc.research;
        expertConsensus = expertConsensus
          ? `${expertConsensus} | Books: ${lc.avgBookLine} (diff ${lc.lineDiff > 0 ? '+' : ''}${lc.lineDiff})`
          : `PP ${projection.line} vs Books ${lc.avgBookLine} (diff ${lc.lineDiff > 0 ? '+' : ''}${lc.lineDiff})`;

        if (research.trustLevel === 'low') {
          // Research found reasons to distrust the discrepancy — reduce expert bonus
          expertBonus = Math.max(0, expertBonus - 0.02);
          expertConsensus += ` | ⚠️ LOW TRUST: ${research.factors[0]}`;
        } else if (research.trustLevel === 'high') {
          expertBonus += 0.01;
        }
      }
      
      console.log(`[Scorer] ${projection.playerName}: Expert consensus = ${expertConsensus || 'neutral'}`);
    }
  } catch (err) {
    console.error(`[Scorer] Error fetching expert consensus for ${projection.playerName}:`, err);
  }

  // ─── Sharps Intel ──────────────────────────────────────────────────────────

  let sharpBonus = 0;
  let sharpsContext: string | undefined;

  try {
    const sharpsReport = await getSharpsReport(projection.playerName, projection.statType, projection.line);

    if (sharpsReport.signals.length > 0) {
      // sharpScore ranges -1 to 1; multiply by 0.04 for up to ±4% edge
      sharpBonus = sharpsReport.sharpScore * 0.04;

      const signalSummaries = sharpsReport.signals.map(s =>
        `${s.source}: ${s.direction} (${(s.confidence * 100).toFixed(0)}%)`
      );
      sharpsContext = `Sharps [${sharpsReport.overallDirection}]: ${signalSummaries.join(', ')}`;

      // Update sharp signal based on sharps report vs our preliminary direction
      const prelimDirection = (baseEdge + matchupBonus + trendBonus + homeBonus + injuryBonus + expertBonus) > 0 ? 'OVER' : 'UNDER';
      if (sharpsReport.overallDirection === prelimDirection) {
        sharpSignal = 'AGREE';
      } else if (sharpsReport.overallDirection !== 'NEUTRAL') {
        sharpSignal = 'DISAGREE';
      }

      console.log(`[Scorer] ${projection.playerName}: ${sharpsContext}`);
    }
  } catch (err) {
    console.error(`[Scorer] Error fetching sharps report for ${projection.playerName}:`, err);
  }

  // ─── Final Score ─────────────────────────────────────────────────────────

  const rawScore = baseEdge + matchupBonus + trendBonus + homeBonus + injuryBonus + expertBonus + sharpBonus;
  
  // Apply blowout penalty only to OVERs (rawScore > 0)
  let totalScore = rawScore;
  if (rawScore > 0) {
    totalScore = rawScore - blowoutPenalty;
  }
  
  // If player is injured/questionable, reduce confidence (don't penalize score, just flag it)
  const pick: 'OVER' | 'UNDER' = totalScore > 0 ? 'OVER' : 'UNDER';
  let confidence = scoreToConfidence(Math.abs(totalScore));
  
  if (playerInjuryFlag) {
    confidence = Math.max(1, confidence - 1); // Reduce confidence by 1 star for injured players
  }

  // ─── Build Reasoning ─────────────────────────────────────────────────────

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
  
  if (injuryContext) {
    reasons.push(injuryContext);
  }
  
  if (expertConsensus) {
    reasons.push(expertConsensus);
  }

  if (sharpsContext) {
    reasons.push(sharpsContext);
  }

  return {
    projection,
    matchup,
    pick,
    confidence,
    ev: Math.round(Math.abs(totalScore) * 10000) / 10000,
    totalScore: Math.round(totalScore * 10000) / 10000,
    reasoning: reasons.join('. ') || 'Marginal edge detected',
    injuryContext,
    expertConsensus,
    sharpSignal,
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
