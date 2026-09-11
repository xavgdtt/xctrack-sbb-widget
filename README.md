# XCTrack Get Home widget

A static web page, hosted on GitHub Pages, loaded in XCTrack's **Web page widget** (PRO).
While flying XC in Switzerland it shows **3 public-transport stops** the pilot could glide
to, chosen to get home as early as possible. Each option shows a north-up direction arrow,
distance, required glide ratio, the first usable departure, and the arrival time at the
configured home station.

Everything runs client-side: no backend, no API keys, no CDN at flight time.

## Repo layout

```
/
├─ web/                   # the widget (Vite, vanilla TypeScript, no framework)
│  ├─ index.html          # the widget page
│  ├─ setup.html          # config page: pick home, params → URL + QR
│  ├─ src/                # widget sources (main.ts, setup.ts, …)
│  ├─ public/data/        # stops.json.gz + meta.json (built by data/)
│  ├─ public/fixtures/    # IGC replay fixtures for development
│  └─ test/               # vitest unit tests
├─ data/                  # Python ETL (stops dataset, phase 2 travel-time tables)
├─ .github/workflows/
│  ├─ ci.yml              # typecheck + test on pushes and pull requests
│  └─ deploy.yml          # build web/ and deploy to GitHub Pages
└─ README.md
```

## Develop

```sh
cd web
npm install
npm run dev
```

`npm run dev` serves both pages: `/` is the widget, `/setup.html` the config page.
`npm run build` produces `web/dist/`, `npm run preview` serves that build.

## Test

```sh
cd web
npm test         # vitest
npm run typecheck  # tsc --noEmit
```

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`, which builds `web/` and publishes
`web/dist` to GitHub Pages. The workflow sets `BASE_PATH=/<repo-name>/` so asset URLs are
correct on a project site; locally `BASE_PATH` defaults to `/`.

One-time setup: in the repository settings, under **Pages**, set the source to
**GitHub Actions**. The workflow can also be run manually via *workflow_dispatch*.

## How it works

**Reachability.** Every fix gives a position and an altitude. For each stop the widget
computes the usable height `h = alt − stopElevation − margin` (`margin` defaults to 150 m)
and the horizontal distance `d`. The required glide ratio is `Lreq = d / h`. Stops with
`h <= 50 m` or `Lreq > lmax` are dropped. A coarse lat/lon bounding box prefilters the
~30k stops before the haversine pass. There is no wind model and **no terrain check** —
the widget says so in its footer.

**Ground time.** Reaching a stop is not the same as catching a train. The widget adds
flying time `d / v` (trim speed, default 34 km/h), packing minutes and a landing-to-stop
walk, and rounds up to the next minute to get the earliest usable departure.

**Ranking.** For every reachable stop it estimates the arrival time at home:
`arrivalEst = earliestDep + travelEst`, where `travelEst` comes from the phase 2 offline
travel-time table when one is loaded, and otherwise from a heuristic (straight-line
distance at 50 km/h plus a wait allowance and a mode penalty). It then builds the Pareto
front over "lower required glide ratio" and "earlier arrival at home", and picks three:

1. **Safest** — among stops needing `Lreq <= lsafe`, the one arriving home earliest; if
   none qualify, simply the stop with the lowest `Lreq`.
2. **Best** — the earliest arrival on the front.
3. **Nearest** — the front's knee point: the one buying the most arrival-time improvement
   per unit of extra glide ratio over **Safest**, excluding the other two picks.

Picks that point in nearly the same direction and sit close together are rejected in
favour of the next point on the front, so the three options are genuinely different
choices. The picks plus a few near-front candidates are then routed live against
transport.opendata.ch; if live departures change the ordering, the pick-3 is rerun on the
routed data.

## Setup in XCTrack

TODO.

## Data

TODO.
