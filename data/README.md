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

`web/public/data/stops.json` — the same bytes uncompressed (2.93 MB). `stops.ts`
fetches the gzip and falls back to this file where the WebView has no
`DecompressionStream`. Both are written by the same run, so they cannot drift.

| field | meaning |
|---|---|
| `id` | DiDok/UIC number, integer, also the transport.opendata.ch station id |
| `n` | official designation (UTF-8, not escaped) |
| `lat`, `lon` | WGS84, 5 decimals (~1 m) |
| `e` | elevation in metres, integer, always present |
| `m` | mode bitmask: rail 1, bus 2, tram 4, boat 8, cableway 16, metro 32 |

`web/public/data/stops.json` — the same array, uncompressed. The widget decodes
the `.gz` with `DecompressionStream('gzip')` (GitHub Pages serves `.gz` without a
`Content-Encoding` header) and falls back to this plain file where that API is
missing, so the build must emit both.

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
`buildId`. The table header holds only its first 16 characters, and `table.ts`
compares it truncated the same way, so `build_tables.py` must write
`buildId[:16]` into the header.

Debug output (gitignored): `cache/stops_debug.csv` with `elevSource` and the raw
CSV height per stop; `cache/verify_ids*.json` with the raw API verification rows.

---

# Phase 2 tables — `build_homes.py` + `build_tables.py`

Builds `web/public/data/tables/<homeId>.bin.gz`: for one home station, the median
travel time (including the wait for the next service) between the home and
*every* stop in `stops.json.gz`, for 3 day types × 16 departure hours. With the
table cached the widget ranks stops offline, instead of guessing with
`distance / 50 km/h + penalties`.

## Direction: the tables are computed home → stop

The widget needs *stop → home*, but `build_tables.py` computes *home → stop* and
uses it in both directions. R5 runs one search per origin, so with the homes as
origins a pass costs 100 searches instead of 34,362 — the whole build is about
100× cheaper, which is what makes the full grid a single CI run.

The approximation is good but not exact:

- **Riding time is close to symmetric.** The same lines run both ways, and the
  Swiss timetable is built around symmetric clock-face patterns.
- **The initial wait is measured at the wrong end.** Every value is a median
  over a 60-minute departure window *from the home*, so it contains the wait for
  the next departure at the home station, not the wait at the stop. Homes are
  well-served hubs; stops can be anything.
- **Error size**: a few minutes where the stop is served every 15–30 minutes,
  up to a full headway (an hour) on a rural postbus that runs hourly. The
  ranking is therefore mildly optimistic about badly-served stops, and the
  widget's live-API lookup for the stops it ends up showing corrects this.
- The transfer structure is also not perfectly mirrored (a tight connection one
  way can be a long wait the other), which is inside the same few-minutes band.

## How to run

```bash
uv sync --group tables                     # adds r5py (needs Java 21 on PATH)
uv run build_tables.py --selftest          # format round-trip, no r5py, no data
uv run pytest                              # format + checkpoint + date tests

uv run build_homes.py                      # regenerate homes.txt (100, fallback score)
uv run build_homes.py --gtfs downloads/gtfs_ch.zip    # rank by real departures

JAVA_TOOL_OPTIONS=-Xmx6g uv run --group tables build_tables.py
JAVA_TOOL_OPTIONS=-Xmx6g uv run --group tables build_tables.py \
    --homes-limit 10 --day-types 1 --hours 12-15 --time-budget-min 60
```

Tables are written gzipped (`<homeId>.bin.gz`, deterministic: level 9,
`mtime=0`). `--also-plain` additionally writes the uncompressed `<homeId>.bin`
that `table.ts` falls back to where the WebView has no `DecompressionStream`;
it is off by default because the plain copies triple the published size. Without
it, a WebView that old simply gets no table and falls back to the heuristic.

`build_tables.py` downloads what it needs into `downloads/` (both gitignored):

