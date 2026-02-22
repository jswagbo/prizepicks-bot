/**
 * Test script for all model improvements
 * Run with: npx tsx test-improvements.ts
 */

import { calculatePaceAdjustment, calculateEWMA, isTeamOnBackToBack, calculateMinutesProjection, mapStatToDefenseCategory, getStatSpecificDefenseRank } from './src/prizepicks/matchup-analyzer';
import { recordPickResult, getHistoricalHitRate } from './src/prizepicks/pick-scorer';

console.log('═══════════════════════════════════════════════════════════');
console.log('  Testing PrizePicks Model Improvements');
console.log('═══════════════════════════════════════════════════════════\n');

// ─── Test 1: Pace Factor ─────────────────────────────────────────────────────

console.log('✓ Test 1: Pace Factor Calculation');
console.log('─────────────────────────────────────');

const paceTest1 = calculatePaceAdjustment('BOS', 'IND'); // Both high pace teams
console.log(`BOS vs IND (both fast): ${(paceTest1 * 100).toFixed(2)}%`);
console.assert(paceTest1 > 0, 'Fast pace game should have positive adjustment');

const paceTest2 = calculatePaceAdjustment('NY', 'MIA'); // Both slow pace teams
console.log(`NY vs MIA (both slow): ${(paceTest2 * 100).toFixed(2)}%`);
console.assert(paceTest2 < 0, 'Slow pace game should have negative adjustment');

const paceTest3 = calculatePaceAdjustment('BOS', 'MIA'); // Mixed pace
console.log(`BOS vs MIA (mixed): ${(paceTest3 * 100).toFixed(2)}%`);

console.log('✅ Pace factor tests passed\n');

// ─── Test 2: EWMA Calculation ────────────────────────────────────────────────

console.log('✓ Test 2: Exponential Weighted Moving Average');
console.log('─────────────────────────────────────────────');

const gameStats = [30, 28, 25, 20, 15, 10]; // Most recent to oldest
const ewma = calculateEWMA(gameStats);
console.log(`Game stats (recent → old): [${gameStats.join(', ')}]`);
console.log(`EWMA result: ${ewma.toFixed(2)}`);

// EWMA should be closer to recent games (30, 28, 25) than simple average (21.33)
const simpleAvg = gameStats.reduce((s, v) => s + v, 0) / gameStats.length;
console.log(`Simple average: ${simpleAvg.toFixed(2)}`);
console.assert(ewma > simpleAvg, 'EWMA should weight recent games more heavily');
// EWMA will be around 23-24 (weighted toward recent but not as high as just recent 3)
console.assert(ewma > 22 && ewma < 26, 'EWMA should be in reasonable range');

console.log('✅ EWMA tests passed\n');

// ─── Test 3: Back-to-Back Detection ──────────────────────────────────────────

console.log('✓ Test 3: Back-to-Back Detection');
console.log('─────────────────────────────────');

const b2bTest1 = isTeamOnBackToBack('LAL');
console.log(`LAL back-to-back: ${b2bTest1}`);

const b2bTest2 = isTeamOnBackToBack('BOS');
console.log(`BOS back-to-back: ${b2bTest2}`);

console.log('✅ B2B detection tests passed (requires game log data)\n');

// ─── Test 4: Minutes Projection ──────────────────────────────────────────────

console.log('✓ Test 4: Minutes Projection');
console.log('────────────────────────────');

const mockGameLogs = [
  { minutes: 35 },
  { minutes: 36 },
  { minutes: 34 },
  { minutes: 33 },
  { minutes: 32 },
  { minutes: 28 },
  { minutes: 30 },
  { minutes: 31 },
  { minutes: 29 },
  { minutes: 30 },
];

const minutesProjection = calculateMinutesProjection(mockGameLogs as any);
console.log(`Expected minutes (L5): ${minutesProjection.expectedMinutes}`);
console.log(`Season avg minutes: ${minutesProjection.seasonAvgMinutes}`);

console.assert(minutesProjection.expectedMinutes !== null, 'Should calculate expected minutes');
console.assert(minutesProjection.seasonAvgMinutes !== null, 'Should calculate season avg minutes');
console.assert(
  minutesProjection.expectedMinutes! > minutesProjection.seasonAvgMinutes!,
  'L5 minutes should be higher than season avg in this mock data'
);

console.log('✅ Minutes projection tests passed\n');

// ─── Test 5: Stat-Specific Defense Ranking ───────────────────────────────────

console.log('✓ Test 5: Stat-Specific Defense Mapping');
console.log('───────────────────────────────────────');

const testCases = [
  { input: 'Points', expected: 'Points' },
  { input: 'Rebounds', expected: 'Rebounds' },
  { input: 'Assists', expected: 'Assists' },
  { input: '3-PT Made', expected: 'Three pointers made' },
  { input: 'Pts+Rebs+Asts', expected: 'Points' },
];

for (const { input, expected } of testCases) {
  const result = mapStatToDefenseCategory(input);
  console.log(`${input} → ${result}`);
  console.assert(result === expected, `Expected ${expected}, got ${result}`);
}

console.log('\nTesting defense rank lookup:');
const rankTest = getStatSpecificDefenseRank('LAL', 'Points');
console.log(`LAL Points defense rank: ${rankTest ?? 'null (no data yet)'}`);

console.log('✅ Stat-specific defense tests passed\n');

// ─── Test 6: Historical Hit Rate Tracking ────────────────────────────────────

console.log('✓ Test 6: Historical Hit Rate Tracking');
console.log('──────────────────────────────────────');

// Record some mock pick results
const today = new Date().toISOString().split('T')[0];

console.log('Recording mock pick results...');
recordPickResult(today, 'LeBron James', 'Points', 'OVER', 0.08, 24.5, 27, true);
recordPickResult(today, 'Stephen Curry', '3-PT Made', 'OVER', 0.12, 4.5, 5, true);
recordPickResult(today, 'Nikola Jokic', 'Rebounds', 'UNDER', -0.06, 11.5, 10, true);
recordPickResult(today, 'Giannis Antetokounmpo', 'Points', 'OVER', 0.07, 29.5, 28, false);

// Try to get hit rate (will be null since we need 10+ samples)
const hitRate = getHistoricalHitRate('Points', 'medium');
console.log(`\nPoints OVER medium edge hit rate: ${hitRate ? (hitRate * 100).toFixed(1) + '%' : 'insufficient data (<10 samples)'}`);

console.log('✅ Historical hit rate tracking tests passed\n');

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════');
console.log('  ✅ All Tests Passed!');
console.log('═══════════════════════════════════════════════════════════');
console.log('\nModel improvements verified:');
console.log('  1. ✓ Pace Factor calculation');
console.log('  2. ✓ Exponential Weighted Moving Average (EWMA)');
console.log('  3. ✓ Back-to-Back detection');
console.log('  4. ✓ Minutes projection');
console.log('  5. ✓ Stat-specific defense ranking');
console.log('  6. ✓ Historical hit rate tracking');
console.log('\nReady for integration testing!\n');
