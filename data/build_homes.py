#!/usr/bin/env python3
"""Pick the ~100 busiest Swiss rail stations and write them to data/homes.txt.

``homes.txt`` is the destination list for ``build_tables.py``: one DiDok id per
line, followed by ``# <official name>``. It is meant to be hand-edited — the
generated file is a starting point, not a contract. Lines that are empty or
start with ``#`` are ignored by the reader.

Two ranking modes:

* ``--gtfs <zip>`` counts real departures: every ``stop_times`` row whose trip
  runs on a representative weekday, aggregated onto the parent DiDok number.
  This is the honest measure of "busiest" and needs the 250 MB GTFS zip.
* fallback (no ``--gtfs``) scores a station by its surroundings: rail stops
  within 1 km plus bus stops within 500 m. A real station sits in a web of
  feeder bus stops; a rural halt is a single point in a field. This is a crude
  proxy — it over-rates dense narrow-gauge lines (the Montreux–Glion rack
  railway puts nine "rail stops within 1 km" around every halt) and under-rates
  tourist termini with few neighbours. Roughly three quarters of the stations a
  Swiss traveller would name make the top 300 under it, against a hand-checked
  list of 50; at the default cut of 100 the misses bite harder, which is what
  ``ALWAYS_INCLUDE`` and hand-editing are for. Use ``--gtfs`` when the zip is at hand; the fallback exists so the
  file can be regenerated from ``stops.json.gz`` alone.

The list only decides which homes get an offline travel-time table. Any station
at all works as a home in the widget, which falls back to its heuristic plus the
live timetable API for a home that is not in this file.

Both modes then take the top N after a greedy minimum-separation filter, so a
station does not consume several of the N slots with its co-located siblings
(Zürich HB and Zürich HB SZU are one home, not two). ``ALWAYS_INCLUDE`` is
seeded before the ranked fill, so those hubs both survive and win their cluster.

Usage:
    uv run build_homes.py                       # fallback score
    uv run build_homes.py --gtfs downloads/gtfs_fp2026.zip
    uv run build_homes.py --count 300 --out homes.txt   # a longer list
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import io
import json
import logging
import sys
import zipfile
from pathlib import Path

import numpy as np

DATA_DIR = Path(__file__).resolve().parent
STOPS_PATH = DATA_DIR.parent / "web" / "public" / "data" / "stops.json.gz"
HOMES_PATH = DATA_DIR / "homes.txt"

MODE_RAIL, MODE_BUS = 1, 2

# Generous box around Switzerland; stops.json.gz has no country column, and the
# border stops it deliberately keeps (20 km into DE/AT/FR/IT) are not homes.
CH_BBOX = (45.80, 47.85, 5.90, 10.55)  # lat_min, lat_max, lon_min, lon_max

RAIL_RADIUS_KM = 1.0
BUS_RADIUS_KM = 0.5
EARTH_R_KM = 6371.0088

# Hubs that must be in the list whatever the score says: the seven the widget's
# acceptance criteria name, i.e. the stations XC pilots actually go home to.
ALWAYS_INCLUDE = (8503000, 8507000, 8507492, 8501120, 8505000, 8509000, 8501506)

log = logging.getLogger("build_homes")


def load_stops(path: Path) -> list[dict]:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def to_xyz(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Unit-sphere cartesian coordinates scaled to km, for KD-tree distances."""
    la, lo = np.radians(lat), np.radians(lon)
    return np.column_stack(
        [
            EARTH_R_KM * np.cos(la) * np.cos(lo),
            EARTH_R_KM * np.cos(la) * np.sin(lo),
            EARTH_R_KM * np.sin(la),
        ]
    )


def candidate_stations(stops: list[dict]) -> list[dict]:
    """Rail stops inside the Swiss bounding box, in input order."""
    lat_min, lat_max, lon_min, lon_max = CH_BBOX
    return [
        s
        for s in stops
        if (s["m"] & MODE_RAIL)
        and lat_min <= s["lat"] <= lat_max
        and lon_min <= s["lon"] <= lon_max
    ]


def neighbourhood_scores(candidates: list[dict], stops: list[dict]) -> np.ndarray:
    """Fallback score: rail stops within 1 km plus bus stops within 500 m."""
    from scipy.spatial import cKDTree

    cand_xyz = to_xyz(
        np.array([s["lat"] for s in candidates]), np.array([s["lon"] for s in candidates])
    )
    scores = np.zeros(len(candidates), dtype=np.int64)
    for mode, radius in ((MODE_RAIL, RAIL_RADIUS_KM), (MODE_BUS, BUS_RADIUS_KM)):
        subset = [s for s in stops if s["m"] & mode]
        tree = cKDTree(to_xyz(np.array([s["lat"] for s in subset]), np.array([s["lon"] for s in subset])))
        scores += np.array([len(hits) for hits in tree.query_ball_point(cand_xyz, radius)], dtype=np.int64)
        log.info("counted %d stops with mode bit %d within %.1f km", len(subset), mode, radius)
    return scores


def _open_member(zf: zipfile.ZipFile, name: str) -> csv.DictReader:
    """CSV reader over a GTFS member, tolerating the UTF-8 BOM."""
    return csv.DictReader(io.TextIOWrapper(zf.open(name), encoding="utf-8-sig", newline=""))


