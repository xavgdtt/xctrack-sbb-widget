# `data/` — stop dataset ETL (Phase 1)

Builds `web/public/data/stops.json.gz` + `meta.json`: every Swiss public-transport
stop plus foreign stops within 20 km of the Swiss border, with coordinates,
elevation and a mode bitmask.

## How to run

Python 3.12 via [uv](https://docs.astral.sh/uv/). All commands run from `data/`.

```bash
uv sync                       # once
uv run build_stops.py         # download (if needed) + build the dataset
uv run build_stops.py --refresh   # force a fresh CSV download
uv run verify_ids.py --ch-only --connections 20 --json cache/verify_ids_ch.json
```

`build_stops.py` is idempotent and reproducible: two consecutive runs on the same
input CSV produce a byte-identical `stops.json.gz` (gzip level 9, `mtime=0`); only
`builtAt` in `meta.json` changes. `--today YYYY-MM-DD` pins the validity reference
date so an old CSV can be rebuilt exactly.

Downloads land in `downloads/` (source CSV, 26 MB) and `cache/dem/` (DEM tiles,
~560 MB). Both are gitignored.

## Data sources

| What | URL | Key | Licence |
|---|---|---|---|
| Service points (DiDok/ATLAS), all versions valid today | `https://data.opentransportdata.swiss/dataset/39e5f264-257a-4f3f-bccc-5322c37058c5/resource/3ad3dff4-5022-40b4-b770-33c520d12191/download/actual-date-swiss-service-point.csv` | none | [Terms of use opentransportdata.swiss](https://opentransportdata.swiss/en/terms-of-use/) (open data, attribution) |
| Dataset landing page | https://data.opentransportdata.swiss/dataset/service-point-v2 | none | — |
| Elevation: Copernicus GLO-30 DSM, COG tiles | `https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_<TILE>_DEM/...tif` | none | [Copernicus DEM licence](https://spacedata.copernicus.eu/documents/20123/121286/CSCDA_ESA_Mission-specific+Annex.pdf) (free, attribution: © DLR e.V. 2010-2014 / © Airbus Defence and Space GmbH) |
| Routing / id check | https://transport.opendata.ch/v1/ | none | CC-BY (search.ch timetable backend) |

The dataset that used to be called "Dienststellen (alle Versionen)" on
opentransportdata.swiss was retired; the current one is **`service-point-v2`**.
Its `actual-date-swiss-service-point.csv` resource downloads without an API key,
so the ATLAS export service (`export-service-point.prod.app.sbb.ch`) was not
needed. The CKAN JSON API on `data.opentransportdata.swiss` answers 403 to
scripted requests, but the resource download URL itself works.

## Pipeline

1. **Parse** the `;`-separated, UTF-8-BOM CSV (60,016 rows, 56 columns).
   Columns used: `number` → `id`, `designationOfficial` → `n`, `wgs84North` → `lat`,
   `wgs84East` → `lon`, `height` → `e`, `meansOfTransport` → `m`; filters use
   `status`, `stopPoint`, `stopPointType`, `hasGeolocation`, `validFrom`/`validTo`,
   `isoCountryCode`.
2. **Filter**: `status == VALIDATED`, `stopPoint == true` (drops operating points,
   signals, freight-only points), `stopPointType != OUT_OF_ORDER`,
   `hasGeolocation == true`, valid today, coordinates and name present, dedup by
   DiDok number.
3. **Geography**: keep all `isoCountryCode == CH`; keep a foreign stop when a CH
   stop lies within 20 km (scipy `cKDTree` on earth-centred cartesian coordinates,
   chord distance — marginally conservative against great-circle distance).
4. **Modes** bitmask: `rail=1` (`TRAIN`, `RACK_RAILWAY`), `bus=2` (`BUS`),
   `tram=4` (`TRAM`), `boat=8` (`BOAT`), `cableway=16` (`CABLE_CAR`, `CHAIRLIFT`,
   `CABLE_RAILWAY`, `ELEVATOR`), `metro=32` (`METRO`). `UNKNOWN` → `0`.
5. **Elevation**: CSV `height` when it is between 200 and 3500 m, otherwise a
   Copernicus GLO-30 sample. `elevSource` (`csv`|`dem`) is written to
   `cache/stops_debug.csv`, not to the output.

### Current build

34,362 stops: CH 26,914, DE 3,465, AT 1,922, FR 1,558, IT 267, LI 236.
Elevation: 32,975 from the CSV, 1,387 from the DEM. 2.93 MB JSON → 747 KB gzip.
Modes: bus 30,071, rail 1,776, cableway 1,227, bus+tram 433, boat 365,
tram 150, metro 6, unknown 280.

### Dataset surprises worth remembering

- The export is **not** Switzerland-only: 27,248 of the 54,162 valid stop points
  are in DE/AT/FR/IT/LI, many of them hundreds of km from the border (the export
  covers everything the Swiss timetable references). The 20 km filter removes
  19,800 of them.
- `height` is `0.0` rather than empty for most missing values, and 2,482 stop
  points have no height at all — hence the 200–3500 m plausibility gate rather
  than a null check.
- `stopPointType` is empty for roughly half the stop points (normal for foreign
  ones); only `OUT_OF_ORDER` is excluded.
- `meansOfTransport` is a `|`-separated list and is `UNKNOWN` for 5,585 rows.
- GLO-30 is a **surface** model, so a stop under trees or a roof can read a few
  metres high. The highest value in the output is 3,714 m (Matterhorn glacier
  paradise); the lowest is 193 m (Lago Maggiore).

## Id mapping to transport.opendata.ch (verified)

`verify_ids.py` samples 20 stops with a fixed seed, resolves each one through
`/v1/locations?x=<lat>&y=<lon>` (throttled ≥ 400 ms, no custom headers), and
routes some of them to Zürich HB (`8503000`).

**Finding: the DiDok `number` is exactly the transport.opendata.ch station id.**
Plain 7-digit decimal, no zero padding, no prefix — use `from=8507000` directly.
16 of 20 coordinate lookups returned the sampled DiDok as the nearest station with
an id; the other 4 returned a *different, co-located* stop (e.g. `8580925
Niederscherli, Bahnhof` vs. the API's nearest `8507086 Niederscherli` 27 m away).
That is a "which stop is nearest" artefact, not an id-format mismatch. 18 of the
20 sampled CH ids returned a real connection to Zürich HB.

**A name-based fallback is not worth building.** The stops that fail are stops the
API's timetable backend does not know at all, and searching them by name fails
too: `/v1/locations?query=Muttenz, Hagnau` returns only id-less address
suggestions, and three sampled foreign stops (`1103140 Oberteuringen, Teuringer
Str.`, `1400340 Annemasse, Lycée des Glières`, `1400961 Passy, Plaine-Joux`)
return nothing. Treat an empty `connections` array as "no service from this stop"
and rank it out.

Two further API details the widget must handle:

- `/v1/locations?x=&y=` mixes fuzzy `"<name> (Haltestelle)"` entries with
  `"id": null` into the result list, often as the *first* element. Always skip
  entries without an id.
- Rate limiting surfaces as HTTP 429 with
  `{"errors":[{"message":"Rate limit error from timetable.search.ch: Too many requests this minute"}]}`.

## Output format

`web/public/data/stops.json.gz` — gzip (level 9) of a JSON array sorted by `id`:

```json
[{"id":8507000,"n":"Bern","lat":46.94883,"lon":7.43913,"e":540,"m":1}]
```

| field | meaning |
|---|---|
| `id` | DiDok/UIC number, integer, also the transport.opendata.ch station id |
| `n` | official designation (UTF-8, not escaped) |
| `lat`, `lon` | WGS84, 5 decimals (~1 m) |
| `e` | elevation in metres, integer, always present |
| `m` | mode bitmask: rail 1, bus 2, tram 4, boat 8, cableway 16, metro 32 |

`web/public/data/meta.json`:

```json
{
  "buildId": "2026-09-11-4b9110db",
  "builtAt": "2026-09-11T19:20:37Z",
  "sourceUrl": "https://data.opentransportdata.swiss/.../actual-date-swiss-service-point.csv",
  "sourceDataset": "opentransportdata.swiss / service-point-v2 (actual-date-swiss-service-point.csv)",
  "count": 34362,
  "demSource": "Copernicus GLO-30 DSM (COG) via https://copernicus-dem-30m.s3.amazonaws.com"
}
```

`buildId` is the build date plus the first 8 hex digits of the SHA-256 of the
uncompressed stops JSON, so it changes only when the stop data changes. Phase 2
travel-time tables index into `stops.json.gz` by position and must carry the same
`buildId`.

Debug output (gitignored): `cache/stops_debug.csv` with `elevSource` and the raw
CSV height per stop; `cache/verify_ids*.json` with the raw API verification rows.
