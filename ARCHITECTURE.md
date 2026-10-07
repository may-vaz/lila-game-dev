# Architecture

**Live:** _(deployed URL goes here)_ · **Repo:** _(repo URL)_

---

## 1. What I built it with, and why

| Layer | Choice | Why |
|---|---|---|
| Pipeline | **Python + PyArrow + NumPy** | The data is 1,243 parquet shards with real messiness (bytes columns, a broken timestamp unit, contradictory bot markers). That work belongs offline, once, in the ecosystem built for it — not in the browser on every page load. |
| Transport | **One static `bundle.json`** (~3 MB, ~0.9 MB gzipped) | See §3. |
| Rendering | **deck.gl 9** on an `OrthographicView` | GPU/WebGL. Ships `PathLayer`, `TripsLayer` (time-animated trails), `HeatmapLayer`, `PolygonLayer` and GPU picking out of the box. Every core requirement maps to a layer that already exists and is already fast. |
| App | **React 18 + TypeScript + Vite** | deck.gl's first-class binding; Vite gives a sub-second dev loop and a static `dist/` that any host will serve. |
| State | **Zustand** | One small store. Redux is ceremony at this size; prop-drilling across four panels is worse. |
| Styling | **Hand-written CSS with custom properties** | The whole UI is ~15 bespoke components in a dark tool aesthetic. A utility framework would have been dead weight. |
| Hosting | **Static deploy (Vercel)** | No server, no cold start, no database, nothing to fall over while you're evaluating it. |

### Why not three.js
The data is top-down 2D on a minimap image. three.js is a general 3D engine — I'd have spent the whole budget rebuilding instancing, picking, kernel-density heatmaps and time-animated trails that deck.gl already ships. deck.gl *is* WebGL, so there's no performance ceiling being accepted here. If verticality ever matters (the `y` column is real elevation), deck.gl extrudes and tilts without a rewrite.

### Why not DuckDB-WASM
It was my first instinct and I was wrong. I profiled the dataset before committing: **~89k rows total**, which is about 3 MB of JSON. Shipping a ~30 MB WASM query engine to filter 89k rows would have been architecture cosplay. Plain JS array filters over in-memory typed data run in under a millisecond here. I'd revisit at ~10M rows — the pipeline already emits per-map artefacts, so the swap is localised to one hook.

---

## 2. How data flows

```
1,243  *.nakama-0  (parquet, one player × one match)
        │
        │  pipeline/build.py        ── runs once, offline, committed output
        │    • decode  event  bytes → utf-8
        │    • repair  ts           (ms → s, see §4)
        │    • classify human/bot   from user_id shape, cross-checked vs events
        │    • drop    (0,0) placeholders, out-of-bounds, dupes, non-finite
        │    • project world (x,z)  → UV  (see §3)
        │    • simplify paths       Ramer–Douglas–Peucker, ε = 0.0015 UV
        │    • pre-bin              64×64 occupancy grids per map per metric
        ▼
   web/public/data/bundle.json      maps · dates · matches · journeys · events · grids
   web/public/maps/<Map>.webp       2048² WebP  (24 MB of source PNG/JPG → 0.73 MB)
        │
        │  single fetch on load, held in memory
        ▼
   useFiltered()                    one memoised selector = the single source of truth
        │                           for canvas, inspector, timeline and legend
        ▼
   deck.gl layer stack
     BitmapLayer      minimap
     HeatmapLayer     kill / death / traffic / loot density   (from pre-binned grids)
     PolygonLayer     dead zones (inverse traffic)
     PathLayer        full journeys            (Aggregate mode)
     TripsLayer       animated trails + heads  (Replay mode, driven by currentTime)
     ScatterplotLayer discrete events, split human/bot for distinct styling
     Line/TextLayer   coordinate debug grid    (Ctrl/⌘+D)
```

Everything the UI shows comes from one `useFiltered()` memo, so the panels can never disagree with the canvas.

---

## 3. Coordinate mapping — the tricky part

### The transform

