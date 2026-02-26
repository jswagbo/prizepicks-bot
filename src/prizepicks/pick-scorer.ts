/**
 * Pick Scorer
 *
 * Scores PrizePicks projections using Pinnacle-line-driven edge detection.
 *
 * PRIMARY EDGE = Pinnacle divergence (0.8) + Game environment (0.2)
 *
 * Trailing averages (L3/L5/L10) are kept as CONTEXT only — they are NOT
 * factored into the score. PrizePicks already uses those to set their line.
 */

import { type MatchupAnalysis } from './matchup-analyzer';
import { type PrizePicksProjection } from './prizepicks-client';
import { getDatabase } from '../core/db/database';
import {
  type InjuryReport,
  getTeamInjuryImpact,
} from './injury-news-client';
import { type ConsensusData, getConsensusForPick } from './expert-picks-client';
import { getSharpsReport, type SharpsReport } from './sharps-intel';
import { fetchGameSpreads, fetchGameTotals } from './odds-service';
import { getMarketEdge, describeMarketEdge, type MarketEdge } from './market-edge';
import { getSharpProjection, describeSharpProjection } from './sharp-projections';
import { estimateMinutes } from './minutes-model';
import { getPositionalDefenseGrade, defenseGradeToAdjustment } from './positional-defense';
import { paceAdjust, fetchTeamPace } from './matchup-analyzer';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScoredPick {
  projection: PrizePicksProjection;
  matchup: MatchupAnalysis;
  pick: 'OVER' | 'UNDER';
  confidence: number; // 1-5 stars
  ev: number; // expected value edge as decimal
  totalScore: number;
  reasoning: string;
  injuryContext?: string;
  playerInjured?: boolean;
  playerInjuryStatus?: string;
  expertConsensus?: string;
  sharpSignal?: 'AGREE' | 'DISAGREE' | 'NEUTRAL';
  /** Whether this pick was flagged as a promo/flash sale line */
  isPromoLine?: boolean;
  // ─── New Pinnacle-model fields ────────────────────────────────────────────
  /** PrizePicks line for this projection */
  ppLine: number;
  /** Pinnacle line (sharpest sportsbook) */
  pinnacleLine: number | null;
  /** Consensus line (= Pinnacle, single source) */
  consensusLine: number | null;
  /** (pinnacle_line - pp_line) / pp_line */
  pinnacleEdge: number;
  /** (consensus_line - pp_line) / pp_line */
  consensusEdge: number;
  /** Vegas game over/under total */
  vegasTotal: number | null;
  /** Projected line from Dimers sharp models */
  sharpProjection: number | null;
}

export interface ParlayPick {
  picks: ScoredPick[];
  combinedConfidence: number;
  correlationNote: string;
}

// ─── Score Constants ──────────────────────────────────────────────────────────

/**
 * Blowout penalty for OVER picks.
 * Starters get benched in blowouts, killing counting stats.
 */
const BLOWOUT_SPREAD_THRESHOLD = 8;
const BLOWOUT_PENALTY_PER_POINT = 0.008;
const BLOWOUT_MAX_PENALTY = 0.08;

/**
 * Vegas total thresholds for game environment adjustment.
 */
const HIGH_TOTAL_THRESHOLD = 228;
const LOW_TOTAL_THRESHOLD = 215;
const GAME_ENV_BASE_ADJ = 0.02;

/**
 * Team total thresholds (single-team expected scoring).
 * More precise than game total / 2 because pace asymmetry between teams
 * means a fast team can have a 120 total even in a 225-point projected game.
 *
 * Team totals are more predictive than game totals because they're specific
 * to the player's team and account for matchup-specific pace/defensive factors.
 */
const TEAM_HIGH_TOTAL_THRESHOLD = 115;
const TEAM_LOW_TOTAL_THRESHOLD = 105;
const TEAM_ENV_BASE_ADJ = 0.03; // Team totals get 3% boost vs 2% for game totals

// ─── Confidence Mapping ───────────────────────────────────────────────────────

function scoreToConfidence(absScore: number): number {
  if (absScore >= 0.12) return 5;
  if (absScore >= 0.08) return 4;
  if (absScore >= 0.05) return 3;
  if (absScore >= 0.02) return 2;
  return 1;
}

