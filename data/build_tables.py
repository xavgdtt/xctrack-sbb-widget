#!/usr/bin/env python3
"""Build web/public/data/tables/<homeId>.bin.gz — offline travel-time tables (Phase 2).

For every home station in ``homes.txt`` the widget gets one table: the median
travel time, including the initial wait, between the home and *every* stop in
``stops.json.gz``, for three day types and sixteen departure hours. With the
table cached the widget can rank stops with no network at all.

Pipeline: Swiss GTFS (opentransportdata.swiss permalink) + a Switzerland OSM
extract (Geofabrik, cropped with ``osmium`` when available) -> a sanitised copy
of the GTFS that R5 can route on (:func:`sanitise_gtfs`) -> an R5 transport
network via r5py -> one ``r5py.TravelTimeMatrix`` per (day type, hour, batch of
homes), origins = the homes, destinations = all stops.

The matrix is computed **home -> stop**, not stop -> home, because R5 runs one
search per origin: 100 homes cost 100 searches, 34,362 stops would cost 34,362.
The widget needs the stop -> home direction, and takes this as an approximation:
transit travel time is close to symmetric, but the initial wait is measured at
the home end rather than at the stop. The error is a few minutes on frequent
services and up to one headway on an hourly postbus. See data/README.md.

Binary format (must match web/src/table.ts) — 32-byte little-endian header:

    magic "XSBT" (4) | version u8 = 1 | dayTypes u8 = 3 | hourStart u8 = 6
    | hourCount u8 = 16 | stopCount u32 | homeId u32 | buildId 16 bytes ASCII

followed by ``u16 minutes[dayType][hour][stopIdx]``, 65535 = unreachable. The
file is gzipped (``<homeId>.bin.gz``); ``--also-plain`` additionally writes the
uncompressed ``<homeId>.bin`` that ``table.ts`` falls back to where the WebView
has no ``DecompressionStream``.
``stopIdx`` is the position in ``stops.json.gz`` (sorted by id), which is why
the table carries the ``buildId`` of the ``meta.json`` it was built against:
a widget that sees a different id must ignore the table.

With the homes as origins the whole 3 x 16 grid for 100 homes is a few thousand
searches and fits one CI run — see data/README.md. The run is still resumable
per home and per day type (checkpoints under ``cache/tables/h2s-<buildId>-...``)
and still takes a ``--time-budget-min``; ``--homes-limit``, ``--hours`` and
``--day-types`` remain for narrowing a run.

Usage:
    uv run --group tables build_tables.py --selftest        # no r5py, no data
    uv run --group tables build_tables.py                   # full build
    uv run --group tables build_tables.py --homes-limit 10 --day-types 1 \\
        --hours 12-15 --time-budget-min 60
    JAVA_TOOL_OPTIONS=-Xmx6g uv run --group tables build_tables.py
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import datetime as dt
import gzip
import io
import json
import logging
import os
import random
import shutil
import struct
import subprocess
import sys
import time
import zipfile
from pathlib import Path

import numpy as np

from build_homes import CH_BBOX, read_homes

DATA_DIR = Path(__file__).resolve().parent
DOWNLOAD_DIR = DATA_DIR / "downloads"
CACHE_DIR = DATA_DIR / "cache" / "tables"
GTFS_CACHE_DIR = DATA_DIR / "cache" / "gtfs"
HOMES_PATH = DATA_DIR / "homes.txt"
WEB_DATA_DIR = DATA_DIR.parent / "web" / "public" / "data"
STOPS_PATH = WEB_DATA_DIR / "stops.json.gz"
META_PATH = WEB_DATA_DIR / "meta.json"
OUT_DIR = WEB_DATA_DIR / "tables"

# Permalink for the current timetable year; it always redirects to the newest
# gtfs_fp20xx_<date>.zip and needs no API key. The cookbook lists the sibling
# datasets timetable-2027-gtfs2020 and timetable-draft-gtfs.
GTFS_URL = "https://data.opentransportdata.swiss/dataset/timetable-2026-gtfs2020/permalink"
OSM_URL = "https://download.geofabrik.de/europe/switzerland-latest.osm.pbf"

# Binary format — keep in lockstep with web/src/table.ts.
MAGIC = b"XSBT"
VERSION = 1
DAY_TYPES = 3  # 0 = Mon-Fri, 1 = Sat, 2 = Sun/holiday
HOUR_START = 6
HOUR_COUNT = 16  # 06:00 .. 21:00
UNREACHABLE = 65535
MAX_MINUTES = UNREACHABLE - 1
HEADER_STRUCT = struct.Struct("<4sBBBBII16s")
BUILD_ID_BYTES = 16

# Weekday each day type is sampled on.
DAY_TYPE_WEEKDAY = {0: 0, 1: 5, 2: 6}  # Monday, Saturday, Sunday
DAY_TYPE_NAMES = {0: "Mon-Fri", 1: "Sat", 2: "Sun/holiday"}

log = logging.getLogger("build_tables")


# --------------------------------------------------------------------------
# binary format
# --------------------------------------------------------------------------


def build_id_field(build_id: str) -> bytes:
    """The header's 16-byte buildId field: ASCII, truncated, NUL-padded.

    ``meta.json`` currently carries a 19-character id (``2026-09-11-4b9110db``:
    date plus eight hex digits of the stops hash), which does not fit the
    32-byte header. The field therefore holds the first 16 characters and the
    widget must compare against ``meta.buildId.slice(0, 16)``. That still
    changes whenever the stop list changes, which is the whole point of the
    check — the table indexes stops by position.
    """
    return build_id.encode("ascii")[:BUILD_ID_BYTES].ljust(BUILD_ID_BYTES, b"\0")


def encode_table(home_id: int, build_id: str, minutes: np.ndarray) -> bytes:
    """Serialise one home's table.

    ``minutes`` must have shape ``(DAY_TYPES, HOUR_COUNT, stopCount)``; values
    are clamped into ``[0, 65534]``, and 65535 is passed through as the
    unreachable marker.
    """
    if minutes.shape[:2] != (DAY_TYPES, HOUR_COUNT):
        raise ValueError(f"expected shape ({DAY_TYPES}, {HOUR_COUNT}, n), got {minutes.shape}")
    build_id_bytes = build_id_field(build_id)
    stop_count = int(minutes.shape[2])
    header = HEADER_STRUCT.pack(
        MAGIC,
        VERSION,
        DAY_TYPES,
        HOUR_START,
        HOUR_COUNT,
        stop_count,
        home_id,
        build_id_bytes,
    )
    body = np.ascontiguousarray(minutes, dtype="<u2")
    return header + body.tobytes()


def write_table_files(path: Path, blob: bytes, also_plain: bool) -> None:
    """Write ``<path>.gz``, and ``<path>`` itself only when ``also_plain``.

    The gzip is deterministic (level 9, ``mtime=0``), so an unchanged table is
    byte-identical between runs. GitHub Pages serves ``.gz`` without a
    ``Content-Encoding`` header, so ``table.ts`` decompresses it in the browser
    with ``DecompressionStream('gzip')`` and falls back to the plain file where
    that API is missing. Without ``--also-plain`` a plain file left over from an
    earlier run is deleted rather than left to be served stale.
    """
    path.with_suffix(path.suffix + ".gz").write_bytes(gzip.compress(blob, 9, mtime=0))
    if also_plain:
        path.write_bytes(blob)
    elif path.exists():
        path.unlink()


def minutes_from_travel_times(values: np.ndarray) -> np.ndarray:
    """Round float minutes (NaN = no connection) into the table's uint16 domain."""
    out = np.full(values.shape, UNREACHABLE, dtype=np.uint16)
    finite = np.isfinite(values)
    rounded = np.rint(np.where(finite, values, 0.0))
    out[finite] = np.clip(rounded[finite], 0, MAX_MINUTES).astype(np.uint16)
    return out


