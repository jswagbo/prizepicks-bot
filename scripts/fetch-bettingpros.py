#!/usr/bin/env python3
"""
Fetch BettingPros prop picks via Scrapling (DynamicFetcher).
Outputs JSON to stdout for consumption by TypeScript pipeline.

BettingPros embeds prop data in script tags — requires JS rendering.
Uses Scrapling's DynamicFetcher (Playwright Chromium) to render the page.

Output format: Array of { playerName, statType, projection, side, ev, betRating, diff }
"""
import sys
import re
import json

try:
    from scrapling.fetchers import DynamicFetcher
except ImportError:
    print("[]", flush=True)
    sys.exit(0)

MARKET_ID_TO_STAT = {
    130: 'Assists',
    131: 'Rebounds',
    132: 'Points',
    133: '3-PT Made',
    135: 'Steals',
    136: 'Turnovers',
    142: 'Blocked Shots',
    147: 'Fantasy Score',
    151: 'Double Double',
    152: 'First Basket',
    156: 'Points',          # alt
    157: 'Blks+Stls',
    160: 'Steals',          # alt
    162: 'Turnovers',       # alt
    248: 'Pts+Rebs',
    249: 'Rebs+Asts',
    250: 'Pts+Asts',
    251: 'Blks+Stls',       # alt
    252: 'Pts+Rebs+Asts',   # alt
    335: 'Pts+Asts',        # alt
    336: 'Pts+Rebs',        # alt
    337: 'Rebs+Asts',       # alt
    338: 'Pts+Rebs+Asts',
    364: 'Rebounds',         # alt
}

def extract_props(html_text: str) -> list:
    """Extract props array from embedded script data."""
    # Find the widget_label section which precedes the props array
    idx = html_text.find('"widget_label"')
    if idx < 0:
        return []
    
    props_start = html_text.find('"props":[', idx)
    if props_start < 0:
        return []
    
    arr_start = html_text.find('[', props_start)
    depth = 0
    i = arr_start
    while i < len(html_text):
        if html_text[i] == '[':
            depth += 1
        elif html_text[i] == ']':
            depth -= 1
            if depth == 0:
                break
        i += 1
    
    try:
        return json.loads(html_text[arr_start:i + 1])
    except json.JSONDecodeError:
        return []

def main():
    try:
        page = DynamicFetcher.fetch(
            'https://www.bettingpros.com/nba/picks/prop-bets/',
            headless=True,
            network_idle=True,
        )
    except Exception as e:
        print(json.dumps([]), flush=True)
        sys.exit(0)

    # Find the script with prop data (usually index 40, but search to be safe)
    scripts = page.css('script')
    html_text = None
    for s in scripts:
        t = s.text or ''
        if '"widget_label"' in t and '"props":[' in t:
            html_text = t
            break
    
    if not html_text:
        print(json.dumps([]), flush=True)
        sys.exit(0)

    raw_props = extract_props(html_text)
    
    results = []
    for p in raw_props:
        market_id = p.get('market_id')
        stat_type = MARKET_ID_TO_STAT.get(market_id)
        if not stat_type:
            # Try to infer from link
            link = p.get('links', {}).get('analyzer', '')
            slug = link.rstrip('/').split('/')[-1] if link else ''
            stat_map = {
                'points': 'Points', 'rebounds': 'Rebounds', 'assists': 'Assists',
                'three-pointers': '3-PT Made', 'blocks': 'Blocked Shots',
                'steals': 'Steals', 'turnovers': 'Turnovers',
                'points-rebounds-assists': 'Pts+Rebs+Asts',
                'points-rebounds': 'Pts+Rebs', 'points-assists': 'Pts+Asts',
                'rebounds-assists': 'Rebs+Asts', 'blocks-steals': 'Blks+Stls',
            }
            stat_type = stat_map.get(slug)
        
        if not stat_type:
            continue
        
        participant = p.get('participant', {})
        player = participant.get('player', {})
        name = participant.get('name', '')
        if not name:
            first = player.get('first_name', '')
            last = player.get('last_name', '')
            name = f"{first} {last}".strip()
        
        proj = p.get('projection', {})
        projection_value = proj.get('value')
        if projection_value is None or projection_value <= 0:
            continue
        
        results.append({
            'playerName': name,
            'statType': stat_type,
            'projection': round(projection_value, 1),
            'side': proj.get('recommended_side', ''),
            'ev': round(proj.get('expected_value', 0), 4),
            'betRating': proj.get('bet_rating', 0),
            'diff': round(proj.get('diff', 0), 1),
            'probability': round(proj.get('probability', 0), 4),
            'team': player.get('team', ''),
        })
    
    print(json.dumps(results), flush=True)

if __name__ == '__main__':
    main()
