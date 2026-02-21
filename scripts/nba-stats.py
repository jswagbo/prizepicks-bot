#!/usr/bin/env python3
"""
NBA Stats Bridge — pulls data from nba_api and outputs JSON for the TypeScript pipeline.

Usage:
  python3 scripts/nba-stats.py player-search "Tyler Herro"
  python3 scripts/nba-stats.py game-log "Tyler Herro" [--season 2025-26]
  python3 scripts/nba-stats.py today-games
  python3 scripts/nba-stats.py seed-db <sqlite-path> <player1> <player2> ...
"""

import sys
import json
import time
import sqlite3
from pathlib import Path

from nba_api.stats.static import players, teams
from nba_api.stats.endpoints import playergamelog, scoreboardv2, leaguedashteamstats
from nba_api.live.nba.endpoints import scoreboard as live_scoreboard


def player_search(name: str) -> dict | None:
    """Search for a player by name."""
    results = players.find_players_by_full_name(name)
    if not results:
        # Try partial match
        results = players.find_players_by_last_name(name.split()[-1]) if ' ' in name else []
        results = [r for r in results if r['is_active']]
    if not results:
        return None
    p = results[0]
    return {
        "id": str(p["id"]),
        "name": p["full_name"],
        "team": "",  # nba_api static doesn't include current team easily
        "position": "",
    }


def get_game_log(player_name: str, season: str = "2025-26") -> list[dict]:
    """Get a player's game log for the season."""
    p = players.find_players_by_full_name(player_name)
    if not p:
        return []
    
    time.sleep(0.6)  # Rate limit
    log = playergamelog.PlayerGameLog(player_id=p[0]["id"], season=season)
    df = log.get_data_frames()[0]
    
    entries = []
    for _, row in df.iterrows():
        matchup = row.get("MATCHUP", "")
        home_away = "home" if "vs." in matchup else "away"
        opponent = matchup.split(" ")[-1] if matchup else ""
        
        entry = {
            "gameDate": row.get("GAME_DATE", ""),
            "opponent": opponent,
            "homeAway": home_away,
            "minutes": int(row.get("MIN", 0)),
            "points": int(row.get("PTS", 0)),
            "rebounds": int(row.get("REB", 0)),
            "assists": int(row.get("AST", 0)),
            "steals": int(row.get("STL", 0)),
            "blocks": int(row.get("BLK", 0)),
            "turnovers": int(row.get("TOV", 0)),
            "threePointersMade": int(row.get("FG3M", 0)),
            "fantasyScore": 0,
            "ptsRebsAsts": 0,
        }
        entry["ptsRebsAsts"] = entry["points"] + entry["rebounds"] + entry["assists"]
        entry["fantasyScore"] = (
            entry["points"] * 1
            + entry["rebounds"] * 1.2
            + entry["assists"] * 1.5
            + entry["steals"] * 3
            + entry["blocks"] * 3
            - entry["turnovers"] * 1
        )
        entries.append(entry)
    
    return entries


def get_today_games() -> list[dict]:
    """Get today's NBA games with spreads."""
    try:
        sb = live_scoreboard.ScoreBoard()
        data = sb.get_dict()
        games_data = data.get("scoreboard", {}).get("games", [])
    except Exception:
        games_data = []

    games = []
    for g in games_data:
        home = g.get("homeTeam", {})
        away = g.get("awayTeam", {})
        games.append({
            "gameId": g.get("gameId", ""),
            "homeTeam": home.get("teamTricode", ""),
            "awayTeam": away.get("teamTricode", ""),
            "homeTeamId": str(home.get("teamId", "")),
            "awayTeamId": str(away.get("teamId", "")),
            "startTime": g.get("gameTimeUTC", ""),
            "status": g.get("gameStatusText", ""),
            "spread": None,  # Live scoreboard doesn't have odds
        })
    
    return games


def seed_database(db_path: str, player_names: list[str]):
    """Seed the SQLite database with game logs for given players."""
    db = sqlite3.connect(db_path)
    
    # Ensure table exists
    db.execute("""
        CREATE TABLE IF NOT EXISTS player_game_logs (
            player_name TEXT NOT NULL,
            league TEXT NOT NULL DEFAULT 'NBA',
            game_date TEXT NOT NULL,
            opponent TEXT,
            home_away TEXT,
            minutes INTEGER DEFAULT 0,
            points INTEGER DEFAULT 0,
            rebounds INTEGER DEFAULT 0,
            assists INTEGER DEFAULT 0,
            steals INTEGER DEFAULT 0,
            blocks INTEGER DEFAULT 0,
            turnovers INTEGER DEFAULT 0,
            three_pointers_made INTEGER DEFAULT 0,
            fantasy_score REAL DEFAULT 0,
            pts_rebs_asts REAL DEFAULT 0,
            stat_json TEXT DEFAULT '{}',
            PRIMARY KEY (player_name, league, game_date)
        )
    """)
    
    success = 0
    fail = 0
    for name in player_names:
        try:
            logs = get_game_log(name)
            if not logs:
                print(f"  SKIP: {name} (no data)", file=sys.stderr)
                fail += 1
                continue
            
            for entry in logs:
                db.execute("""
                    INSERT OR REPLACE INTO player_game_logs
                    (player_name, league, game_date, opponent, home_away, minutes,
                     points, rebounds, assists, steals, blocks, turnovers,
                     three_pointers_made, fantasy_score, pts_rebs_asts, stat_json)
                    VALUES (?, 'NBA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    name, entry["gameDate"], entry["opponent"], entry["homeAway"],
                    entry["minutes"], entry["points"], entry["rebounds"], entry["assists"],
                    entry["steals"], entry["blocks"], entry["turnovers"],
                    entry["threePointersMade"], entry["fantasyScore"], entry["ptsRebsAsts"],
                    json.dumps(entry),
                ))
            
            db.commit()
            print(f"  OK: {name} ({len(logs)} games)", file=sys.stderr)
            success += 1
            time.sleep(0.6)  # Rate limit between players
        except Exception as e:
            print(f"  FAIL: {name} ({e})", file=sys.stderr)
            fail += 1
    
    db.close()
    return {"success": success, "fail": fail}


def main():
    if len(sys.argv) < 2:
        print("Usage: nba-stats.py <command> [args]", file=sys.stderr)
        sys.exit(1)
    
    cmd = sys.argv[1]
    
    if cmd == "player-search":
        name = sys.argv[2]
        result = player_search(name)
        print(json.dumps(result))
    
    elif cmd == "game-log":
        name = sys.argv[2]
        season = sys.argv[4] if len(sys.argv) > 4 and sys.argv[3] == "--season" else "2025-26"
        result = get_game_log(name, season)
        print(json.dumps(result))
    
    elif cmd == "today-games":
        result = get_today_games()
        print(json.dumps(result))
    
    elif cmd == "seed-db":
        db_path = sys.argv[2]
        player_names = sys.argv[3:]
        result = seed_database(db_path, player_names)
        print(json.dumps(result))
    
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
