# Architecture

A browser tool that turns 1,243 raw telemetry shards from LILA BLACK into
something a **Level Designer** can act on — not a notebook, and not a dashboard
for analysts. It runs in two modes: **aggregate**, reading 796 matches at once to
find patterns, and **replay**, watching one match unfold to understand why. Every
derived number is clickable back to the journeys that produced it.

The hard problem: the telemetry has **no extraction event**, so the defining
outcome of an extraction shooter is absent. It was recovered statistically and
validated (§4.3), which turned an unmeasurable game into one with a **~27 %
extraction rate**. Feature list and screenshots are in the
[README](README.md); derivations in [`docs/DESIGN_NOTES.md`](docs/DESIGN_NOTES.md).

### What's on the screen

| Feature | What it does, and the number behind it |
|---|---|
| **Exfil Intelligence** <sup>inferred</sup> | Where runs actually end. Exits cluster at **13–47×** expected; players reaching one die **0.6 %** vs **82.8 %** elsewhere. |
| **Rotation & Flow Field** | Which way players move, not just where. 28×28 vector field — **26 one-way corridors, 138 churn cells** on Ambrose. |
| **Phase Compare (A/B)** | Whether a distribution really moved. Divergent diff of any two slices; dispersion drops **39.2 %** early→late. |
| **Map Health Scorecard** | What's broken, without going to look. 7 checks per map, thresholds visible, **3 / 5 / 4** criticals, every row links to its evidence. |
| **Spawn → Outcome Funnel** | Whether the spawn you're handed decides your run. Fixed spawns at **30–57×** expected; **Lockdown is 6.4× unfair** — 40 % vs 6 %. |
| **Loot Economy** | What a cell pays per unit of footfall. **262 of 706** Ambrose cells are loot deserts; reward/traffic *r* = **0.80**. |
| **Journey Explorer** | The aggregate workspace: every path on the correct minimap, shape-coded humans and bots, `Shift`+drag any region for live stats. |
| **Match Replay** | One match over its own timeline — play/pause, 1×–16×, frame-step, histogram-baked scrubber. |

Screenshots in the [README](README.md); derivations in
[`docs/DESIGN_NOTES.md`](docs/DESIGN_NOTES.md).

---

## 1. What I built it with, and why

| Layer | Choice | Why |
|---|---|---|
| Pipeline | **Python** — pyarrow, pandas, numpy, Pillow | The data is five fixed days that never change. Parse once offline, not on every page load. |
| Transport | **One static `bundle.json`** (3.84 MB) | No backend, no database, no API. The whole tool is static files. |
| UI | **React 19 + TypeScript + Vite** | Fast builds, types catch coordinate bugs at compile time. |
| Rendering | **deck.gl** (WebGL) | 87,599 rows. SVG/Canvas dies at this count; deck.gl draws it on the GPU at 60 fps. |
| State | **zustand** | One small store, URL-serialisable, no boilerplate. |
| Hosting | **Vercel**, static output | Nothing to run server-side, so nothing to break or pay for. |

**The decision that shaped everything else: precompute.** The data is five fixed
days, and every user asks the same questions of it. Parsing 34 MB of parquet in
the browser on every visit to recompute an identical answer is waste; the
pipeline does it once and ships a 3.84 MB result. Cold start is under two seconds.

## 2. How data flows, parquet → screen

```
player_data/February_10…14/{user_id}_{match_id}.nakama-0   1,243 headerless parquet shards
        │  pipeline/build.py
        ├─ read shards, decode bytes columns to UTF-8          89,104 rows
        ├─ drop nulls / out-of-bounds / unparseable            87,599 survive
        ├─ classify actor: human vs bot from user_id shape
        ├─ project world (x, z) → normalised minimap (u, v)
        ├─ group → 796 matches · 1,242 journeys · 14,750 events
        ├─ derive 48×48 heat grids, 28×28 flow field,
        │   exfil zones, spawn zones, map-health scorecard
        └─ write web/public/data/bundle.json                   3.84 MB
                │  fetch() once at load
                └─ zustand store → useFiltered() → deck.gl layers
```

`pipeline/prepare_maps.py` separately converts the three source minimaps
(up to 9000²) to 2048² WebP, a 92–98 % size reduction.

`useFiltered()` is the single source of truth for "what is on screen" — every
panel, layer and histogram reads it, so the UI cannot disagree with itself.

## 3. Mapping game coordinates to the minimap — the tricky part

The dataset README gives each map a `scale` and an origin. The world is
**(x, z)** on the ground plane; **`y` is elevation and is not used for
placement** — that was the first trap, since `y` looks like a 2D coordinate.