// ─── Game Total Lookup ────────────────────────────────────────────────────────

/**
 * Find the Vegas over/under total for a game given the two team names.
 * Searches by matching team names in the totals map keys.
 */
function findVegasTotal(
  totals: Map<string, number>,
  team: string,
  opponent: string
): number | null {
  if (totals.size === 0) return null;

  const teamLc = team.toLowerCase();
  const oppLc = opponent.toLowerCase();

  for (const [gameKey, total] of totals) {
    const keyLc = gameKey.toLowerCase();
    // Match if both teams appear in the game key
    if (
      (keyLc.includes(teamLc) || teamLc.includes(keyLc.split(' vs ')[0]?.trim() ?? '')) &&
      (keyLc.includes(oppLc) || oppLc.includes(keyLc.split(' vs ')[1]?.trim() ?? ''))
    ) {
      return total;
    }
    // Also check the reverse order
    const parts = gameKey.split(' vs ');
    if (parts.length === 2) {
      const [home, away] = parts.map((p) => p.toLowerCase().trim());
      if (
        (home.includes(teamLc) || teamLc.includes(home)) &&
        (away.includes(oppLc) || oppLc.includes(away))
      )
        return total;
      if (
        (away.includes(teamLc) || teamLc.includes(away)) &&
        (home.includes(oppLc) || oppLc.includes(home))
      )
        return total;
    }
  }

  return null;
}

// ─── Scoring Stats Classification ────────────────────────────────────────────

/**
 * Whether a stat type is a "scoring" stat — affects how we apply the
 * Vegas-total game environment bonus.
 * All stats benefit from high-pace/high-scoring environments to some degree.
 */