# --------------------------------------------------------------------------
# inputs
# --------------------------------------------------------------------------


def download(url: str, dest: Path, refresh: bool) -> Path:
    if dest.exists() and not refresh:
        log.info("using cached %s (%.0f MB)", dest.name, dest.stat().st_size / 1e6)
        return dest
    import requests

    log.info("downloading %s", url)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with requests.get(url, stream=True, timeout=600) as resp:
        resp.raise_for_status()
        with tmp.open("wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                fh.write(chunk)
    tmp.replace(dest)
    log.info("downloaded %.0f MB to %s", dest.stat().st_size / 1e6, dest)
    return dest


def crop_osm(pbf: Path, cropped: Path, refresh: bool) -> Path:
    """Cut the OSM extract down to the Swiss bounding box, if osmium is installed.

    R5 builds its street layer from every way in the file, so trimming the
    Geofabrik extract (which overshoots the border) is the cheapest memory win
    available. Without ``osmium`` the uncropped file still works.
    """
    if cropped.exists() and not refresh:
        log.info("using cached %s (%.0f MB)", cropped.name, cropped.stat().st_size / 1e6)
        return cropped
    if shutil.which("osmium") is None:
        log.warning("osmium not found — routing on the uncropped %s", pbf.name)
        return pbf
    lat_min, lat_max, lon_min, lon_max = CH_BBOX
    bbox = f"{lon_min},{lat_min},{lon_max},{lat_max}"
    log.info("cropping %s to %s", pbf.name, bbox)
    subprocess.run(
        ["osmium", "extract", "--bbox", bbox, "--strategy", "complete_ways",
         "--overwrite", "-o", str(cropped), str(pbf)],
        check=True,
    )
    log.info("cropped to %.0f MB", cropped.stat().st_size / 1e6)
    return cropped


def file_digest(path: Path, length: int = 8) -> str:
    """Short content hash, used to tie checkpoints to the GTFS they came from."""
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()[:length]


def load_stops() -> list[dict]:
    with gzip.open(STOPS_PATH, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def load_build_id() -> str:
    return json.loads(META_PATH.read_text(encoding="utf-8"))["buildId"]


# --------------------------------------------------------------------------
# GTFS sanitising
# --------------------------------------------------------------------------

# Bump when the rules below change, so a cached sanitised zip built by an older
# version of this file is not reused.
SANITISER_VERSION = 1


def basic_route_type(code: int) -> int | None:
    """Map a GTFS ``route_type`` to the basic set, or ``None`` to drop the route.

    The Swiss feed uses the extended (TPEG) codes — 1xx rail, 2xx coach, 4xx
    urban rail, 7xx bus, 9xx tram, 10xx water, 13xx aerial, 14xx funicular,
    15xx taxi/on-demand, 1700 misc. R5 7.5.1 accepts most of those, but
    ``TransitLayer.getTransitModes`` throws ``IllegalArgumentException`` for
    1500-1599 ("Taxi route_type code not supported") and for anything >= 1600
    ("Car or other route_type code above 1600 not supported") — and it throws
    from ``FilteredPatterns``, i.e. during routing, long after the network has
    been built and cached. Anything it does not recognise at all ("Unknown GTFS
    route_type code") throws from the same place.

    Rather than remap only the codes that throw, every extended code is folded
    onto the basic one R5's own ``getTransitModes`` would have produced. The
    ranges are whole hundreds, not just the sub-codes the Swiss feed documents,
    so a code nobody has seen yet still lands somewhere sensible. Mapping does
    not change routing: the tables are built with ``TransportMode.TRANSIT``,
    which is R5's "any transit mode", so ``route_type`` only ever decides which
    mode label a pattern carries.
    """
    if code in (0, 1, 2, 3, 4, 5, 6, 7, 11, 12):
        return code  # already a basic code (8, 9, 10 are unassigned)
    if 100 <= code < 200:  # railway service
        return 2
    if 200 <= code < 300:  # coach service
        return 3
    if 300 <= code < 400:  # suburban railway service
        return 2
    if 400 <= code < 500:  # urban railway service
        if code in (401, 402):  # metro, underground
            return 1
        if code == 405:  # monorail
            return 12
        return 2
    if 500 <= code < 700:  # metro and underground service
        return 1
    if 700 <= code < 800:  # bus service
        return 3
    if 800 <= code < 900:  # trolleybus service
        return 11
    if 900 <= code < 1000:  # tram service
        return 0
    if 1000 <= code < 1100:  # water transport service
        return 4
    if 1200 <= code < 1300:  # ferry service
        return 4
    if 1300 <= code < 1400:  # telecabin / aerial lift service
        return 6
    if 1400 <= code < 1500:  # funicular service
        return 7
    # 1100-1199 air, 1500-1599 taxi / on-demand, 1600+ car and "misc" (1700),
    # and anything unrecognised: no basic equivalent, so drop the route.
    return None


def _read_rows(zf: zipfile.ZipFile, name: str):
    """Stream one member as dicts. ``stop_times.txt`` is ~1 GB uncompressed, so
    nothing here ever holds more than one row."""
    with zf.open(name) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        reader = csv.DictReader(text)
        yield reader.fieldnames or []
        yield from reader


@contextlib.contextmanager
def _member_writer(zf: zipfile.ZipFile, name: str, fieldnames: list[str]):
    """Write one member row by row, without buffering the whole table."""
    # force_zip64: stop_times.txt uncompressed is > 4 GB for the full Swiss
    # feed, which overflows the classic zip member size field without it.
    with zf.open(name, "w", force_zip64=True) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8", newline="")
        writer = csv.DictWriter(text, fieldnames=fieldnames, restval="", extrasaction="ignore")
        writer.writeheader()
        yield writer
        text.flush()
        text.detach()


def _sanitise_routes(src: zipfile.ZipFile, out: zipfile.ZipFile) -> set[str]:
    """Rewrite routes.txt with basic route types; return the dropped route ids.

    Also repairs ``agency_id``: ``RouteInfo`` dereferences the agency without a
    null check, so a route whose ``agency_id`` is blank or dangling is a
    ``NullPointerException`` during the network build as soon as the feed has
    more than one agency (with exactly one, R5 associates it automatically).
    """
    agency_ids: list[str] = []
    if "agency.txt" in src.namelist():
        agency_rows = _read_rows(src, "agency.txt")
        next(agency_rows)
        agency_ids = [(row.get("agency_id") or "").strip() for row in agency_rows]
        agency_ids = [a for a in agency_ids if a]

    rows = _read_rows(src, "routes.txt")
    fields = list(next(rows))
    if agency_ids and "agency_id" not in fields:
        fields.insert(1, "agency_id")

    known_agencies = set(agency_ids)
    mapped: dict[tuple[int, int | None], int] = {}
    dropped: set[str] = set()
    repaired_agency = 0
    with _member_writer(out, "routes.txt", fields) as writer:
        for row in rows:
            raw_type = (row.get("route_type") or "").strip()
            try:
                code = int(raw_type)
            except ValueError:
                code = -1
            target = basic_route_type(code)
            mapped[(code, target)] = mapped.get((code, target), 0) + 1
            if target is None:
                dropped.add(row["route_id"])
                continue
            row["route_type"] = str(target)
            if len(known_agencies) > 1 and (row.get("agency_id") or "").strip() not in known_agencies:
                row["agency_id"] = agency_ids[0]
                repaired_agency += 1
            writer.writerow(row)

    for (code, target), count in sorted(mapped.items()):
        log.info(
            "  route_type %-5s -> %-6s %6d route%s",
            code if code >= 0 else "(bad)",
            "dropped" if target is None else target,
            count,
            "" if count == 1 else "s",
        )
    if repaired_agency:
        log.warning("  %d routes had an unresolvable agency_id, pointed at %s",
                    repaired_agency, agency_ids[0])
    return dropped


def sanitise_gtfs(src_zip: Path, out_dir: Path) -> Path:
    """Write an R5-safe copy of ``src_zip`` and return its path.

    The copy is named after the hash of the source, so it is rebuilt only when
    the feed changes. What it changes:

    * ``routes.txt`` — extended ``route_type`` codes folded onto the basic set
      (see :func:`basic_route_type`); routes with no basic equivalent (air,
      taxi/on-demand, car, misc) dropped, along with their trips, stop times
      and frequency entries. A dropped route whose trips stayed would be a
      ``NullPointerException``: ``TransitLayer.loadFromGtfs`` looks the route up
      per trip and never checks for null. Blank or dangling ``agency_id``s are
      repaired for the same reason.
    * ``stops.txt`` — ``location_type`` 2, 3 and 4 (entrance, generic node,
      boarding area) dropped. R5 loads them as ordinary stops, and the spec lets
      them omit coordinates, which would put them at latitude NaN. A row that
      ``stop_times.txt`` actually references is kept regardless: R5 resolves
      stop ids through a map that returns index 0 for a miss, so a dangling
      reference would silently attach trips to the wrong stop.
    * ``transfers.txt`` — rows referencing a dropped stop removed. Types 4 and
      5 (in-seat transfers) are left alone: R5's ``GtfsTransferLoader`` counts
      and skips them, it does not fail.

    Everything else — calendar, calendar_dates, agency, feed_info, shapes,
    pathways, levels — is copied byte for byte. ``feed_info.txt`` and
    ``frequencies.txt`` are optional for R5 and need no repair.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"gtfs-r5-v{SANITISER_VERSION}-{file_digest(src_zip)}.zip"
    if dest.exists():
        log.info("using cached sanitised GTFS %s (%.0f MB)", dest.name, dest.stat().st_size / 1e6)
        return dest

    log.info("sanitising %s for R5 -> %s", src_zip.name, dest.name)
    started = time.monotonic()
    tmp = dest.with_suffix(".zip.part")
    with zipfile.ZipFile(src_zip) as src:
        names = [n for n in src.namelist() if not n.endswith("/")]
        # compresslevel=1: this zip is a local cache read once by R5, and
        # stop_times.txt is big enough that deflate time dominates the step.
        # allowZip64=True (the default, made explicit): required for members
        # and an archive that exceed the classic 4 GB zip limit.
        with zipfile.ZipFile(
            tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True
        ) as out:
            dropped_routes = _sanitise_routes(src, out)

            dropped_trips: set[str] = set()
            kept_trips = 0
            if "trips.txt" in names:
                rows = _read_rows(src, "trips.txt")
                with _member_writer(out, "trips.txt", list(next(rows))) as writer:
                    for row in rows:
                        if row.get("route_id") in dropped_routes:
                            dropped_trips.add(row["trip_id"])
                            continue
                        kept_trips += 1
                        writer.writerow(row)

            used_stops: set[str] = set()
            dropped_times = kept_times = 0
            if "stop_times.txt" in names:
                rows = _read_rows(src, "stop_times.txt")
                with _member_writer(out, "stop_times.txt", list(next(rows))) as writer:
                    for row in rows:
                        if row.get("trip_id") in dropped_trips:
                            dropped_times += 1
                            continue
                        used_stops.add(row["stop_id"])
                        kept_times += 1
                        writer.writerow(row)

            dropped_stops: set[str] = set()
            if "stops.txt" in names:
                rows = _read_rows(src, "stops.txt")
                with _member_writer(out, "stops.txt", list(next(rows))) as writer:
                    for row in rows:
                        location_type = (row.get("location_type") or "0").strip() or "0"
                        if location_type not in ("0", "1") and row["stop_id"] not in used_stops:
                            dropped_stops.add(row["stop_id"])
                            continue
                        writer.writerow(row)

            dropped_transfers = 0
            if "transfers.txt" in names and dropped_stops:
                rows = _read_rows(src, "transfers.txt")
                with _member_writer(out, "transfers.txt", list(next(rows))) as writer:
                    for row in rows:
                        if row.get("from_stop_id") in dropped_stops or row.get("to_stop_id") in dropped_stops:
                            dropped_transfers += 1
                            continue
                        writer.writerow(row)

            dropped_freqs = 0
            if "frequencies.txt" in names and dropped_trips:
                rows = _read_rows(src, "frequencies.txt")
                with _member_writer(out, "frequencies.txt", list(next(rows))) as writer:
                    for row in rows:
                        if row.get("trip_id") in dropped_trips:
                            dropped_freqs += 1
                            continue
                        writer.writerow(row)

            rewritten = set(out.namelist())
            for name in names:
                if name in rewritten:
                    continue
                # Streamed: shapes.txt alone can be hundreds of megabytes.
                # force_zip64: some members (e.g. stop_times.txt) exceed 4 GB
                # uncompressed, which overflows the classic zip size field.
                with src.open(name) as raw, out.open(name, "w", force_zip64=True) as copy:
                    shutil.copyfileobj(raw, copy, length=1 << 20)

    tmp.replace(dest)
    log.info(
        "sanitised in %.0f s: dropped %d routes, %d trips, %d stop_times rows, "
        "%d stops, %d transfers, %d frequencies; kept %d trips and %d stop_times rows",
        time.monotonic() - started, len(dropped_routes), len(dropped_trips), dropped_times,
        len(dropped_stops), dropped_transfers, dropped_freqs, kept_trips, kept_times,
    )
    return dest


# --------------------------------------------------------------------------
# representative dates
# --------------------------------------------------------------------------


def easter(year: int) -> dt.date:
    """Gregorian Easter Sunday (anonymous computus)."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    ll = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * ll) // 451
    month = (h + ll - 7 * m + 114) // 31
    day = ((h + ll - 7 * m + 114) % 31) + 1
    return dt.date(year, month, day)


def ch_holidays(year: int) -> set[dt.date]:
    """Swiss national holidays, plus the days most cantons also close.

    Not exhaustive (cantonal holidays vary), but enough to keep a "typical
    weekday" sample off a day the timetable runs a Sunday service on.
    """
    e = easter(year)
    return {
        dt.date(year, 1, 1),
        dt.date(year, 1, 2),
        e - dt.timedelta(days=2),  # Good Friday
        e + dt.timedelta(days=1),  # Easter Monday
        e + dt.timedelta(days=39),  # Ascension
        e + dt.timedelta(days=50),  # Whit Monday
        dt.date(year, 8, 1),
        dt.date(year, 12, 24),
        dt.date(year, 12, 25),
        dt.date(year, 12, 26),
        dt.date(year, 12, 31),
    }


def _is_blackout(day: dt.date) -> bool:
    if day in ch_holidays(day.year):
        return True
    # Christmas / New Year fortnight: reduced and special services everywhere.
    return (day.month, day.day) >= (12, 20) or (day.month, day.day) <= (1, 6)


def gtfs_validity(gtfs_zip: Path) -> tuple[dt.date, dt.date]:
    """Overall service window of the feed, from calendar.txt / calendar_dates.txt."""

    def rows(zf: zipfile.ZipFile, name: str):
        with zf.open(name) as raw:
            yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))

    stamps: list[str] = []
    with zipfile.ZipFile(gtfs_zip) as zf:
        names = set(zf.namelist())
        if "calendar.txt" in names:
            for row in rows(zf, "calendar.txt"):
                stamps += [row["start_date"], row["end_date"]]
        elif "calendar_dates.txt" in names:
            stamps += [row["date"] for row in rows(zf, "calendar_dates.txt")]
    if not stamps:
        raise RuntimeError(f"{gtfs_zip} has neither calendar.txt nor calendar_dates.txt")
    to_date = lambda s: dt.datetime.strptime(s, "%Y%m%d").date()  # noqa: E731
    return to_date(min(stamps)), to_date(max(stamps))


