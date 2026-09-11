#!/usr/bin/env python3
"""Build web/public/data/stops.json.gz from the Swiss service point (DiDok) export.

Source: opentransportdata.swiss dataset "service-point-v2", resource
``actual-date-swiss-service-point.csv`` (all service point versions valid today).
No API key required.

The script is idempotent and reproducible: running it twice produces a
byte-identical ``stops.json.gz`` and a ``meta.json`` that differs only in
``builtAt``.

Usage:
    uv run build_stops.py                 # download if missing, then build
    uv run build_stops.py --refresh       # force a fresh CSV download
    uv run build_stops.py --no-dem        # skip DEM sampling (drops stops
                                          # without a plausible CSV height)
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import logging
import sys
from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).resolve().parent
DOWNLOAD_DIR = DATA_DIR / "downloads"
CACHE_DIR = DATA_DIR / "cache"
DEM_DIR = CACHE_DIR / "dem"
OUT_DIR = DATA_DIR.parent / "web" / "public" / "data"

SOURCE_DATASET = "opentransportdata.swiss / service-point-v2 (actual-date-swiss-service-point.csv)"
SOURCE_URL = (
    "https://data.opentransportdata.swiss/dataset/39e5f264-257a-4f3f-bccc-5322c37058c5"
    "/resource/3ad3dff4-5022-40b4-b770-33c520d12191/download/actual-date-swiss-service-point.csv"
)
CSV_NAME = "actual-date-swiss-service-point.csv"

DEM_SOURCE = "Copernicus GLO-30 DSM (COG) via https://copernicus-dem-30m.s3.amazonaws.com"
DEM_URL_TEMPLATE = (
    "https://copernicus-dem-30m.s3.amazonaws.com/"
    "Copernicus_DSM_COG_10_{tile}_DEM/Copernicus_DSM_COG_10_{tile}_DEM.tif"
)

# Mode bitmask required by the widget.
MODE_RAIL, MODE_BUS, MODE_TRAM, MODE_BOAT, MODE_CABLEWAY, MODE_METRO = 1, 2, 4, 8, 16, 32

# meansOfTransport is a "|"-separated enum list in the CSV.
MEANS_TO_BIT = {
    "TRAIN": MODE_RAIL,
    "RACK_RAILWAY": MODE_RAIL,
    "BUS": MODE_BUS,
    "TRAM": MODE_TRAM,
    "BOAT": MODE_BOAT,
    "CABLE_CAR": MODE_CABLEWAY,
    "CHAIRLIFT": MODE_CABLEWAY,
    "CABLE_RAILWAY": MODE_CABLEWAY,
    "ELEVATOR": MODE_CABLEWAY,
    "METRO": MODE_METRO,
    "UNKNOWN": 0,
}

# Stop points flagged this way are not served; everything else (including a
# missing type, which is normal for foreign stops) counts as passenger service.
EXCLUDED_STOP_POINT_TYPES = {"OUT_OF_ORDER"}

HEIGHT_MIN, HEIGHT_MAX = 200.0, 3500.0
BORDER_KM = 20.0
EARTH_R_KM = 6371.0088

log = logging.getLogger("build_stops")


def download_csv(path: Path, refresh: bool) -> None:
    if path.exists() and not refresh:
        log.info("using cached CSV %s (%.1f MB)", path, path.stat().st_size / 1e6)
        return
    import requests

    log.info("downloading %s", SOURCE_URL)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".csv.part")
    with requests.get(SOURCE_URL, stream=True, timeout=300) as resp:
        resp.raise_for_status()
        with tmp.open("wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                fh.write(chunk)
    tmp.replace(path)
    log.info("downloaded %.1f MB to %s", path.stat().st_size / 1e6, path)


def parse_modes(value: object) -> int:
    if not isinstance(value, str) or not value:
        return 0
    bits = 0
    for token in value.split("|"):
        token = token.strip()
        if token in MEANS_TO_BIT:
            bits |= MEANS_TO_BIT[token]
        elif token:
            log.debug("unmapped meansOfTransport token %r", token)
    return bits


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


def load_stops(csv_path: Path, today: dt.date) -> pd.DataFrame:
    df = pd.read_csv(csv_path, sep=";", dtype=str, encoding="utf-8-sig", low_memory=False)
    log.info("CSV rows: %d, columns: %d", len(df), len(df.columns))
    log.info(
        "mapped columns: number->id, designationOfficial->n, wgs84North->lat, "
        "wgs84East->lon, height->e (csv), meansOfTransport->m; filters use "
        "status, stopPoint, stopPointType, hasGeolocation, validFrom, validTo, isoCountryCode"
    )
    missing = [
        c
        for c in (
            "number",
            "designationOfficial",
            "wgs84North",
            "wgs84East",
            "height",
            "meansOfTransport",
            "status",
            "stopPoint",
            "stopPointType",
            "hasGeolocation",
            "validFrom",
            "validTo",
            "isoCountryCode",
        )
        if c not in df.columns
    ]
    if missing:
        raise SystemExit(f"CSV header changed, missing columns: {missing}")

    def keep(mask: pd.Series, label: str, frame: pd.DataFrame) -> pd.DataFrame:
        out = frame[mask]
        log.info("filter %-28s %6d -> %6d", label, len(frame), len(out))
        return out

    df = keep(df["status"].eq("VALIDATED"), "status == VALIDATED", df)
    df = keep(df["stopPoint"].eq("true"), "stopPoint == true", df)
    df = keep(
        ~df["stopPointType"].fillna("").isin(EXCLUDED_STOP_POINT_TYPES),
        "stopPointType usable",
        df,
    )
    df = keep(df["hasGeolocation"].eq("true"), "hasGeolocation == true", df)

    today_s = today.isoformat()
    df = keep(
        df["validFrom"].fillna("0000-01-01").le(today_s)
        & df["validTo"].fillna("9999-12-31").ge(today_s),
        "valid today",
        df,
    )

    df = df.assign(
        id=pd.to_numeric(df["number"], errors="coerce"),
        lat=pd.to_numeric(df["wgs84North"], errors="coerce"),
        lon=pd.to_numeric(df["wgs84East"], errors="coerce"),
        csv_height=pd.to_numeric(df["height"], errors="coerce"),
        m=df["meansOfTransport"].map(parse_modes),
        n=df["designationOfficial"].fillna("").str.strip(),
    )
    df = keep(
        df["id"].notna() & df["lat"].notna() & df["lon"].notna() & df["n"].ne(""),
        "id/coords/name present",
        df,
    )
    df = keep(df["lat"].between(-90, 90) & df["lon"].between(-180, 180), "coords in range", df)

    before = len(df)
    df = df.sort_values("id").drop_duplicates(subset="id", keep="first")
    log.info("filter %-28s %6d -> %6d", "dedup by DiDok number", before, len(df))

    return df[["id", "n", "lat", "lon", "csv_height", "m", "isoCountryCode"]].reset_index(drop=True)


def filter_to_ch_and_border(df: pd.DataFrame) -> pd.DataFrame:
    """Keep CH stops, plus foreign stops within BORDER_KM of any CH stop."""
    from scipy.spatial import cKDTree

    is_ch = df["isoCountryCode"].eq("CH")
    ch = df[is_ch]
    foreign = df[~is_ch]
    log.info("country split: CH %d, foreign %d", len(ch), len(foreign))
    if ch.empty or foreign.empty:
        return df

    tree = cKDTree(to_xyz(ch["lat"].to_numpy(), ch["lon"].to_numpy()))
    # Chord length is <= great-circle distance, so a chord radius of BORDER_KM
    # is a slightly conservative 20 km test (0.005% tighter at this scale).
    dist, _ = tree.query(to_xyz(foreign["lat"].to_numpy(), foreign["lon"].to_numpy()), k=1)
    near = foreign[dist <= BORDER_KM]
    log.info(
        "border filter: %d foreign stops -> %d within %.0f km of a CH stop",
        len(foreign),
        len(near),
        BORDER_KM,
    )
    for code, count in near["isoCountryCode"].value_counts().items():
        log.info("  kept %-4s %5d", code, count)
    out = pd.concat([ch, near]).sort_values("id").reset_index(drop=True)
    log.info("after country/border filter: %d stops", len(out))
    return out


def dem_tile_name(lat: float, lon: float) -> str:
    la, lo = int(np.floor(lat)), int(np.floor(lon))
    ns = "N" if la >= 0 else "S"
    ew = "E" if lo >= 0 else "W"
    return f"{ns}{abs(la):02d}_00_{ew}{abs(lo):03d}_00"


def fetch_dem_tile(tile: str) -> Path | None:
    import requests

    DEM_DIR.mkdir(parents=True, exist_ok=True)
    path = DEM_DIR / f"Copernicus_DSM_COG_10_{tile}_DEM.tif"
    missing_marker = DEM_DIR / f"{tile}.missing"
    if path.exists():
        return path
    if missing_marker.exists():
        return None
    url = DEM_URL_TEMPLATE.format(tile=tile)
    log.info("downloading DEM tile %s", tile)
    tmp = path.with_suffix(".part")
    with requests.get(url, stream=True, timeout=600) as resp:
        if resp.status_code == 404:
            log.warning("DEM tile %s not available (404), treating as sea level", tile)
            missing_marker.touch()
            return None
        resp.raise_for_status()
        with tmp.open("wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 22):
                fh.write(chunk)
    tmp.replace(path)
    log.info("DEM tile %s: %.1f MB", tile, path.stat().st_size / 1e6)
    return path


def sample_dem(lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    """Sample Copernicus GLO-30 for the given points; NaN where unavailable."""
    import rasterio

    out = np.full(len(lats), np.nan)
    tiles = np.array([dem_tile_name(la, lo) for la, lo in zip(lats, lons)])
    for tile in sorted(set(tiles.tolist())):
        idx = np.flatnonzero(tiles == tile)
        path = fetch_dem_tile(tile)
        if path is None:
            out[idx] = 0.0  # ocean tiles are not published
            continue
        with rasterio.open(path) as src:
            nodata = src.nodata
            values = np.array(
                [v[0] for v in src.sample(list(zip(lons[idx], lats[idx])), indexes=1)],
                dtype="float64",
            )
        if nodata is not None:
            values[values == nodata] = np.nan
        values[values < -500] = np.nan
        out[idx] = values
        log.info("DEM tile %s: sampled %d points", tile, len(idx))
    return out


def resolve_elevation(df: pd.DataFrame, use_dem: bool) -> pd.DataFrame:
    plausible = df["csv_height"].between(HEIGHT_MIN, HEIGHT_MAX)
    df = df.assign(
        elev=np.where(plausible, df["csv_height"], np.nan),
        elevSource=np.where(plausible, "csv", "dem"),
    )
    need = df.index[~plausible]
    log.info(
        "elevation: %d from CSV height, %d need the DEM (missing or outside %.0f-%.0f m)",
        int(plausible.sum()),
        len(need),
        HEIGHT_MIN,
        HEIGHT_MAX,
    )
    if len(need) == 0:
        return df
    if not use_dem:
        log.warning("--no-dem: dropping %d stops without a plausible CSV height", len(need))
        return df.drop(index=need)

    sampled = sample_dem(df.loc[need, "lat"].to_numpy(), df.loc[need, "lon"].to_numpy())
    df.loc[need, "elev"] = sampled
    bad = df.index[df["elev"].isna()]
    if len(bad):
        log.warning("dropping %d stops with no usable elevation from CSV or DEM", len(bad))
        df = df.drop(index=bad)
    return df


def write_outputs(df: pd.DataFrame, out_dir: Path, dem_used: bool) -> tuple[int, int, str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    records = [
        {
            "id": int(r.id),
            "n": r.n,
            "lat": round(float(r.lat), 5),
            "lon": round(float(r.lon), 5),
            "e": int(round(float(r.elev))),
            "m": int(r.m),
        }
        for r in df.sort_values("id").itertuples()
    ]
    payload = json.dumps(records, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()

    stops_path = out_dir / "stops.json.gz"
    with stops_path.open("wb") as fh:
        # mtime=0 so repeated builds are byte-identical.
        with gzip.GzipFile(fileobj=fh, mode="wb", compresslevel=9, mtime=0) as gz:
            gz.write(payload)

    now = dt.datetime.now(dt.timezone.utc)
    build_id = f"{now.date().isoformat()}-{digest[:8]}"
    meta = {
        "buildId": build_id,
        "builtAt": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "sourceUrl": SOURCE_URL,
        "sourceDataset": SOURCE_DATASET,
        "count": len(records),
        "demSource": DEM_SOURCE if dem_used else "none",
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return len(payload), stops_path.stat().st_size, build_id


def write_debug(df: pd.DataFrame) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / "stops_debug.csv"
    debug = df.sort_values("id")[
        ["id", "n", "lat", "lon", "elev", "elevSource", "csv_height", "m", "isoCountryCode"]
    ].copy()
    debug["id"] = debug["id"].astype("int64")
    debug["elev"] = debug["elev"].round(1)
    debug.to_csv(path, index=False)
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--csv", type=Path, default=DOWNLOAD_DIR / CSV_NAME, help="service point CSV path")
    parser.add_argument("--refresh", action="store_true", help="re-download the CSV even if cached")
    parser.add_argument("--no-dem", action="store_true", help="do not sample a DEM for missing heights")
    parser.add_argument("--out-dir", type=Path, default=OUT_DIR, help="output directory")
    parser.add_argument(
        "--today",
        type=dt.date.fromisoformat,
        default=dt.date.today(),
        help="validity reference date (YYYY-MM-DD), for reproducible rebuilds",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    download_csv(args.csv, args.refresh)
    df = load_stops(args.csv, args.today)
    df = filter_to_ch_and_border(df)
    df = resolve_elevation(df, use_dem=not args.no_dem)

    from_dem = int((df["elevSource"] == "dem").sum())
    raw_bytes, gz_bytes, build_id = write_outputs(df, args.out_dir, dem_used=not args.no_dem)
    debug_path = write_debug(df)

    log.info("buildId %s", build_id)
    log.info("stops: %d (%d elevations from DEM, %d from CSV)", len(df), from_dem, len(df) - from_dem)
    log.info("modes: %s", {int(k): int(v) for k, v in df["m"].value_counts().sort_index().items()})
    log.info("json %.2f MB -> gz %.2f MB", raw_bytes / 1e6, gz_bytes / 1e6)
    log.info("wrote %s and %s", args.out_dir / "stops.json.gz", args.out_dir / "meta.json")
    log.info("debug CSV: %s", debug_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