function isScoringRelatedStat(statType: string): boolean {
  const lower = statType.toLowerCase();
  return (
    lower.includes('point') ||
    lower.includes('pts') ||
    lower.includes('assist') ||
    lower.includes('ast') ||
    lower.includes('rebound') ||
    lower.includes('reb') ||
    lower.includes('fantasy') ||
    lower.includes('pra') ||
    lower.includes('+')
  );
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Score a single projection using Pinnacle-driven edge detection.
 *
 * PRIMARY EDGE:
 *   pinnacle_divergence (×0.8) + game_env_adj (×0.2)
 *
 * ADJUSTMENTS (additive):
 *   + expert consensus bonus
 *   + sharp signal bonus
 *   + injury usage redistribution
 *   − blowout penalty
 *   − back-to-back penalty
 */
export async function scoreProjection(
  projection: PrizePicksProjection,
  matchup: MatchupAnalysis,
  injuries?: InjuryReport[]
): Promise<ScoredPick> {
  // ─── Fetch spreads, totals, and market edge in parallel ───────────────────
  const defaultMarketEdge: MarketEdge = {
    playerName: projection.playerName,
    statType: projection.statType,
    ppLine: projection.line,
    pinnacleLine: null,
    consensusLine: null,
    pinnacleEdge: 0,
    consensusEdge: 0,
    teamTotal: null,
  };

  const [spreads, totals, marketEdge] = await Promise.all([
    fetchGameSpreads().catch((): Map<string, number> => new Map()),
    fetchGameTotals().catch((): Map<string, number> => new Map()),
    getMarketEdge(
      projection.playerName,
      projection.statType,
      projection.line,
      projection.team
    ).catch((): MarketEdge => defaultMarketEdge),
  ]);

  // Auto-fill game spread if not already set in matchup
  if (matchup.gameSpread === null || matchup.gameSpread === undefined) {
    for (const [gameKey, spread] of spreads) {
      if (
        gameKey.toLowerCase().includes(projection.team.toLowerCase()) ||
        gameKey.toLowerCase().includes(matchup.opponent.toLowerCase())
      ) {
        matchup.gameSpread = spread;
        break;
      }
    }
  }

  // ─── Pace-adjusted projections ──────────────────────────────────────────────
  let paceAdjustedAverages: {
    last5Avg: number;
    last10Avg: number;
    seasonAvg: number;
    ewma: number;
  } | null = null;

  try {
    // Get current pace data
    const { pace: paceData, leagueAvg: leagueAvgPace } = await fetchTeamPace();

    const playerTeamPace = paceData[projection.team] ?? leagueAvgPace;
    const opponentPace = paceData[matchup.opponent] ?? leagueAvgPace;

    // Apply pace adjustments to create smarter projections
    if (Math.abs(playerTeamPace - leagueAvgPace) > 1 || Math.abs(opponentPace - leagueAvgPace) > 1) {
      paceAdjustedAverages = {
        last5Avg: paceAdjust(matchup.last5Avg, playerTeamPace, opponentPace, leagueAvgPace),
        last10Avg: paceAdjust(matchup.last10Avg, playerTeamPace, opponentPace, leagueAvgPace),
        seasonAvg: paceAdjust(matchup.seasonAvg, playerTeamPace, opponentPace, leagueAvgPace),
        ewma: paceAdjust(matchup.ewma, playerTeamPace, opponentPace, leagueAvgPace),
      };

      console.log(
        `[Scorer] ${projection.playerName}: Pace-adjusted averages ` +
        `(${playerTeamPace.toFixed(1)}/${opponentPace.toFixed(1)} vs ${leagueAvgPace.toFixed(1)} league avg)`
      );
    }
  } catch (err) {
    console.error(`[Scorer] Error applying pace adjustments for ${projection.playerName}:`, err);
    // Continue without pace adjustments
  }

  // ─── Vegas total & game environment adjustment ────────────────────────────
  const vegasTotal = findVegasTotal(totals, projection.team, matchup.opponent);
  let gameEnvAdj = 0;

  if (isScoringRelatedStat(projection.statType)) {
    // Team totals are 2x more predictive than game totals because they're specific
    // to the player's team and account for matchup-specific pace/defensive factors
    if (marketEdge.teamTotal !== null) {
      if (marketEdge.teamTotal > TEAM_HIGH_TOTAL_THRESHOLD) {
        gameEnvAdj = TEAM_ENV_BASE_ADJ * 2; // High team scoring → +6% OVER boost (2x weight)
      } else if (marketEdge.teamTotal < TEAM_LOW_TOTAL_THRESHOLD) {
        gameEnvAdj = -TEAM_ENV_BASE_ADJ * 2; // Low team scoring → -6% UNDER boost (2x weight)
      }
    } else if (vegasTotal !== null) {
      // Fallback: use combined game total when team total is unavailable
      if (vegasTotal > HIGH_TOTAL_THRESHOLD) {
        gameEnvAdj = GAME_ENV_BASE_ADJ; // High-scoring game → OVER boost
      } else if (vegasTotal < LOW_TOTAL_THRESHOLD) {
        gameEnvAdj = -GAME_ENV_BASE_ADJ; // Low-scoring game → UNDER boost
      }
    }
  }

  // Also incorporate team pace factor (from matchup) as additional env signal
  // Pace is a known input, so we add a conservative portion (25%)
  if (matchup.paceAdjustment !== 0) {
    gameEnvAdj += matchup.paceAdjustment * 0.25;
  }

  // ─── PRIMARY EDGE ─────────────────────────────────────────────────────────
  const primaryEdge =
    marketEdge.pinnacleEdge * 0.8 +
    gameEnvAdj * 0.2;

  // ─── Blowout penalty ──────────────────────────────────────────────────────
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

  // ─── Back-to-back penalty ─────────────────────────────────────────────────
  let backToBackPenalty = 0;
  if (matchup.isBackToBack) {
    backToBackPenalty = 0.05;
    console.log(`[Scorer] ${projection.playerName}: Back-to-back → -5% OVER penalty`);
  }

  // ─── Injury adjustments ───────────────────────────────────────────────────
  let injuryBonus = 0;
  let injuryContext: string | undefined;
  let playerInjuryFlag = false;

  if (injuries && injuries.length > 0) {
    const playerInjury = injuries.find(
      (inj) => inj.playerName.toLowerCase() === projection.playerName.toLowerCase()
    );

    if (playerInjury && ['Questionable', 'Doubtful', 'Day-To-Day'].includes(playerInjury.status)) {
      playerInjuryFlag = true;
      injuryContext = `⚠️ ${playerInjury.status}: ${playerInjury.description}`;

      if (playerInjury.status === 'Doubtful') {
        injuryBonus = -0.15;
      } else if (playerInjury.status === 'Questionable') {
        injuryBonus = -0.10;
      } else if (playerInjury.status === 'Day-To-Day') {
        injuryBonus = -0.06;
      }

      console.log(
        `[Scorer] ${projection.playerName} is ${playerInjury.status} (${(injuryBonus * 100).toFixed(0)}% penalty)`
      );
    }

    // Teammate injuries → usage boost
    if (!playerInjuryFlag) {
      try {
        const teamImpact = await getTeamInjuryImpact(projection.team, injuries);

        if (teamImpact.outPlayers.length > 0) {
          const usageBoostPercent = teamImpact.usageBoost.get(projection.team) || 0;

          if (usageBoostPercent > 0) {
            injuryBonus = usageBoostPercent;

            const outPlayerNames = teamImpact.outPlayers.map((p) => p.playerName).join(', ');
            injuryContext = injuryContext
              ? `${injuryContext} | Teammates OUT: ${outPlayerNames} → +${(usageBoostPercent * 100).toFixed(0)}% usage`
              : `Teammates OUT: ${outPlayerNames} → +${(usageBoostPercent * 100).toFixed(0)}% usage boost`;

            console.log(`[Scorer] ${projection.playerName}: ${injuryContext}`);
          }
        }
      } catch (err) {
        console.error(
          `[Scorer] Error calculating injury impact for ${projection.team}:`,
          err
        );
      }
    }
  }

  // ─── Expert consensus ─────────────────────────────────────────────────────
  let expertBonus = 0;
  let expertConsensus: string | undefined;
  let sharpSignal: 'AGREE' | 'DISAGREE' | 'NEUTRAL' = 'NEUTRAL';

  try {
    const consensus = await getConsensusForPick(
      projection.playerName,
      projection.statType,
      projection.line
    );

    if (consensus && consensus.expertPicks.length >= 2) {
      // Preliminary pick direction from primary edge + injury
      const prelimDirection =
        primaryEdge + injuryBonus > 0 ? 'OVER' : 'UNDER';

      const expertAgreePercent =
        prelimDirection === 'OVER' ? consensus.overPercent : consensus.underPercent;

      if (expertAgreePercent >= 60) {
        expertBonus = 0.06;
        expertConsensus = `${consensus.expertPicks.length} experts: ${expertAgreePercent.toFixed(0)}% agree ${prelimDirection}`;
      }

      if (consensus.sharpMoney && consensus.sharpMoney === prelimDirection) {
        expertBonus += 0.08;
        sharpSignal = 'AGREE';
        expertConsensus = expertConsensus
          ? `${expertConsensus} | Sharp money agrees ✓`
          : `Sharp money on ${prelimDirection}`;
      } else if (consensus.sharpMoney && consensus.sharpMoney !== prelimDirection) {
        sharpSignal = 'DISAGREE';
        expertConsensus = expertConsensus
          ? `${expertConsensus} | ⚠️ Sharp money on ${consensus.sharpMoney} (opposite)`
          : `⚠️ Sharp money on ${consensus.sharpMoney} (opposite)`;
      }

      // Line comparison research
      const lc = (consensus as ConsensusData & { lineComparison?: { avgBookLine: number; lineDiff: number; research?: { trustLevel: string; factors: string[] } } }).lineComparison;
      if (lc?.research) {
        const research = lc.research;
        expertConsensus = expertConsensus
          ? `${expertConsensus} | Books: ${lc.avgBookLine} (diff ${lc.lineDiff > 0 ? '+' : ''}${lc.lineDiff})`
          : `PP ${projection.line} vs Books ${lc.avgBookLine} (diff ${lc.lineDiff > 0 ? '+' : ''}${lc.lineDiff})`;

        if (research.trustLevel === 'low') {
          expertBonus = Math.max(0, expertBonus - 0.04);
          expertConsensus += ` | ⚠️ LOW TRUST: ${research.factors[0]}`;
        } else if (research.trustLevel === 'high') {
          expertBonus += 0.03;
        }
      }

      console.log(
        `[Scorer] ${projection.playerName}: Expert consensus = ${expertConsensus || 'neutral'}`
      );
    }
  } catch (err) {
    console.error(
      `[Scorer] Error fetching expert consensus for ${projection.playerName}:`,
      err
    );
  }

  // ─── Sharps intel ──────────────────────────────────────────────────────────
  let sharpBonus = 0;
  let sharpsContext: string | undefined;

  try {
    const sharpsReport: SharpsReport = await getSharpsReport(
      projection.playerName,
      projection.statType,
      projection.line
    );

    if (sharpsReport.signals.length > 0) {
      sharpBonus = sharpsReport.sharpScore * 0.10;

      const signalSummaries = sharpsReport.signals.map(
        (s) => `${s.source}: ${s.direction} (${(s.confidence * 100).toFixed(0)}%)`
      );
      sharpsContext = `Sharps [${sharpsReport.overallDirection}]: ${signalSummaries.join(', ')}`;

      const prelimDirection2 =
        primaryEdge + injuryBonus + expertBonus > 0 ? 'OVER' : 'UNDER';

      if (sharpsReport.overallDirection === prelimDirection2) {
        sharpSignal = 'AGREE';
      } else if (sharpsReport.overallDirection !== 'NEUTRAL') {
        sharpSignal = 'DISAGREE';
      }

      console.log(`[Scorer] ${projection.playerName}: ${sharpsContext}`);
    }
  } catch (err) {
    console.error(
      `[Scorer] Error fetching sharps report for ${projection.playerName}:`,
      err
    );
  }

  // ─── Sharp model projection (Dimers) ─────────────────────────────────────
  let sharpProjection: number | null = null;
  try {
    sharpProjection = await getSharpProjection(
      projection.playerName,
      projection.statType
    );
  } catch {
    // non-fatal
  }

  // ─── Minutes-adjusted sharp projection ──────────────────────────────────────
  let minutesAdjustedSharpProjection: number | null = sharpProjection;
  let minutesAdjustmentNote: string | undefined;

  if (sharpProjection !== null && matchup.expectedMinutes !== null && matchup.seasonAvgMinutes !== null && matchup.seasonAvgMinutes > 0) {
    // Estimate expected minutes for this game
    const gameSpreadForPlayer = matchup.gameSpread !== null
      ? (projection.team === matchup.opponent ? -matchup.gameSpread : matchup.gameSpread)  // Flip spread perspective if needed
      : matchup.gameSpread;

    const estimatedMinutes = estimateMinutes(
      matchup.seasonAvgMinutes,
      gameSpreadForPlayer,
      matchup.isBackToBack,
      matchup.homeAway === 'home'
    );

    // Scale the sharp projection based on minutes
    const minutesRatio = estimatedMinutes / matchup.seasonAvgMinutes;
    minutesAdjustedSharpProjection = sharpProjection * minutesRatio;

    // Only note significant adjustments (>5% change)
    if (Math.abs(minutesRatio - 1) > 0.05) {
      const changePercent = ((minutesRatio - 1) * 100).toFixed(1);
      minutesAdjustmentNote = `Minutes-adjusted projection: ${sharpProjection} → ${minutesAdjustedSharpProjection.toFixed(1)} (${changePercent}% for ${estimatedMinutes.toFixed(1)} vs ${matchup.seasonAvgMinutes.toFixed(1)} avg mins)`;
      console.log(`[Scorer] ${projection.playerName}: ${minutesAdjustmentNote}`);
    }
  }

  // ─── Historical hit rate ───────────────────────────────────────────────────
  let hitRateAdjustment = 0;
  const prelimScoreForBucket =
    primaryEdge + injuryBonus + expertBonus + sharpBonus;
  const edgeBucket = edgeToBucket(prelimScoreForBucket);
  const historicalHitRate = getHistoricalHitRate(projection.statType, edgeBucket);

  if (historicalHitRate !== null) {
    const targetHitRate = 0.5238;
    const hitRateDiff = historicalHitRate - targetHitRate;

    if (hitRateDiff < -0.05) {
      hitRateAdjustment = hitRateDiff * 0.5;
      console.log(
        `[Scorer] ${projection.playerName} ${projection.statType}: Historical hit rate ` +
          `${(historicalHitRate * 100).toFixed(1)}% (${edgeBucket}) → ${(hitRateAdjustment * 100).toFixed(1)}% penalty`
      );
    }
  }

  // ─── Positional defense adjustment ──────────────────────────────────────────
  let positionalDefenseAdj = 0;
  let positionalDefenseNote: string | undefined;

  try {
    const defenseGrade = await getPositionalDefenseGrade(
      matchup.opponent,
      projection.position || 'SF', // Default to SF if position not available
      projection.statType
    );

    positionalDefenseAdj = defenseGradeToAdjustment(defenseGrade);

    if (positionalDefenseAdj !== 0) {
      const direction = positionalDefenseAdj > 0 ? 'OVER' : 'UNDER';
      const absPercent = Math.abs(positionalDefenseAdj * 100).toFixed(1);
      positionalDefenseNote = `${matchup.opponent} vs ${projection.position || 'SF'} ${projection.statType}: Grade ${defenseGrade} → ${direction} boosted ${absPercent}%`;

      console.log(`[Scorer] ${projection.playerName}: ${positionalDefenseNote}`);
    }
  } catch (err) {
    console.error(
      `[Scorer] Error getting positional defense for ${projection.playerName}:`,
      err
    );
  }

  // ─── Final score ──────────────────────────────────────────────────────────
  let rawScore =
    primaryEdge + injuryBonus + expertBonus + sharpBonus + hitRateAdjustment + positionalDefenseAdj;

  // Back-to-back penalty applies to OVER picks
  if (backToBackPenalty > 0 && rawScore > 0) {
    rawScore -= backToBackPenalty;
  }

  // Blowout: penalize OVERs, boost UNDERs
  let totalScore = rawScore;
  if (blowoutPenalty > 0) {
    if (rawScore > 0) {
      totalScore = rawScore - blowoutPenalty;
    } else {
      totalScore = rawScore - blowoutPenalty * 0.6;
    }
  }

  const pick: 'OVER' | 'UNDER' = totalScore > 0 ? 'OVER' : 'UNDER';
  let confidence = scoreToConfidence(Math.abs(totalScore));

  // ─── Promo line penalty ──────────────────────────────────────────────────────
  let isPromoLine = false;
  let promoReason = '';

  // Check for explicit promo flag from API
  if (projection.isPromo) {
    isPromoLine = true;
    promoReason = 'API promo flag';
  }

  // Heuristic: check if line is significantly different from season average
  if (!isPromoLine && matchup.seasonAvg > 0) {
    const lineDiffFromAvg = Math.abs(projection.line - matchup.seasonAvg) / matchup.seasonAvg;

    // If line is >30% different from season average, flag as potential promo
    if (lineDiffFromAvg > 0.30) {
      isPromoLine = true;
      promoReason = `line ${projection.line} vs season avg ${matchup.seasonAvg.toFixed(1)} (${(lineDiffFromAvg * 100).toFixed(0)}% diff)`;
    }
  }

  if (isPromoLine) {
    confidence = Math.max(1, confidence - 1); // Reduce confidence by 1 star
    console.log(
      `[Scorer] ${projection.playerName}: Promo line detected (${promoReason}) → confidence reduced by 1 star ` +
      `(${confidence + 1} → ${confidence})`
    );
  }

  if (playerInjuryFlag) {
    const injStatus = injuries?.find(
      (inj) => inj.playerName.toLowerCase() === projection.playerName.toLowerCase()
    )?.status;
    const starPenalty =
      injStatus === 'Doubtful' || injStatus === 'Questionable' ? 2 : 1;
    confidence = Math.max(1, confidence - starPenalty);
  }

  // ─── Build reasoning ──────────────────────────────────────────────────────
  const reasons: string[] = [];

  // Promo line warning (show first if applicable)
  if (isPromoLine) {
    const flashSaleInfo = projection.flashSaleLine !== null
      ? ` (flash sale from ${projection.flashSaleLine})`
      : '';
    reasons.push(`⚡ PROMO LINE — inflated edge, proceed with caution (${promoReason})${flashSaleInfo}`);
  }

  // Primary edge: Pinnacle and consensus
  const edgeDescriptions = describeMarketEdge(marketEdge);
  reasons.push(...edgeDescriptions);

  // If no book data available, note it
  if (marketEdge.pinnacleLine === null) {
    reasons.push('No Pinnacle line available — edge from sharp signals only');
  }

  // Game environment — team total takes priority with 2x weight when available
  if (marketEdge.teamTotal !== null) {
    if (marketEdge.teamTotal > TEAM_HIGH_TOTAL_THRESHOLD) {
      reasons.push(
        `Team total: ${marketEdge.teamTotal} (high) → scoring OVER boosted +6% (2x weight)`
      );
    } else if (marketEdge.teamTotal < TEAM_LOW_TOTAL_THRESHOLD) {
      reasons.push(
        `Team total: ${marketEdge.teamTotal} (low) → scoring UNDER boosted -6% (2x weight)`
      );
    } else {
      reasons.push(`Team total: ${marketEdge.teamTotal} (neutral)`);
    }
    if (vegasTotal !== null) {
      reasons.push(`Vegas game total: ${vegasTotal}`);
    }
  } else if (vegasTotal !== null) {
    if (vegasTotal > HIGH_TOTAL_THRESHOLD) {
      reasons.push(
        `Vegas total ${vegasTotal} (high) → scoring OVER boosted +2%`
      );
    } else if (vegasTotal < LOW_TOTAL_THRESHOLD) {
      reasons.push(
        `Vegas total ${vegasTotal} (low) → scoring UNDER boosted -2%`
      );
    } else {
      reasons.push(`Vegas total ${vegasTotal} (neutral)`);
    }
  }

  // Pace adjustment note (context only, no longer primary signal)
  if (Math.abs(matchup.paceAdjustment) > 0.01) {
    const paceDir = matchup.paceAdjustment > 0 ? 'Fast' : 'Slow';
    reasons.push(
      `${paceDir} pace game (${(matchup.paceAdjustment * 100).toFixed(1)}%)`
    );
  }

  // Pace-adjusted averages (if applied)
  if (paceAdjustedAverages) {
    const avgChange = ((paceAdjustedAverages.seasonAvg / matchup.seasonAvg) - 1) * 100;
    if (Math.abs(avgChange) > 3) {
      reasons.push(
        `Pace-adjusted season avg: ${matchup.seasonAvg} → ${paceAdjustedAverages.seasonAvg.toFixed(1)} ` +
        `(${avgChange > 0 ? '+' : ''}${avgChange.toFixed(1)}% for game pace)`
      );
    }
  }

  // Back-to-back
  if (backToBackPenalty > 0) {
    reasons.push('⚠️ Back-to-back game → -5% OVER penalty');
  }

  // Blowout
  if (blowoutPenalty > 0) {
    const absSpread = Math.abs(matchup.gameSpread!);
    if (rawScore > 0) {
      reasons.push(
        `⚠️ Blowout risk: ${absSpread}pt spread → OVER penalized (-${(blowoutPenalty * 100).toFixed(1)}%)`
      );
    } else {
      reasons.push(
        `✅ Blowout boost: ${absSpread}pt spread → UNDER strengthened (+${(blowoutPenalty * 0.6 * 100).toFixed(1)}%)`
      );
    }
  }

  // Historical hit rate
  if (historicalHitRate !== null) {
    reasons.push(
      `Historical hit rate (${edgeBucket}): ${(historicalHitRate * 100).toFixed(1)}%`
    );
  }

  // Sharp model projection (with minutes adjustment)
  if (minutesAdjustedSharpProjection !== null) {
    const note = describeSharpProjection(
      projection.playerName,
      projection.statType,
      minutesAdjustedSharpProjection,
      projection.line,
      pick
    );
    reasons.push(note);
  }

  // Minutes adjustment note
  if (minutesAdjustmentNote) {
    reasons.push(minutesAdjustmentNote);
  }

  // Positional defense
  if (positionalDefenseNote) {
    reasons.push(positionalDefenseNote);
  }

  // Injury
  if (injuryContext) reasons.push(injuryContext);

  // Expert consensus
  if (expertConsensus) reasons.push(expertConsensus);

  // Sharps
  if (sharpsContext) reasons.push(sharpsContext);

  return {
    projection,
    matchup,
    pick,
    confidence,
    ev: Math.round(Math.abs(totalScore) * 10000) / 10000,
    totalScore: Math.round(totalScore * 10000) / 10000,
    reasoning: reasons.join('. ') || 'Marginal market edge detected',
    injuryContext,
    playerInjured: playerInjuryFlag,
    playerInjuryStatus: playerInjuryFlag
      ? injuries?.find(
          (inj) => inj.playerName.toLowerCase() === projection.playerName.toLowerCase()
        )?.status
      : undefined,
    expertConsensus,
    sharpSignal,
    isPromoLine,
    // New Pinnacle-model fields
    ppLine: projection.line,
    pinnacleLine: marketEdge.pinnacleLine,
    consensusLine: marketEdge.consensusLine,
    pinnacleEdge: marketEdge.pinnacleEdge,
    consensusEdge: marketEdge.consensusEdge,
    vegasTotal,
    sharpProjection: minutesAdjustedSharpProjection,
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
 * Excludes promo lines as they have inflated edges.
 */
export function buildParlay(topPicks: ScoredPick[]): ParlayPick {
  // Filter out promo lines first
  const nonPromopicks = topPicks.filter(pick => !pick.isPromoLine);

  if (nonPromopicks.length < topPicks.length) {
    const promoCount = topPicks.length - nonPromopicks.length;
    console.log(`[Parlay] Excluded ${promoCount} promo line(s) from parlay consideration`);
  }

  const ranked = rankProjections(nonPromopicks);
  const selected: ScoredPick[] = [];
  const usedGames = new Set<string>();

  for (const pick of ranked) {
    if (selected.length >= 4) break;
    const gameKey = [pick.projection.team, pick.matchup.opponent].sort().join('-');
    if (usedGames.has(gameKey)) continue;
    selected.push(pick);
    usedGames.add(gameKey);
  }

  const combinedConfidence =
    selected.length > 0
      ? Math.round(selected.reduce((s, p) => s + p.confidence, 0) / selected.length)
      : 0;

  const correlationNote =
    selected.length < 4
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

// ─── Historical Hit Rate Tracking ─────────────────────────────────────────────

function edgeToBucket(edge: number): string {
  const absEdge = Math.abs(edge);
  if (absEdge >= 0.15) return 'very_high';
  if (absEdge >= 0.10) return 'high';
  if (absEdge >= 0.05) return 'medium';
  return 'low';
}

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
  const edgeBucketVal = edgeToBucket(edge);

  db.prepare(`
    INSERT INTO pick_results 
    (date, player_name, stat_type, pick_direction, edge_bucket, hit, line, actual_result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(date, playerName, statType, pickDirection, edgeBucketVal, hit ? 1 : 0, line, actualResult);

  console.log(
    `[Hit Rate] Recorded ${playerName} ${statType} ${pickDirection}: ` +
      `${actualResult} vs ${line} = ${hit ? 'HIT' : 'MISS'} (edge bucket: ${edgeBucketVal})`
  );
}

export function getHistoricalHitRate(
  statType: string,
  edgeBucket: string
): number | null {
  const db = getDatabase();

  const result = db
    .prepare(
      `
    SELECT COUNT(*) as total, SUM(hit) as hits
    FROM pick_results
    WHERE stat_type = ? AND edge_bucket = ?
  `
    )
    .get(statType, edgeBucket) as { total: number; hits: number } | undefined;

  if (!result || result.total < 10) return null;

  const hitRate = result.hits / result.total;
  console.log(
    `[Hit Rate] ${statType} ${edgeBucket}: ${result.hits}/${result.total} = ${(hitRate * 100).toFixed(1)}%`
  );

  return hitRate;
}
