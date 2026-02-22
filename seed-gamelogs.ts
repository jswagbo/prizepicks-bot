import { getDatabase } from './src/core/db/database';
import { getGameLog, searchPlayer } from './src/prizepicks/nba-stats-client';
import { getProjections } from './src/prizepicks/prizepicks-client';

async function seed() {
  const db = getDatabase();
  
  const projections = await getProjections('NBA');
  const players = new Set<string>();
  for (const p of projections) {
    if (p.playerName) players.add(p.playerName);
  }
  
  console.log(`Found ${players.size} unique players to seed`);
  
  let done = 0;
  let failed = 0;
  const total = players.size;
  
  for (const name of players) {
    try {
      const existing = db.prepare(
        `SELECT COUNT(*) as c FROM player_game_logs WHERE player_name = ?`
      ).get(name) as any;
      
      if (existing?.c > 0) {
        done++;
        if (done % 50 === 0) console.log(`[${done}/${total}] skipping cached...`);
        continue;
      }
      
      const player = await searchPlayer(name);
      if (player) {
        await getGameLog(player.id, name);
        const count = (db.prepare(
          `SELECT COUNT(*) as c FROM player_game_logs WHERE player_name = ?`
        ).get(name) as any)?.c || 0;
        console.log(`[${++done}/${total}] ${name}: ${count} games`);
      } else {
        console.log(`[${++done}/${total}] ${name}: NOT FOUND`);
        failed++;
      }
      
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 150));
    } catch (e: any) {
      console.log(`[${++done}/${total}] ${name}: ERROR ${e.message?.slice(0, 80)}`);
      failed++;
    }
  }
  
  const totalLogs = (db.prepare(`SELECT COUNT(*) as c FROM player_game_logs`).get() as any)?.c || 0;
  console.log(`\nDone! ${totalLogs} total game logs cached. ${failed} players failed.`);
}

seed().catch(e => { console.error(e); process.exit(1); });