The dataset README supplies a per-map scale and origin. Unity is Y-up, so the **ground plane is X/Z** and the `y` column is elevation — it is never used for 2D placement.

```
u  = (world_x - origin_x) / scale          # 0..1
v  = (world_z - origin_z) / scale          # 0..1

px =      u  * SIZE
py = (1 - v) * SIZE                        # Y flip: image origin is top-left,
                                           # world origin is bottom-left
```

| Map | scale | origin X | origin Z |
|---|---|---|---|
| AmbroseValley | 900 | −370 | −473 |
| GrandRift | 581 | −290 | −290 |
| Lockdown | 1000 | −500 | −500 |

### How I verified it rather than trusting it

1. **Bounds check.** Projected every row in the dataset. **0.00 % fell outside [0,1]** on all three maps — and the extents don't merely fit, they fill sensibly (Ambrose u ∈ [0.05, 0.72], v ∈ [0.10, 0.91]). A wrong scale or a swapped axis produces values outside the unit square almost immediately.
2. **Semantic check — the one that actually proves it.** Overlaying loot events on **GrandRift** puts the clusters precisely on the minimap's own printed labels: *Labour Quarters*, *Engineer's Quarters*, *Gas Station*, *Maintenance Bay*. Loot spawns in buildings; the buildings are where the loot events land. That cannot happen by coincidence.
3. **Negative-space check.** **Lockdown** has a large ocean in one corner. After projection, **zero** events land in the water. A Y-flip error would have dumped a third of the map into the sea.
4. **Shipped the proof.** `Ctrl/⌘+D` overlays a live world-coordinate grid on the minimap so anyone can audit the mapping without reading code. `docs/coord_validation.png` is the static version.

### The resolution trap

The dataset README states the minimaps are **1024×1024**. They are not — they are **4320×4320**, **2160×2158** and **9000×9000**, and one of them is **not square**.

Anyone hard-coding `* 1024` gets a correct-looking result only because they then display into a 1024-ish box. I kept the entire pipeline in **resolution-independent UV space** and let the renderer apply the final scale, so the real pixel size is irrelevant. `prepare_maps.py` pads the non-square GrandRift image to square before resizing, otherwise UV (0..1) would stretch the terrain by ~0.1 % against the X axis.

---

## 4. Assumptions, and the data problems behind them

### 4.1 The timestamp is wall-clock, not match-relative — and the unit is wrong
The README says `ts` *"represents time elapsed within the match, not wall-clock time."* Read literally, every match in the dataset occurs on **1970-01-21** and lasts about **0.4 seconds**.

The column is typed `timestamp[ms]`, but the underlying int64 is **epoch seconds**. Reinterpreting it as seconds yields:
- timestamps in **February 2026**, and
- match durations of **a few minutes**.

Confirmed three ways: the derived dates line up with the `February_1X` folder names; durations become plausible; the span of the dataset matches the stated Feb 10–14 collection window.

**Decision:** reinterpret as epoch seconds. Keep absolute UTC for the date filter; derive `t = ts − match_start` for playback. The pipeline logs both readings in `pipeline/DATA_QUALITY.md`.

**Knock-on effect:** day folders are *not* UTC days. `February_10/` contains rows from Feb 9, and `February_11/` contains rows from Feb 10 — matches straddle midnight. **Filtering by folder name would be wrong**, so the date filter uses the derived timestamp and the UI labels it "Date (UTC)".

### 4.2 Bot detection: `user_id` shape wins, event names are a hint
The README gives two signals, and they contradict each other:
- `user_id` is a UUID → human; a short numeric ID → bot.
- `BotPosition`/`BotKill`/`BotKilled` → bot; `Position`/`Kill`/`Loot` → human.

In practice **636 rows carry `event = 'Position'` under a numeric user_id**, and a smaller number of `BotKill`/`BotKilled`/`Loot` rows do the same. `BotPosition`, however, is 100 % consistent with numeric IDs.