def _active_service_ids(zf: zipfile.ZipFile, day: dt.date) -> set[str]:
    weekday = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")[day.weekday()]
    stamp = day.strftime("%Y%m%d")
    active: set[str] = set()
    names = set(zf.namelist())
    if "calendar.txt" in names:
        for row in _open_member(zf, "calendar.txt"):
            if row[weekday] == "1" and row["start_date"] <= stamp <= row["end_date"]:
                active.add(row["service_id"])
    if "calendar_dates.txt" in names:
        for row in _open_member(zf, "calendar_dates.txt"):
            if row["date"] != stamp:
                continue
            if row["exception_type"] == "1":
                active.add(row["service_id"])
            else:
                active.discard(row["service_id"])
    return active


def gtfs_departure_counts(gtfs_zip: Path, day: dt.date) -> dict[int, int]:
    """Departures per DiDok number on ``day``, from the GTFS stop_times table.

    Swiss GTFS stop ids are ``<DiDok>[:<platform>...]`` (e.g. ``8503000:0:41``),
    so the parent station is the part before the first colon.
    """
    counts: dict[int, int] = {}
    with zipfile.ZipFile(gtfs_zip) as zf:
        services = _active_service_ids(zf, day)
        log.info("%s: %d active service ids", day.isoformat(), len(services))
        trips = {
            row["trip_id"] for row in _open_member(zf, "trips.txt") if row["service_id"] in services
        }
        log.info("%d trips run on %s", len(trips), day.isoformat())
        for n, row in enumerate(_open_member(zf, "stop_times.txt"), start=1):
            if n % 5_000_000 == 0:
                log.info("  %d million stop_times rows read", n // 1_000_000)
            if row["trip_id"] not in trips:
                continue
            head = row["stop_id"].split(":", 1)[0]
            if head.isdigit():
                didok = int(head)
                counts[didok] = counts.get(didok, 0) + 1
    log.info("counted departures at %d distinct DiDok numbers", len(counts))
    return counts


def pick_homes(
    candidates: list[dict], scores: np.ndarray, count: int, min_sep_km: float
) -> list[dict]:
    """Top ``count`` by score, skipping anything too close to an earlier pick."""
    from scipy.spatial import cKDTree

    order = sorted(
        range(len(candidates)),
        key=lambda i: (-int(scores[i]), candidates[i]["id"]),
    )

    picked: list[dict] = []
    picked_xyz: list[np.ndarray] = []

    def take(stop: dict) -> bool:
        xyz = to_xyz(np.array([stop["lat"]]), np.array([stop["lon"]]))[0]
        if picked_xyz and cKDTree(np.array(picked_xyz)).query(xyz)[0] < min_sep_km:
            return False
        picked.append(stop)
        picked_xyz.append(xyz)
        return True

    # Required hubs go in first so they, and not a co-located sibling with a
    # slightly better score, are the one home kept for their cluster.
    by_id = {s["id"]: s for s in candidates}
    for home_id in ALWAYS_INCLUDE:
        if home_id in by_id:
            take(by_id[home_id])
        else:
            log.warning("required hub %d is not a rail stop inside the CH bbox", home_id)

    for i in order:
        if len(picked) >= count:
            break
        if candidates[i]["id"] not in ALWAYS_INCLUDE:
            take(candidates[i])
    return picked


def write_homes(path: Path, homes: list[dict], scores: dict[int, int], source: str) -> None:
    lines = [
        "# Destination stations for data/build_tables.py — one DiDok id per line.",
        f"# Generated by build_homes.py ({source}); hand-edit freely.",
        f"# {len(homes)} stations: the required hubs first, then by score.",
    ]
    width = max(len(str(h["id"])) for h in homes)
    lines += [f"{h['id']:<{width}}  # {h['n']} (score {scores.get(h['id'], 0)})" for h in homes]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def read_homes(path: Path) -> list[int]:
    """Parse homes.txt — used by build_tables.py and the tests."""
    ids: list[int] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            ids.append(int(line))
    return ids


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--stops", type=Path, default=STOPS_PATH, help="stops.json.gz path")
    parser.add_argument("--out", type=Path, default=HOMES_PATH, help="output homes.txt")
    parser.add_argument("--count", type=int, default=100,
                        help="number of homes to keep (one travel-time table each)")
    parser.add_argument(
        "--gtfs", type=Path, help="GTFS zip; rank by departures on --gtfs-day instead of the fallback"
    )
    parser.add_argument(
        "--gtfs-day",
        type=dt.date.fromisoformat,
        help="reference weekday for --gtfs (default: the first Wednesday at least 14 days out)",
    )
    parser.add_argument(
        "--min-sep-km",
        type=float,
        default=0.5,
        help="minimum distance between two homes (drops co-located platforms)",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    stops = load_stops(args.stops)
    candidates = candidate_stations(stops)
    log.info("%d stops, %d rail stops inside the CH bbox", len(stops), len(candidates))

    if args.gtfs:
        day = args.gtfs_day
        if day is None:
            day = dt.date.today() + dt.timedelta(days=14)
            day += dt.timedelta(days=(2 - day.weekday()) % 7)  # next Wednesday
        counts = gtfs_departure_counts(args.gtfs, day)
        scores = np.array([counts.get(s["id"], 0) for s in candidates], dtype=np.int64)
        source = f"GTFS departures on {day.isoformat()}"
    else:
        scores = neighbourhood_scores(candidates, stops)
        source = "fallback score: rail stops within 1 km + bus stops within 500 m"

    homes = pick_homes(candidates, scores, args.count, args.min_sep_km)
    by_id = {s["id"]: int(scores[i]) for i, s in enumerate(candidates)}
    write_homes(args.out, homes, by_id, source)

    log.info("scoring: %s", source)
    log.info("wrote %d homes to %s", len(homes), args.out)
    log.info(
        "top 10: %s", ", ".join(f"{h['n']} ({by_id.get(h['id'], 0)})" for h in homes[:10])
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