| Input | URL | Size |
|---|---|---|
| Swiss GTFS, current timetable year | `https://data.opentransportdata.swiss/dataset/timetable-2026-gtfs2020/permalink` | 250 MB |
| Switzerland OSM extract | `https://download.geofabrik.de/europe/switzerland-latest.osm.pbf` | 400 MB |

The GTFS **permalink** always redirects to the newest `gtfs_fp2026_<date>.zip`
(it resolved to `gtfs_fp2026_20260909.zip` when this was written) and needs no
API key. The sibling datasets are `timetable-2027-gtfs2020` (next year, once
published) and `timetable-draft-gtfs`; when the timetable year rolls over,
change `GTFS_URL` in `build_tables.py`. Note the `data.` host — the
`opentransportdata.swiss/en/dataset/...` form 404s.

The OSM extract is cropped to the Swiss bounding box with
`osmium extract --bbox --strategy complete_ways` when `osmium-tool` is
installed (`apt install osmium-tool`); without it the uncropped file works but
costs more memory.

## Memory and runtime

R5 is a JVM program. `JAVA_TOOL_OPTIONS=-Xmx6g` is the setting that matters;
`--max-memory 6G` (passed through to r5py's own config) does the same. Left
alone, r5py hands the JVM 80 % of RAM, which on a 16 GB CI runner leaves too
little for everything else. Network building alone peaks around 4–5 GB.

Runtime is dominated by one number: **R5 runs one search per origin**. The
origins are the homes (see the direction section above), so a (day type, hour)
pass is 100 searches, not 34,362; the 34,362 destinations are nearly free
because R5 propagates to all of them inside the same search. `--home-batch`
(default 100) only splits the pass into r5py calls, trading result-frame memory
(`batch × 34,362` rows) against call overhead.

| Scope | r5py passes | searches | Order of magnitude |
|---|---|---|---|
| 1 day type, 1 hour, 100 homes | 1 | 100 | about a minute |
| 1 day type, 16 hours | 16 | 1,600 | ~15 minutes |
| full 3 × 16 grid, 100 homes | 48 | 4,800 | under an hour |

Add roughly 10–15 minutes for the downloads, the `osmium` crop and the R5
network build, which now cost more than the routing does. The whole grid fits
one CI run; the tiering ladder the stop → home direction needed is gone.

The run is still resumable, which matters for a cold cache and for a runner that
dies: every (home, day type) pair is checkpointed to
`cache/tables/h2s-<buildId>-<gtfsHash>/<homeId>_d<dayType>.npz`, storing only
the hours actually computed. Re-running with a wider `--hours` or more
`--day-types` computes just the missing cells. `--time-budget-min` stops
cleanly, leaving the checkpoints intact for the next run. Cells that were never
computed are written as unreachable (65535), so a partial table is still a
usable table. The `h2s-` prefix is what keeps checkpoints from the earlier
stop → home builds — same stops, same GTFS, different numbers — from being
picked up.

## Output size

One table is `32 + 2 × 3 × 16 × 34,362` bytes = **3.3 MB** uncompressed. The
published file is gzipped, and the body compresses well — neighbouring stops
have near-identical times, so runs of equal `u16`s are everywhere — so expect
roughly 1 MB per home; the exact ratio is only known after a real build (the
random-data selftest table is not representative). At 100 homes that is on the
order of 100 MB published, inside the 1 GB GitHub Pages limit, and one home's
table is a ~1 MB first fetch for a pilot on mobile data. The binaries are never
committed (`web/public/data/tables/` is gitignored): `tables.yml` uploads them
as an artifact named `tables`, and `deploy.yml` downloads the newest successful
one into `web/public/data/tables/` before `npm run build`. If no artifact exists
yet the deploy step warns and the site ships without tables, which the widget
handles by falling back to the heuristic.

## Binary format

Gzip of a 32-byte little-endian header followed by
`u16 minutes[dayType][hour][stopIdx]`. GitHub Pages serves `.gz` without a
`Content-Encoding` header, so `table.ts` fetches `<homeId>.bin.gz` and pipes it
through `DecompressionStream('gzip')`, exactly as `stops.ts` does for
`stops.json.gz`, falling back to `<homeId>.bin` (only written with
`--also-plain`) where that API is missing. The `sw.js` cache-first rule for
tables matches both suffixes. Uncompressed, the layout is:

| offset | field | |
|---|---|---|
| 0 | magic | `XSBT` |
| 4 | version u8 | 1 |
| 5 | dayTypes u8 | 3 — 0 = Mon–Fri, 1 = Sat, 2 = Sun/holiday |
| 6 | hourStart u8 | 6 |
| 7 | hourCount u8 | 16 (06:00 … 21:00; clamp outside) |
| 8 | stopCount u32 | 34,362 |
| 12 | homeId u32 | DiDok number |
| 16 | buildId | 16 bytes ASCII, NUL-padded |

`stopIdx` is the position in `stops.json.gz` (sorted by id), so a table is only
valid for the stop list it was built against — hence the `buildId`.

**One caveat for `table.ts`:** `meta.json` carries a 19-character `buildId`
(`2026-09-11-4b9110db`) and the header field is 16 bytes, so it holds the first
16 characters. Compare with `meta.buildId.slice(0, 16)`, not the whole string.
The truncated prefix still contains the date and six hex digits of the stops
hash, so it changes whenever the stop list does.

`65535` means unreachable — no connection within `--max-time-min` (180 by
default), or a cell that was never computed. Values are medians over a 60-minute
departure window (`--departure-window-min`), which is what makes them include a
realistic wait: R5 departs every minute of the window and reports the median.
That wait is the one at the *home* end — see the direction section above.

## Representative days

`build_tables.py` picks one Monday, one Saturday and one Sunday inside the
feed's validity window, at least a week out, skipping Swiss national holidays
(computed from Easter) and the 20 Dec – 6 Jan special-timetable fortnight. The
chosen dates are written to `cache/tables/<buildId>-<gtfsHash>/dates.json`.
`--today` pins the reference date for a reproducible choice.

## `homes.txt` — adding or removing a home

`homes.txt` decides only which homes get an **offline** table. Any station at
all works as a home in the widget: without a table it ranks stops with the
distance heuristic and refines the shortlist through the live
transport.opendata.ch API. Being on the list buys offline ranking, nothing else.

One DiDok id per line, anything after `#` is a comment; blank lines are
ignored. Edit it by hand and re-run `build_tables.py` — an added home simply has
no checkpoints yet and gets computed, a removed one stops being written (delete
its stale `.bin` and checkpoint yourself). Ids must exist in `stops.json.gz`;
unknown ones are dropped with a warning.

To regenerate the whole list, `build_homes.py` takes the rail-bit stops inside
the Swiss bounding box and ranks them either by real GTFS departures
(`--gtfs <zip>`, which counts `stop_times` rows for trips running on a
representative Wednesday, aggregated onto the DiDok number before the `:`) or,
without the zip, by a neighbourhood proxy: rail stops within 1 km plus bus
stops within 500 m. The proxy is crude — it over-rates dense rack railways and
under-rates tourist termini; about three quarters of a hand-checked list of 50
well-known stations land in its top 300, and the default list is cut at the top
**100** (`--count`), so hand-editing matters more than it would at 300. A
greedy 500 m minimum separation
keeps co-located siblings (Zürich HB / Zürich HB SZU) from eating several
slots, and `ALWAYS_INCLUDE` in the script seeds the hubs the widget is tested
against (Zürich HB, Bern, Interlaken Ost, Lausanne, Luzern, Chur, Sion).

## CI

`.github/workflows/tables.yml`: monthly cron plus `workflow_dispatch` with
`homes_limit` / `day_types` / `hours` / `time_budget_min` inputs. It installs
Java 21, uv and `osmium-tool`, caches `data/downloads` per month and
`data/cache/tables` per stops hash (so an out-of-budget run resumes next time),
runs the build with `JAVA_TOOL_OPTIONS=-Xmx6g`, and uploads
`web/public/data/tables/` (the `.bin.gz` files) as the `tables` artifact. It
does not pass `--also-plain`.
