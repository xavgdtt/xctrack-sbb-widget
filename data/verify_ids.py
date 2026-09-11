#!/usr/bin/env python3
"""Check that the DiDok numbers in stops.json.gz are usable as ids on
transport.opendata.ch.

Picks N random stops with a fixed seed, resolves each one by coordinate through
``/v1/locations?x=<lat>&y=<lon>`` and compares the nearest returned station id
with the DiDok number. Then routes a few of them to Zürich HB (8503000) through
``/v1/connections`` to confirm the id works as a ``from=`` value.

Only default headers are sent (the widget runs in a browser where custom
headers would break the CORS preflight), and requests are throttled.

Usage:
    uv run verify_ids.py [--n 20] [--connections 5] [--seed 42] [--json out.json]
"""

from __future__ import annotations

import argparse
import gzip
import json
import random
import sys
import time
from pathlib import Path

import requests

DATA_DIR = Path(__file__).resolve().parent
STOPS_PATH = DATA_DIR.parent / "web" / "public" / "data" / "stops.json.gz"
API = "https://transport.opendata.ch/v1"
HOME_ID = "8503000"  # Zürich HB
THROTTLE_S = 0.45


def get(url: str, params: dict[str, object]) -> dict:
    time.sleep(THROTTLE_S)
    resp = requests.get(url, params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()


def classify(didok: int, api_id: str | None) -> str:
    if api_id is None:
        return "no-id"
    if api_id == str(didok):
        return "exact"
    if api_id.lstrip("0") == str(didok):
        return "zero-padded"
    if api_id.endswith(str(didok)):
        return "prefixed"
    return "different"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stops", type=Path, default=STOPS_PATH)
    parser.add_argument("--n", type=int, default=20, help="stops to resolve by coordinate")
    parser.add_argument("--connections", type=int, default=5, help="stops to route to Zürich HB")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--ch-only",
        action="store_true",
        help="sample only CH stops (id prefix 85); foreign stops are often unknown to the API",
    )
    parser.add_argument("--json", type=Path, help="write the raw findings here")
    args = parser.parse_args(argv)

    with gzip.open(args.stops, "rt", encoding="utf-8") as fh:
        stops = json.load(fh)
    if args.ch_only:
        stops = [s for s in stops if 8500000 <= s["id"] < 8600000]
    sample = random.Random(args.seed).sample(stops, args.n)

    results = []
    for stop in sample:
        payload = get(f"{API}/locations", {"x": stop["lat"], "y": stop["lon"]})
        stations = payload.get("stations") or []
        # The coordinate search mixes in fuzzy "<name> (Haltestelle)" entries
        # that carry id: null; the real station is the nearest one with an id.
        with_id = [s for s in stations if s.get("id")]
        nearest = with_id[0] if with_id else {}
        api_id = nearest.get("id")
        row = {
            "didok": stop["id"],
            "name": stop["n"],
            "apiId": api_id,
            "apiName": nearest.get("name"),
            "distance_m": nearest.get("distance"),
            "match": classify(stop["id"], api_id),
            "nameMatch": (nearest.get("name") or "") == stop["n"],
            "idInList": str(stop["id"]) in {str(s.get("id")) for s in stations},
        }
        results.append(row)
        print(
            f"{row['match']:<11} didok={row['didok']:<8} api={str(row['apiId']):<10} "
            f"d={row['distance_m']} {row['name']!r} vs {row['apiName']!r}"
        )

    conn_results = []
    for stop in sample[: args.connections]:
        payload = get(
            f"{API}/connections",
            {"from": str(stop["id"]), "to": HOME_ID, "limit": 1},
        )
        connections = payload.get("connections") or []
        ok = bool(connections)
        first = connections[0] if ok else {}
        row = {
            "didok": stop["id"],
            "name": stop["n"],
            "ok": ok,
            "fromName": (first.get("from") or {}).get("station", {}).get("name"),
            "departure": (first.get("from") or {}).get("departure"),
            "arrival": (first.get("to") or {}).get("arrival"),
            "error": payload.get("errors"),
        }
        conn_results.append(row)
        print(
            f"connections from={row['didok']:<8} ok={row['ok']} "
            f"{row['fromName']!r} dep={row['departure']} arr={row['arrival']}"
        )

    counts: dict[str, int] = {}
    for r in results:
        counts[r["match"]] = counts.get(r["match"], 0) + 1
    print("\nid match summary:", counts)
    print("name of nearest station equals DiDok designation:", sum(r["nameMatch"] for r in results), "/", len(results))
    print("connections resolved:", sum(r["ok"] for r in conn_results), "/", len(conn_results))

    if args.json:
        args.json.write_text(
            json.dumps({"locations": results, "connections": conn_results, "summary": counts}, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        print("wrote", args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