```
u = (x - origin_x) / scale          # 0..1 across the minimap
v = (z - origin_z) / scale
pixel_x =      u  * width
pixel_y = (1 - v) * height          # world +Z is north, image +Y is south
```

| Map | scale | origin_x | origin_z | source image |
|---|---|---|---|---|
| Ambrose Valley | 900 | −370 | −473 | 4320 × 4320 |
| Grand Rift | 581 | −290 | −290 | 2160 × 2158 → padded square |
| Lockdown | 1000 | −500 | −500 | 9000 × 9000 |

Three things this has to get right:

1. **The Y flip.** Omitting `1 - v` mirrors every path vertically — and it still
   looks plausible, which is what makes it dangerous.
2. **Grand Rift is not square** (2160 × 2158). It is padded to 2160² *before*
   scaling, so the two axes keep the same units.
3. **Client-side the map is a fixed 1024-unit square** under an
   `OrthographicView({flipY: true})`, so zoom and pan never touch the maths.

**Validation:** `pipeline/` renders every point over the real minimap with
matplotlib ([`docs/coord_validation.png`](docs/coord_validation.png)) — roads
and buildings line up with traffic. 0 of 87,599 points fall outside the playable
mask. `Ctrl`/`⌘`+`D` in the app overlays a live world-coordinate grid so the
projection can be audited without reading code.

## 4. Assumptions where the data was ambiguous

| # | What I hit | What I assumed, and why |
|---|---|---|
| 1 | `timestamp` is wall-clock, not match-relative, and not in seconds | Normalised per match to seconds from first event. Match durations then land at a believable 3–13 min. |
| 2 | Bot detection — event names (`BotKill`) and `user_id` shape disagree | `user_id` shape wins; event names are a hint. 245 humans / 94 bots. |
| 3 | **There is no `Extracted` event** — the defining outcome of an extraction shooter is simply not in the telemetry | A run ends in death or escape; deaths are logged, escapes are not. I would *not* infer this per-player — one session ending is indistinguishable from a disconnect. But 776 sessions ending are not: binning every human journey's **last** position on a 48×48 grid shows exits concentrating in a handful of cells at **13–47× the rate traffic predicts** (Poisson tail), not scattering as disconnects would. Validated against an independent signal the method never sees — players ending inside those cells die **0.6 %** of the time, everyone else **82.8 %**. That yields an extraction rate of ~27 %. ~12 % of runs stay unresolved and are left unresolved. Everything derived from this is labelled **inferred** in the UI. Method and validation: `docs/DESIGN_NOTES.md` §3c; the finding: `INSIGHTS.md` §5. |
| 4 | Storm position is never recorded | Only `KilledByStorm` deaths are used. No storm circle is drawn, because inventing one would be fiction. |
| 5 | 1,505 rows (1.7 %) unusable | Dropped, counted, and reported in `pipeline/DATA_QUALITY.md` rather than silently discarded. |

93.3 % of matches contain exactly one human and no bots. That is a finding, not
a bug — see `INSIGHTS.md` §1 — but it constrains what can honestly be built.

## 5. Major trade-offs

| Decision | Alternative | Why this way |
|---|---|---|
| Precomputed static JSON | DuckDB-WASM in-browser querying | Ship 3.84 MB once, not 34 MB per visit, for questions that are the same for everyone. |
| deck.gl / WebGL | SVG, Canvas 2D, Leaflet | 87,599 rows. The others stall well before that. |
| 48×48 heat grid | Per-pixel KDE | A grid cell is ~19 world units — about a room. Finer would be noise at 1,242 journeys. |
| Icon-atlas glyphs | Coloured circles | Colour-only fails two must-have lines of the brief and dies in greyscale or with colour-vision deficiency. Shape carries meaning; colour repeats it. |
| Scorecard with **no composite score** | A single 0–100 "map health" number | One number hides *which* thing is broken. Seven checks with visible, contestable thresholds is what a designer can act on. |
| Exfil zones labelled **inferred**, drawn as hollow rings | Presenting them as fact | They are a statistical recovery, not telemetry. The UI must never let that be forgotten. |
| Chokepoint detection **rejected** | Building it anyway | At 93.3 % solo it would render an empty layer. Correct in principle, empty in practice, worse than absent. |

## 6. How I used AI

The decisions this tool rests on came from the data: reading the raw shards until the (x, z) / elevation split and the Y-flip surfaced;
choosing to precompute rather than query in the browser; and many more. AI did the work around those decisions 
React and deck.gl scaffolding, repetitive layer code, a second pass on prose. Every figure in these documents was computed from the data and checked before it was written.