def pick_dates(
    valid_from: dt.date, valid_to: dt.date, today: dt.date, day_types: list[int]
) -> dict[int, dt.date]:
    """One representative date per day type: the first non-blackout match at
    least a week out, clamped into the feed's validity window."""
    start = max(valid_from, today + dt.timedelta(days=7))
    if start > valid_to:
        start = valid_from
    dates: dict[int, dt.date] = {}
    for day_type in day_types:
        weekday = DAY_TYPE_WEEKDAY[day_type]
        day = start + dt.timedelta(days=(weekday - start.weekday()) % 7)
        while day <= valid_to and _is_blackout(day):
            day += dt.timedelta(days=7)
        if day > valid_to:
            raise RuntimeError(
                f"no usable {DAY_TYPE_NAMES[day_type]} date in {valid_from}..{valid_to}"
            )
        dates[day_type] = day
    return dates


# --------------------------------------------------------------------------
# routing
# --------------------------------------------------------------------------


def build_network(osm_pbf: Path, gtfs_zip: Path):
    from r5py import TransportNetwork

    log.info("building R5 network from %s + %s (several minutes)", osm_pbf.name, gtfs_zip.name)
    started = time.monotonic()
    network = TransportNetwork(str(osm_pbf), [str(gtfs_zip)])
    log.info("network built in %.0f s", time.monotonic() - started)
    return network


