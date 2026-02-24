/**
 * Minutes Projection Model
 *
 * Estimates expected minutes for a player based on:
 * - Season average minutes (baseline)
 * - Blowout adjustment: if spread >= 8, reduce expected minutes by 10-15% for starters on the favored team
 * - Back-to-back adjustment: if team played yesterday, reduce minutes by ~5%
 * - Teammate injury boost: TODO - requires more precise modeling of teammate impacts
 */

/**
 * Estimate expected minutes for a player based on game context.
 *
 * @param seasonAvgMin - Player's season average minutes
 * @param spread - Game spread (positive = player's team favored, negative = underdog, null = no data)
 * @param isB2B - Is the player's team on a back-to-back?
 * @param isHome - Is the player playing at home? (currently unused but could affect minutes)
 * @returns Estimated minutes for this game
 */
export function estimateMinutes(
  seasonAvgMin: number,
  spread: number | null,
  isB2B: boolean,
  isHome: boolean
): number {
  if (seasonAvgMin <= 0) {
    return 0;
  }

  let estimatedMinutes = seasonAvgMin;

  // ─── Blowout adjustment ────────────────────────────────────────────────────
  // If the game has a large spread, starters on the favored team tend to play fewer minutes
  // because they get pulled in the 4th quarter when the game is decided
  if (spread !== null && Math.abs(spread) >= 8) {
    const isPlayerTeamFavored = spread > 0;
    const isStarterMinutes = seasonAvgMin >= 25; // Assume 25+ min/game = starter

    if (isPlayerTeamFavored && isStarterMinutes) {
      // Favored team starters: reduce minutes by 10-15% based on spread size
      const spreadMagnitude = Math.abs(spread);
      const reductionPct = Math.min(0.15, 0.10 + ((spreadMagnitude - 8) * 0.01)); // 10% base + 1% per point over 8
      estimatedMinutes *= (1 - reductionPct);

      console.log(
        `[MinutesModel] Blowout risk: ${spread}pt spread → ${(reductionPct * 100).toFixed(1)}% minutes reduction (${seasonAvgMin} → ${estimatedMinutes.toFixed(1)})`
      );
    }
    // Note: Underdog starters might actually play MORE minutes in a close loss, but this is harder to model
    // and less predictable, so we don't adjust for now
  }

  // ─── Back-to-back adjustment ───────────────────────────────────────────────
  // Teams on back-to-backs tend to rest starters more and play deeper rotations
  if (isB2B) {
    const isStarterMinutes = seasonAvgMin >= 25;

    if (isStarterMinutes) {
      // Reduce starter minutes by ~5% on back-to-backs
      estimatedMinutes *= 0.95;

      console.log(
        `[MinutesModel] Back-to-back game → 5% minutes reduction (${(estimatedMinutes / 0.95).toFixed(1)} → ${estimatedMinutes.toFixed(1)})`
      );
    }
    // Bench players might actually get MORE minutes on B2Bs, but we'll keep it simple for now
  }

  // ─── Teammate injury boost ─────────────────────────────────────────────────
  // TODO: This is complex and requires precise modeling of:
  // - Which teammates are out
  // - What positions they play
  // - How minutes get redistributed (not always to the same position)
  // - Whether the player is capable of absorbing those minutes
  //
  // For now, we'll leave this as a placeholder. A future enhancement could:
  // 1. Identify key teammates who are out (>20 min/game players)
  // 2. Estimate how their minutes get redistributed based on position overlap
  // 3. Apply a boost to players likely to absorb those minutes
  //
  // Example logic (not implemented):
  // if (hasKeyTeammateInjuries) {
  //   const injuryMinutesBoost = calculateTeammateInjuryBoost(player, injuredTeammates);
  //   estimatedMinutes += injuryMinutesBoost;
  // }

  // ─── Bounds checking ───────────────────────────────────────────────────────
  // Ensure the result is reasonable
  estimatedMinutes = Math.max(0, Math.min(estimatedMinutes, 48)); // Can't play more than 48 minutes

  return Math.round(estimatedMinutes * 10) / 10; // Round to 1 decimal place
}

/**
 * TODO: Calculate minutes boost from teammate injuries.
 *
 * This would require:
 * 1. List of injured teammates and their typical minutes
 * 2. Position overlap analysis (guards can absorb guard minutes more easily)
 * 3. Player capability assessment (can this player handle extra minutes?)
 * 4. Historical data on how minutes get redistributed when key players are out
 *
 * @param playerPosition - Position of the player (PG, SG, SF, PF, C)
 * @param injuredTeammates - List of injured teammates with their positions and typical minutes
 * @returns Estimated additional minutes from teammate absences
 */
export function calculateTeammateInjuryBoost(
  playerPosition: string,
  injuredTeammates: Array<{ position: string; typicalMinutes: number }>
): number {
  // Placeholder for future implementation
  // This would be a sophisticated model taking into account:
  // - Position compatibility (PG can't easily fill C minutes)
  // - Player's current role (bench players have more upside)
  // - Coach tendencies (some coaches prefer shorter rotations vs going deep into bench)

  return 0; // Not implemented yet
}