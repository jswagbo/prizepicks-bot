#!/usr/bin/env python3
"""
Fetch PrizePicks projections via Scrapling's StealthyFetcher.
Outputs JSON to stdout for consumption by TypeScript pipeline.

PrizePicks blocks direct API calls with PerimeterX. This scraper
uses StealthyFetcher to load the web app and intercept the internal
API response that the SPA makes.

Output format: Array of PrizePicks projection objects (same as API format)
"""
import sys
import json
import logging

# Suppress scrapling/playwright INFO logs from polluting stdout
logging.disable(logging.INFO)

try:
    from scrapling.fetchers import StealthyFetcher
except ImportError:
    print(json.dumps({"data": [], "included": []}), flush=True)
    sys.exit(0)


def main():
    captured = []

    def intercept(response):
        url = response.url
        if '/projections' in url and 'api.prizepicks' in url and 'in_game=false' not in url:
            try:
                data = response.json()
                if 'data' in data and len(data.get('data', [])) > 0:
                    captured.append(data)
            except Exception:
                pass

    try:
        StealthyFetcher.fetch(
            'https://app.prizepicks.com/projections',
            headless=True,
            network_idle=False,
            wait_selector='body',
            page_action=lambda p: (
                p.on("response", intercept),
                p.wait_for_timeout(12000),
            ),
        )
    except Exception:
        pass

    if captured:
        # Use the largest response (most projections)
        best = max(captured, key=lambda d: len(d.get('data', [])))
        print(json.dumps(best), flush=True)
    else:
        print(json.dumps({"data": [], "included": []}), flush=True)


if __name__ == '__main__':
    main()