def points_frame(stops: list[dict]):
    import geopandas
    import shapely

    return geopandas.GeoDataFrame(
        {"id": [str(s["id"]) for s in stops]},
        geometry=[shapely.Point(s["lon"], s["lat"]) for s in stops],
        crs="EPSG:4326",
    )


def travel_times(
    network,
    origins,
    destinations,
    departure: dt.datetime,
    window_min: int,
    max_time_min: int,
) -> np.ndarray:
    """Median travel time in minutes, shape (len(origins), len(destinations)).

    ``departure_time_window`` makes R5 depart every minute of the window and
    report the median over those departures, so the returned time includes the
    typical wait for the next service. Unreachable pairs come back as NaN.
    """
    from r5py import TransportMode, TravelTimeMatrix

    import pandas

    matrix = TravelTimeMatrix(
        network,
        origins=origins,
        destinations=destinations,
        transport_modes=[TransportMode.TRANSIT],
        departure=departure,
        departure_time_window=dt.timedelta(minutes=window_min),
        max_time=dt.timedelta(minutes=max_time_min),
        percentiles=[50],
        snap_to_network=True,
    )
    # Step out of the r5py/geopandas subclass before reshaping.
    long = pandas.DataFrame(matrix)[["from_id", "to_id", "travel_time"]]
    wide = long.pivot(index="from_id", columns="to_id", values="travel_time").reindex(
        index=origins["id"], columns=destinations["id"]
    )
    return wide.to_numpy(dtype=float)