**Decision:** `user_id` shape is the source of truth for the human/bot flag — it's an identity property, whereas the event name describes *what happened*. I read `BotKill` as *"a bot was the victim"* and `BotKilled` as *"a bot was the killer"*, relative to the file's owner. The conflicts are counted in the quality report rather than silently resolved.

### 4.3 There is no extraction event
`Loot`, `Kill`, `Killed`, `BotKill`, `BotKilled`, `KilledByStorm`, `Position`, `BotPosition` — that's the whole vocabulary. For an *extraction* shooter, the defining outcome (did the player get out?) is **not in the telemetry**. I did not infer it from "player stopped emitting positions", because that is indistinguishable from a disconnect. Flagged in `INSIGHTS.md` as the single highest-value column to add.

### 4.4 Storm position is not recorded
Only `KilledByStorm` deaths are. I did not draw a storm ring, because its radius and centre over time would have been invented. Storm deaths are plotted as events instead.

### 4.5 Rows discarded
Exact-`(0,0)` coordinates are treated as spawn/null placeholders rather than a real world position. Non-finite coordinates, rows outside the minimap bounds by >2 %, unknown `map_id`s, and exact duplicates are dropped. Players with a single position sample get an event marker but no path — two points are needed to draw a line. Every count is itemised in **`pipeline/DATA_QUALITY.md`**.

---

## 5. Major trade-offs

| Decision | Alternative considered | Why I chose it | Cost |
|---|---|---|---|
| Pre-compute offline, ship static JSON | DuckDB-WASM in-browser; or a FastAPI + Postgres backend | 89k rows is small. Zero servers = zero cold starts, zero cost, nothing to break unattended. | Re-running the pipeline is a deploy, not a refresh. Fine for a 5-day snapshot. |
| Single bundle, eager load | Lazy per-map / per-match shards | One ~0.9 MB gzipped fetch, then every interaction is instant and offline. | Slightly slower first paint; would not scale past ~10× this volume. |
| deck.gl | three.js, PixiJS, D3/Canvas, Mapbox | Every requirement maps to an existing, GPU-accelerated layer. `TripsLayer` is the playback requirement, solved. | Heaviest dependency in the bundle. |
| Pre-binned 64×64 grids for heatmaps | Feed raw points to `HeatmapLayer` | Stable, resolution-independent density; also powers dead-zone detection and the region stats for free. | Fixed spatial granularity (~14 world units/cell on Ambrose). |
| RDP path simplification (ε = 0.0015 UV) | Ship every position sample | ~40 % smaller payload with no visible change to path shape. | Sub-pixel detail lost at extreme zoom. |
| Two explicit modes (Aggregate / Replay) | One screen with everything toggled | They are two different jobs. 726 journeys drawn at once is a hairball; one match animated is a story. Each mode defaults to the right layers. | A mode switch to learn. |
| Reinterpret the timestamp | Trust the README | Durations and dates become plausible and self-consistent. | If the README is right and I'm wrong, dates are wrong — but then matches last 0.4 s, which they do not. |
| `user_id` shape for bot detection | Trust event-name prefixes | It's an identity property and `BotPosition` corroborates it perfectly. | ~500 rows have contradictory event names; counted, not hidden. |

---

## 6. How I used AI

Used heavily and deliberately, on the leaves rather than the trunk.

**Where it earned its keep:** deck.gl layer boilerplate and prop signatures, the RDP implementation, CSS scaffolding, TypeScript error clean-up, and docs formatting. Easily a 3–4× speed-up on volume work.

**Where I overrode it:** every architectural and product decision. AI's default suggestion for "visualise telemetry" was a Streamlit dashboard, then a DuckDB-WASM + React stack — the first too crude, the second over-engineered for 89k rows. It also happily consumed `ts` as written, which silently dates the entire dataset to 1970, and it had no opinion on splitting Aggregate from Replay or on inverting the traffic heatmap to find dead zones.

The judgment calls that matter here — *reinterpret the timestamp*, *right-size the stack downward*, *validate coordinates against map labels instead of asserting them*, *build the inverse heatmap because the brief asked which areas get ignored* — all came from reading the data and the brief closely. The speed came from the tools.
