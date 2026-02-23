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
import { fetchGameSpreads } from './odds-service';

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
  playerInjured?: boolean; // true if this player has an injury designation
  playerInjuryStatus?: string; // e.g., "Day-To-Day", "Questionable", "Doubtful"
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
  // Auto-fetch game spread if not provided in matchup
  if (matchup.gameSpread === null || matchup.gameSpread === undefined) {
    try {
      const spreads = await fetchGameSpreads();
      // Try to match by team name in spread keys
      for (const [gameKey, spread] of spreads) {
        if (gameKey.toLowerCase().includes(projection.team.toLowerCase()) ||
            gameKey.toLowerCase().includes(matchup.opponent.toLowerCase())) {
          matchup.gameSpread = spread;
          break;
        }
      }
    } catch {
      // Non-fatal — proceed without spread data
    }
  }

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

  // ─── Pace Adjustment ─────────────────────────────────────────────────────

  let paceBonus = 0;
  if (matchup.paceAdjustment !== 0) {
    // Positive pace adjustment → boost OVERs, negative → boost UNDERs
    // Apply 50% of the pace differential (conservative weighting)
    paceBonus = matchup.paceAdjustment * 0.5;
    
    console.log(
      `[Scorer] ${projection.playerName}: Pace adjustment ${(matchup.paceAdjustment * 100).toFixed(1)}% → ` +
      `${(paceBonus * 100).toFixed(1)}% bonus`
    );
  }

  // ─── Back-to-Back Penalty ────────────────────────────────────────────────

  let backToBackPenalty = 0;
  if (matchup.isBackToBack) {
    backToBackPenalty = 0.05; // -5% penalty for B2B games
    console.log(`[Scorer] ${projection.playerName}: Back-to-back detected → -5% penalty`);
  }

  // ─── Minutes Projection Boost ────────────────────────────────────────────

  let minutesBonus = 0;
  if (matchup.expectedMinutes !== null && matchup.seasonAvgMinutes !== null) {
    const minutesDiff = (matchup.expectedMinutes - matchup.seasonAvgMinutes) / matchup.seasonAvgMinutes;
    
    // If expected minutes are 20% above season avg, add proportional boost
    if (Math.abs(minutesDiff) > 0.05) {
      minutesBonus = minutesDiff * 0.3; // Apply 30% of the minutes differential as edge
      
      console.log(
        `[Scorer] ${projection.playerName}: Minutes ${matchup.expectedMinutes} vs season ${matchup.seasonAvgMinutes} → ` +
        `${(minutesBonus * 100).toFixed(1)}% bonus`
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
      
      // Apply score penalty based on injury severity — injured players are unreliable
      // OVER picks especially risky (limited minutes, rust, could re-aggravate)
      if (playerInjury.status === 'Doubtful') {
        injuryBonus = -0.15; // Heavy penalty — might not even play
      } else if (playerInjury.status === 'Questionable') {
        injuryBonus = -0.10; // Significant penalty — likely limited if playing
      } else if (playerInjury.status === 'Day-To-Day') {
        injuryBonus = -0.06; // Moderate penalty — could be on minutes restriction
      }
      
      console.log(`[Scorer] ${projection.playerName} is ${playerInjury.status} (${(injuryBonus * 100).toFixed(0)}% penalty)`);
    }
    
    // Check if player recently returned from injury (recent minutes way below season avg = rust)
    if (!playerInjuryFlag && matchup.expectedMinutes !== null && matchup.seasonAvgMinutes !== null) {
      const expectedMin = matchup.expectedMinutes;
      const seasonMin = matchup.seasonAvgMinutes;
      if (seasonMin > 0 && expectedMin > 0 && expectedMin < seasonMin * 0.7) {
        // Player's recent minutes are way below season avg — likely coming back from injury
        const minutesDrop = (seasonMin - expectedMin) / seasonMin;
        injuryBonus = -(minutesDrop * 0.08); // Up to -8% penalty for severe minutes drops
        injuryContext = `⚠️ Possible injury return: recent ${expectedMin.toFixed(1)} min vs season ${seasonMin.toFixed(1)} min (${(minutesDrop * 100).toFixed(0)}% drop)`;
        console.log(`[Scorer] ${projection.playerName}: ${injuryContext}`);
      }
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
        expertBonus = 0.06;
        expertConsensus = `${consensus.expertPicks.length} experts: ${expertAgreePercent.toFixed(0)}% agree ${ourPickDirection}`;
      }
      
      // Sharp money bonus: if sharp money agrees, add extra edge
      if (consensus.sharpMoney && consensus.sharpMoney === ourPickDirection) {
        expertBonus += 0.08;
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
          expertBonus = Math.max(0, expertBonus - 0.04);
          expertConsensus += ` | ⚠️ LOW TRUST: ${research.factors[0]}`;
        } else if (research.trustLevel === 'high') {
          expertBonus += 0.03;
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
      // sharpScore ranges -1 to 1; multiply by 0.10 for up to ±10% edge
      sharpBonus = sharpsReport.sharpScore * 0.10;

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

  // ─── Historical Hit Rate Adjustment ──────────────────────────────────────

  let hitRateAdjustment = 0;
  const prelimScore = baseEdge + matchupBonus + trendBonus + homeBonus + injuryBonus + expertBonus + sharpBonus + paceBonus + minutesBonus;
  const edgeBucket = edgeToBucket(prelimScore);
  const historicalHitRate = getHistoricalHitRate(projection.statType, edgeBucket);
  
  if (historicalHitRate !== null) {
    // If historical hit rate is significantly below 50%, reduce confidence
    // Target: 52.38% for profitability at -110 odds
    const targetHitRate = 0.5238;
    const hitRateDiff = historicalHitRate - targetHitRate;
    
    if (hitRateDiff < -0.05) {
      // Historical underperformance → reduce edge
      hitRateAdjustment = hitRateDiff * 0.5; // Apply 50% of the deficit
      
      console.log(
        `[Scorer] ${projection.playerName} ${projection.statType}: Historical hit rate ${(historicalHitRate * 100).toFixed(1)}% ` +
        `(bucket: ${edgeBucket}) → ${(hitRateAdjustment * 100).toFixed(1)}% penalty`
      );
    }
  }

  // ─── Final Score ─────────────────────────────────────────────────────────

  let rawScore = baseEdge + matchupBonus + trendBonus + homeBonus + injuryBonus + expertBonus + sharpBonus + paceBonus + minutesBonus + hitRateAdjustment;
  
  // Apply back-to-back penalty to OVERs
  if (backToBackPenalty > 0 && rawScore > 0) {
    rawScore -= backToBackPenalty;
  }
  
  // Apply blowout adjustment: penalize OVERs, boost UNDERs
  let totalScore = rawScore;
  if (blowoutPenalty > 0) {
    if (rawScore > 0) {
      totalScore = rawScore - blowoutPenalty; // Penalize OVERs
    } else {
      totalScore = rawScore - (blowoutPenalty * 0.6); // Boost UNDERs (push more negative = stronger UNDER)
    }
  }
  
  // If player is injured/questionable, reduce confidence (don't penalize score, just flag it)
  const pick: 'OVER' | 'UNDER' = totalScore > 0 ? 'OVER' : 'UNDER';
  let confidence = scoreToConfidence(Math.abs(totalScore));
  
  if (playerInjuryFlag) {
    // Doubtful: -2 stars, Questionable: -2 stars, Day-To-Day: -1 star
    const injStatus = injuries?.find(
      (inj) => inj.playerName.toLowerCase() === projection.playerName.toLowerCase()
    )?.status;
    const starPenalty = (injStatus === 'Doubtful' || injStatus === 'Questionable') ? 2 : 1;
    confidence = Math.max(1, confidence - starPenalty);
  }

  // ─── Build Reasoning ─────────────────────────────────────────────────────

  const reasons: string[] = [];
  
  if (Math.abs(baseEdge) > 0.02) {
    reasons.push(
      `Model line ${matchup.estimatedLine} (EWMA ${matchup.ewma}) vs PP line ${matchup.prizePicksLine} (${(baseEdge * 100).toFixed(1)}% edge)`
    );
  }
  
  if (matchup.matchupGrade === 'A' || matchup.matchupGrade === 'B') {
    reasons.push(`Favorable matchup (${matchup.matchupGrade}) vs ${matchup.opponent}`);
  } else if (matchup.matchupGrade === 'D' || matchup.matchupGrade === 'F') {
    reasons.push(`Tough matchup (${matchup.matchupGrade}) vs ${matchup.opponent}`);
  }
  
  if (matchup.opponentDefenseRank !== null) {
    reasons.push(`Opponent defense rank: #${matchup.opponentDefenseRank} in ${projection.statType}`);
  }
  
  if (trendBonus > 0) {
    reasons.push(`Hot trend: L3 ${matchup.last3Avg} > L10 ${matchup.last10Avg} > SZN ${matchup.seasonAvg}`);
  } else if (trendBonus < 0) {
    reasons.push(`Cold trend: L3 ${matchup.last3Avg} < L10 ${matchup.last10Avg} < SZN ${matchup.seasonAvg}`);
  }
  
  if (homeBonus > 0) {
    reasons.push('Home court advantage');
  }
  
  if (paceBonus !== 0) {
    const paceDirection = paceBonus > 0 ? 'Fast' : 'Slow';
    reasons.push(`${paceDirection} pace game (${(matchup.paceAdjustment * 100).toFixed(1)}%)`);
  }
  
  if (minutesBonus !== 0 && matchup.expectedMinutes !== null) {
    reasons.push(`Expected ${matchup.expectedMinutes} min (season avg: ${matchup.seasonAvgMinutes})`);
  }
  
  if (backToBackPenalty > 0) {
    reasons.push(`⚠️ Back-to-back game → -5% OVER penalty`);
  }
  
  if (blowoutPenalty > 0) {
    const absSpread = Math.abs(matchup.gameSpread!);
    if (rawScore > 0) {
      reasons.push(`⚠️ Blowout risk: ${absSpread}pt spread → OVER penalized (-${(blowoutPenalty * 100).toFixed(1)}%)`);
    } else {
      reasons.push(`✅ Blowout boost: ${absSpread}pt spread → UNDER strengthened (+${(blowoutPenalty * 0.6 * 100).toFixed(1)}%)`);
    }
  }
  
  if (historicalHitRate !== null) {
    reasons.push(`Historical hit rate (${edgeBucket}): ${(historicalHitRate * 100).toFixed(1)}%`);
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
    playerInjured: playerInjuryFlag,
    playerInjuryStatus: playerInjuryFlag ? injuries?.find(
      (inj) => inj.playerName.toLowerCase() === projection.playerName.toLowerCase()
    )?.status : undefined,
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

// ─── Historical Hit Rate Tracking ────────────────────────────────────────────

/**
 * Convert edge to bucket for hit rate tracking.
 * Buckets: "low" (0-5%), "medium" (5-10%), "high" (10-15%), "very_high" (15%+)
 */
function edgeToBucket(edge: number): string {
  const absEdge = Math.abs(edge);
  if (absEdge >= 0.15) return 'very_high';
  if (absEdge >= 0.10) return 'high';
  if (absEdge >= 0.05) return 'medium';
  return 'low';
}

/**
 * Record the result of a pick after the game completes.
 * Call this function after scraping actual results.
 */
export function recordPickResult(
  date: string,
  playerName: string,
  statType: string,
  pickDirection: 'OVER' | 'UNDER',
  edge: number,
  line: number,
  actualResult: number,
  hit: boolean
): void {
  const db = getDatabase();
  const edgeBucket = edgeToBucket(edge);
  
  db.prepare(`
    INSERT INTO pick_results 
    (date, player_name, stat_type, pick_direction, edge_bucket, hit, line, actual_result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    date,
    playerName,
    statType,
    pickDirection,
    edgeBucket,
    hit ? 1 : 0,
    line,
    actualResult
  );
  
  console.log(
    `[Hit Rate] Recorded ${playerName} ${statType} ${pickDirection}: ` +
    `${actualResult} vs ${line} = ${hit ? 'HIT' : 'MISS'} (edge bucket: ${edgeBucket})`
  );
}

/**
 * Get historical hit rate for a stat type + edge bucket.
 * Returns null if insufficient data (<10 samples).
 */
export function getHistoricalHitRate(
  statType: string,
  edgeBucket: string
): number | null {
  const db = getDatabase();
  
  const result = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(hit) as hits
    FROM pick_results
    WHERE stat_type = ? AND edge_bucket = ?
  `).get(statType, edgeBucket) as { total: number; hits: number } | undefined;
  
  if (!result || result.total < 10) {
    return null; // Need at least 10 samples for reliable rate
  }
  
  const hitRate = result.hits / result.total;
  console.log(
    `[Hit Rate] ${statType} ${edgeBucket}: ${result.hits}/${result.total} = ${(hitRate * 100).toFixed(1)}%`
  );
  
  return hitRate;
}