# --------------------------------------------------------------------------
# checkpoints
# --------------------------------------------------------------------------


def checkpoint_path(root: Path, home_id: int, day_type: int) -> Path:
    return root / f"{home_id}_d{day_type}.npz"


def checkpoint_hours(path: Path) -> set[int]:
    """Hours already computed in a checkpoint, without decompressing the data.

    ``numpy`` decompresses npz members lazily, so this reads the tiny ``hours``
    array only — cheap enough to call once per (home, day type) at startup.
    """
    if not path.exists():
        return set()
    try:
        with np.load(path) as npz:
            return {int(h) for h in npz["hours"]}
    except (OSError, ValueError, KeyError):
        return set()


def load_checkpoint(path: Path, stop_count: int) -> dict[int, np.ndarray]:
    """Hour -> minutes array, for the hours already computed."""
    if not path.exists():
        return {}
    try:
        with np.load(path) as npz:
            hours, minutes = npz["hours"], npz["minutes"]
    except (OSError, ValueError, KeyError) as exc:
        log.warning("ignoring unreadable checkpoint %s (%s)", path.name, exc)
        return {}
    if minutes.shape[1] != stop_count:
        log.warning("ignoring checkpoint %s: %d stops, expected %d",
                    path.name, minutes.shape[1], stop_count)
        return {}
    return {int(h): minutes[i] for i, h in enumerate(hours)}


def save_checkpoint(path: Path, by_hour: dict[int, np.ndarray], date: dt.date) -> None:
    hours = sorted(by_hour)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".npz.part")
    # Write through a handle: np.savez_compressed would append ".npz" to a path.
    with tmp.open("wb") as fh:
        np.savez_compressed(
            fh,
            hours=np.array(hours, dtype=np.int16),
            minutes=np.stack([by_hour[h] for h in hours]).astype(np.uint16),
            date=np.array(date.isoformat()),
        )
    tmp.replace(path)


# --------------------------------------------------------------------------
# driver
# --------------------------------------------------------------------------


def parse_hours(spec: str) -> list[int]:
    """``"6-21"``, ``"6,12,18"`` or a mix, clamped to the header's hour range."""
    hours: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo, hi = (int(x) for x in part.split("-", 1))
            hours += list(range(lo, hi + 1))
        else:
            hours.append(int(part))
    hours = sorted({h for h in hours if HOUR_START <= h < HOUR_START + HOUR_COUNT})
    if not hours:
        raise ValueError(f"no hour in {HOUR_START}..{HOUR_START + HOUR_COUNT - 1} in {spec!r}")
    return hours


def write_tables(
    out_dir: Path,
    root: Path,
    homes: list[int],
    build_id: str,
    stop_count: int,
    also_plain: bool = False,
) -> int:
    """Assemble every checkpoint for each home into one .bin. Missing day types
    and hours are written as unreachable, so a partial (tiered) build still
    produces a table the widget can use."""
    out_dir.mkdir(parents=True, exist_ok=True)
    written = 0
    for home_id in homes:
        minutes = np.full((DAY_TYPES, HOUR_COUNT, stop_count), UNREACHABLE, dtype=np.uint16)
        filled = 0
        for day_type in range(DAY_TYPES):
            for hour, values in load_checkpoint(checkpoint_path(root, home_id, day_type), stop_count).items():
                minutes[day_type, hour - HOUR_START] = values
                filled += 1
        if filled == 0:
            log.warning("home %d has no computed cell — skipping", home_id)
            continue
        write_table_files(
            out_dir / f"{home_id}.bin", encode_table(home_id, build_id, minutes), also_plain
        )
        written += 1
        if filled < DAY_TYPES * HOUR_COUNT:
            log.info("home %d: %d/%d cells computed", home_id, filled, DAY_TYPES * HOUR_COUNT)
    log.info("wrote %d tables to %s", written, out_dir)
    return written


def selftest(out_dir: Path, stop_count: int = 500, seed: int = 7) -> int:
    """Write, then re-read, a small random table — exercises the binary format
    end to end without r5py, a network, or any downloaded input."""
    rng = random.Random(seed)
    build_id = "2026-09-11-deadbeef"
    home_id = 8503000
    minutes = np.array(
        [rng.choice([rng.randrange(0, 300), UNREACHABLE]) for _ in range(DAY_TYPES * HOUR_COUNT * stop_count)],
        dtype=np.uint16,
    ).reshape(DAY_TYPES, HOUR_COUNT, stop_count)

    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{home_id}.bin"
    write_table_files(path, encode_table(home_id, build_id, minutes), also_plain=True)

    gz_path = path.with_suffix(".bin.gz")
    blob = gzip.decompress(gz_path.read_bytes())
    assert blob == path.read_bytes(), "gzip and plain copies disagree"
    magic, version, day_types, hour_start, hour_count, count, hid, bid = HEADER_STRUCT.unpack_from(blob)
    assert magic == MAGIC, magic
    assert (version, day_types, hour_start, hour_count) == (VERSION, DAY_TYPES, HOUR_START, HOUR_COUNT)
    assert count == stop_count and hid == home_id
    assert bid.rstrip(b"\0").decode("ascii") == build_id[:BUILD_ID_BYTES]
    body = np.frombuffer(blob, dtype="<u2", offset=HEADER_STRUCT.size)
    assert len(blob) == HEADER_STRUCT.size + 2 * DAY_TYPES * HOUR_COUNT * stop_count, len(blob)
    assert np.array_equal(body.reshape(minutes.shape), minutes)
    log.info(
        "selftest OK: %s, %d bytes (%d gzipped), round-trip exact",
        gz_path, len(blob), gz_path.stat().st_size,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--out-dir", type=Path, help=f"where the .bin.gz files go (default {OUT_DIR})")
    parser.add_argument("--also-plain", action="store_true",
                        help="also write the uncompressed <homeId>.bin fallback")
    parser.add_argument("--homes", type=Path, default=HOMES_PATH, help="homes.txt path")
    parser.add_argument("--homes-limit", type=int, help="only the first N homes (tiering)")
    parser.add_argument("--hours", default=f"{HOUR_START}-{HOUR_START + HOUR_COUNT - 1}",
                        help="departure hours, e.g. '6-21' or '9,12,15'")
    parser.add_argument("--day-types", default="0,1,2",
                        help="day types to compute: 0 = Mon-Fri, 1 = Sat, 2 = Sun/holiday")
    parser.add_argument("--home-batch", type=int, default=100,
                        help="homes (= origins) per r5py call; R5 runs one search "
                             "per origin, so the batch size trades result-frame "
                             "memory (batch x 34k rows) against call overhead")
    parser.add_argument("--departure-window-min", type=int, default=60,
                        help="departure window R5 takes the median over")
    parser.add_argument("--max-time-min", type=int, default=180, help="routing cut-off")
    parser.add_argument("--time-budget-min", type=float,
                        help="stop cleanly after this many minutes (checkpoints are kept)")
    parser.add_argument("--gtfs", type=Path, default=DOWNLOAD_DIR / "gtfs_ch.zip")
    parser.add_argument("--gtfs-cache", type=Path, default=GTFS_CACHE_DIR,
                        help="where the R5-safe copy of the GTFS is kept")
    parser.add_argument("--osm", type=Path, default=DOWNLOAD_DIR / "switzerland-latest.osm.pbf")
    parser.add_argument("--refresh", action="store_true", help="re-download GTFS and OSM")
    parser.add_argument("--max-memory", help="passed to r5py, e.g. '6G' or '80%%'")
    parser.add_argument("--today", type=dt.date.fromisoformat, default=dt.date.today(),
                        help="reference date for picking representative days")
    parser.add_argument("--selftest", action="store_true",
                        help="write and verify a tiny random table; no r5py, no downloads")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.selftest:
        # Never scribble a fake table over a real one.
        return selftest(args.out_dir or CACHE_DIR / "selftest")
    out_dir = args.out_dir or OUT_DIR

    if args.max_memory:
        # r5py reads its own arguments off sys.argv at import time.
        sys.argv += ["--max-memory", args.max_memory]
    if "JAVA_TOOL_OPTIONS" not in os.environ:
        log.info("JAVA_TOOL_OPTIONS is unset; r5py will grant the JVM up to 80% of RAM")

    started = time.monotonic()
    deadline = started + args.time_budget_min * 60 if args.time_budget_min else None

    hours = parse_hours(args.hours)
    day_types = sorted({int(d) for d in args.day_types.split(",") if d.strip() != ""})
    if any(d not in DAY_TYPE_WEEKDAY for d in day_types):
        parser.error(f"--day-types must be a subset of {sorted(DAY_TYPE_WEEKDAY)}")

    stops = load_stops()
    build_id = load_build_id()
    homes = read_homes(args.homes)
    known = {s["id"] for s in stops}
    unknown = [h for h in homes if h not in known]
    if unknown:
        log.warning("%d homes are not in stops.json.gz and are dropped: %s", len(unknown), unknown[:10])
        homes = [h for h in homes if h in known]
    if args.homes_limit:
        homes = homes[: args.homes_limit]
    log.info("buildId %s: %d stops, %d homes, day types %s, hours %s",
             build_id, len(stops), len(homes), day_types, hours)

    gtfs = download(GTFS_URL, args.gtfs, args.refresh)
    osm = download(OSM_URL, args.osm, args.refresh)
    osm = crop_osm(osm, args.osm.with_name("switzerland-ch-bbox.osm.pbf"), args.refresh)
    # R5 routes on the sanitised copy; everything else — validity window,
    # checkpoint directory — keys off the original file.
    routable_gtfs = sanitise_gtfs(gtfs, args.gtfs_cache)

    valid_from, valid_to = gtfs_validity(gtfs)
    dates = pick_dates(valid_from, valid_to, args.today, day_types)
    log.info("GTFS valid %s..%s; sampling %s", valid_from, valid_to,
             {DAY_TYPE_NAMES[d]: dates[d].isoformat() for d in day_types})

    # Checkpoints are only valid for one (stop list, timetable) pair: the stop
    # list fixes the index, the timetable fixes the numbers.
    # The "h2s" prefix marks the home -> stop direction: checkpoints from the
    # earlier stop -> home builds hold different numbers and must not be reused.
    root = CACHE_DIR / f"h2s-{build_id}-{file_digest(gtfs)}"
    root.mkdir(parents=True, exist_ok=True)
    (root / "dates.json").write_text(
        json.dumps({DAY_TYPE_NAMES[d]: dates[d].isoformat() for d in day_types}, indent=2) + "\n",
        encoding="utf-8",
    )

    by_id = {s["id"]: s for s in stops}
    done = {
        (home, d): checkpoint_hours(checkpoint_path(root, home, d))
        for home in homes
        for d in day_types
    }
    batches = [homes[i : i + args.home_batch] for i in range(0, len(homes), args.home_batch)]
    todo = [
        (d, h, batch)
        for d in day_types
        for batch in batches
        for h in hours
        if any(h not in done[(home, d)] for home in batch)
    ]
    budget_hit = False
    if not todo:
        log.info("every requested cell is already checkpointed")
    else:
        network = build_network(osm, routable_gtfs)
        destinations = points_frame(stops)
        for day_type, hour, batch in todo:
            if deadline and time.monotonic() > deadline:
                log.warning("time budget reached — stopping with checkpoints intact")
                budget_hit = True
                break
            pending = [home for home in batch if hour not in done[(home, day_type)]]
            if not pending:
                continue
            departure = dt.datetime.combine(dates[day_type], dt.time(hour, 0))
            cell_started = time.monotonic()
            values = travel_times(
                network,
                points_frame([by_id[h] for h in pending]),
                destinations,
                departure,
                args.departure_window_min,
                args.max_time_min,
            )
            minutes = minutes_from_travel_times(values)
            for row, home in enumerate(pending):
                path = checkpoint_path(root, home, day_type)
                by_hour = load_checkpoint(path, len(stops))
                by_hour[hour] = minutes[row]
                save_checkpoint(path, by_hour, dates[day_type])
                done[(home, day_type)].add(hour)
            log.info(
                "%s %02d:00, %d homes: %.0f s, %.1f%% reachable",
                DAY_TYPE_NAMES[day_type], hour, len(pending),
                time.monotonic() - cell_started,
                100.0 * np.mean(minutes != UNREACHABLE),
            )

    written = write_tables(out_dir, root, homes, build_id, len(stops), args.also_plain)
    log.info("done in %.1f min; %d tables", (time.monotonic() - started) / 60, written)
    if budget_hit:
        log.warning("build is INCOMPLETE — re-run with the same cache to continue")
    return 0


if __name__ == "__main__":
    sys.exit(main())
