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

## 3b. Two derived layers: flow field and A/B comparison

Heatmaps answer *where*. Two questions a level designer asks immediately afterwards are *which way* and *compared to what*, and neither is answerable from a density map. Both are precomputed in `pipeline/build.py`.

### Flow field

For every consecutive pair of position samples from the same player in the same match, the displacement is binned into a 28×28 grid. Per cell the pipeline emits the mean heading, the mean speed, the sample count, and:

```
coherence = |Σ v| / Σ |v|      in 0..1
```

A cell where every player travels the same way sums to a long vector and scores near 1. A cell where players wander or pass in both directions cancels out and scores near 0. The two ends are semantically opposite — a committed route versus a pocket of milling — so the layer uses a diverging amber/blue ramp rather than a sequential one.

Design decisions worth naming:

- **28×28, not the heatmap's 64×64.** Arrows need room. At 64 the field becomes an unreadable hairball, and the per-cell sample count gets too thin for the mean direction to mean anything.
- **Gaps are dropped, not interpolated.** Any transition with `dt ≥ 30 s` is discarded. A one-minute hole in telemetry is not a sprint across the map, and bridging it would invent a route that no player took.
- **Cells under 6 transitions are blanked.** A direction derived from two samples is noise wearing an arrow's clothing.
- **Arrows are three `LineLayer` segments** (shaft plus two barbs) generated on the CPU in `lib/viz.ts`. deck.gl has no arrow primitive; this avoids shipping an icon atlas to draw a triangle, and the worst case is ~2.3k segments.
- **Length encodes volume, logarithmically**, because traffic is heavily skewed and a linear mapping would leave every cell but the busiest invisible.

A useful validation side-effect: mean speed comes out at **2.7–3.4 world units/second** across all three maps. That is a plausible character run speed, which is independent corroboration that the coordinate scale and the timestamp unit are both right. If either had been wrong, this number would have been absurd.

### A/B comparison

The pipeline also emits traffic grids sliced by **relative** match phase — early/mid/late at 0–33 / 33–66 / 66–100 % of *each match's own duration* — plus bot-only and human-only grids. The compare layer renders `normalise(A) − normalise(B)` as a red/blue divergent overlay.

The normalisation is the whole feature. Raw counts would only ever show that whichever slice contains more rows is "bigger everywhere". Dividing each grid by its own total first converts the question from "which slice is larger" to "**did the distribution of players actually move**" — which is the question worth asking.

Phase is relative rather than absolute seconds because match length varies by 3–4×; "the first two minutes" means something very different in a 3-minute match and a 14-minute one.

Cells below 6 % of the maximum absolute difference are suppressed as rounding fuzz, and the alpha ramp is `sqrt`-shaped because the difference distribution is long-tailed.

**Cost:** both features together added **0.16 MB** to the bundle (3.67 → 3.83 MB; 750 KB gzipped) and ~1 s to the pipeline. Nothing is computed in the browser beyond the subtraction and the arrow geometry.

---

## 3c. Recovering the extraction event

The dataset has no `Extracted` event, which for an extraction shooter means the defining outcome of a run is unrecorded. `pipeline/build.py::build_exfil` reconstructs it.

**Method.** Bin the final recorded position of every human journey onto a 48×48 grid. Compare observed exits per cell against the exits that cell's share of total traffic would predict. Flag a cell when it has ≥ 4 exits *and* ≥ 6× the expected count, merge 8-connected flagged cells into zones (a door-sized trigger straddling a boundary should not read as two exits), and attach a Poisson tail probability `P(X ≥ k | λ = expected)` to each.

**Why it is not circular.** The clustering only ever looks at *where* runs end. The validation uses a signal it never saw — whether the player also has a `Killed`/`KilledByStorm` event:

| | Died, ended inside a zone | Died, ended elsewhere |
|---|---|---|
| Ambrose Valley | 0.6 % | 82.8 % |
| Grand Rift | 6.7 % | 69.0 % |
| Lockdown | 8.3 % | 75.6 % |

Dying and extracting are the two ways to leave. Locations where almost nobody dies but a quarter of all runs terminate are extraction points.

**What is deliberately not claimed.** No individual player is labelled "extracted" with certainty — the inference is population-level, and ~12 % of runs land in an `unresolved` bucket (neither a death nor a known zone: disconnects, backgrounded apps, exfil points below the detection bar). Everything derived from this is labelled `inferred` in the UI, and the residual is reported rather than hidden. The recommendation to log the event properly stands: reconstruction recovers the zones and a rate, but not loot value carried out.

---

## 3d. The map health scorecard

Every other layer is interrogative — you must already suspect something to go find it. The scorecard is declarative: it opens with the problems found and ranked across seven dimensions (area utilisation, route coherence, traffic concentration, extraction rate, storm engagement, PvP share, shared matches), each flagged ok/warn/critical and exportable as Markdown for a ticket.

Two deliberate design decisions:

- **No composite score.** Averaging area utilisation against PvP share produces a number with no units, and it lets a map hide one catastrophic metric behind six healthy ones. Each dimension stands alone.
- **Thresholds are declared, not implied.** They live in one named constant, `SCORECARD_RULES` in `pipeline/build.py`, and the UI shows the warn/critical cut-offs next to every value. There is no public benchmark for "correct" area utilisation in a mobile extraction shooter; these are design judgements, and the tool says so, so a designer can argue with the threshold instead of with the tool.

---

## 3e. Visual design

The palette is not invented. It is sampled from the two pieces of LILA BLACK key art embedded in the assignment brief itself — a teal atmosphere pierced by a magenta vortex, with lime foliage, an amber jacket and a crimson eye.

That mapping turned out to be mostly free, because the semantics already lined up:

| Data | Colour | Where it comes from |
|---|---|---|
| Storm death | magenta `#c24ae0` | the vortex — the storm *is* that thing in the artwork |
| Loot | teal `#22d3ee` | the atmospheric haze in both images |
| Kill | amber `#ffb02e` | the character's jacket |
| Death | crimson `#f0384a` | the glowing eye of the tower |
| Human | lime `#8ee03c` | the foliage — the living thing in the frame |
| Bot | desaturated teal-slate `#5a7a85` | the background buildings |

The background is a near-black with a deliberate teal cast rather than neutral grey, because "LILA BLACK" is not a grey game. The heatmap gradient runs deep teal → cyan → lime → amber → white-hot, which stays inside the game's hues while keeping luminance monotonic so it still reads correctly as low-to-high.

Two constraints this was *not* allowed to break:

- **Semantic distinctness comes first.** The four event types, human/bot, and the diff's two poles all have to stay separable at a glance. Hue separation was checked before anything was adopted; branding never overrode legibility.
- **Brand colours never encode data.** `--brand` and `--brand-2` are used for the wordmark, the header hairline and a faint background glow only. Nothing a designer has to *read* is coloured by them.

The legend is generated from the same constants the deck.gl layers render with (`lib/viz.ts`), so it is structurally incapable of drifting out of sync with the map.

---

## 3f. Spawn points, and whether they are fair

Running the exfil clustering backwards — on the **first** position of every human
journey rather than the last — returned something I did not expect. Entries do
not spread across the map the way a battle-royale drop would. They land in
**9–19 cells per map, at 30–57× the rate traffic predicts**. LILA BLACK uses a
small set of **fixed spawn points**.

That reframes the analysis. A free drop makes spawn a player choice and therefore
a confounder; a fixed spawn makes it an assigned, controlled variable — which
means it can be cross-tabbed against the run outcome recovered in §3c to answer a
question a Level Designer can act on: *does the spawn you are handed change your
odds of getting out?*

| Map | Spawn points | Ranked | Best | Worst | Spread |
|---|---|---|---|---|---|
| Ambrose Valley | 7 | 7 | 37 % | 27 % | **1.37×** |
| Grand Rift | 5 | 3 | 20 % | 15 % | 1.30× |
| Lockdown | 9 | 8 | 40 % | 6 % | **6.40×** |

Ambrose is the control. Seven spawns, all landing between 27 % and 37 % — that is
within what 70–86 runs per spawn can resolve, and it demonstrates the design *can*
be balanced. Lockdown is the finding: a 6.4× spread, with the worst spawn
extracting **6 %** on a median run of **2:34** against the best at **40 %** and
**7:07**. Players assigned that spawn are losing the run in under half the time,
before loot or routing can matter.

The honest hazard here is small-n: an 8-run spawn showing 0 % is noise, not a
defect. So `MIN_SPAWN_RUNS = 10` gates the ranking, the spread is computed only
over ranked zones, every marker carries its run count in the tooltip, and
sub-threshold zones render hollow and unlabelled rather than being silently
dropped — a designer should be able to see that a spawn exists but is not yet
measurable.

Marker shape is load-bearing: spawns are **filled squares** where exfil zones are
**hollow rings**, because spawns are observed ground truth and exfil zones are an
inference. Fill colour maps extraction rate on a **fixed** 0–45 % scale rather
than a per-map relative one, so the best spawn on a broken map cannot be coloured
as if it were healthy.

---

## 3g. The loot economy

Loot is **78.9 %** of every event in this dataset, and loot placement is the
cheapest, highest-leverage change a Level Designer can ship. But the loot heatmap
is close to useless on its own: its correlation with raw traffic is **r = 0.80**
on Ambrose. It is largely a restatement of where players walk.

The designer question is a ratio, not a count — per unit of footfall, what does a
cell **pay**, and what does it **cost**?

```
reward = loot pickups        / visits
risk   = (kills + deaths)    / visits
```

Both are split at the map median across cells with ≥ 20 visits, giving four
classes:

| Class | Reward | Risk | Reading |
|---|---|---|---|
| **Honeypot** | high | high | The intended tension. Worth the fight. |
| **Free farm** | high | low | Pays out for nothing. Over-generous. |
| **Deathtrap** | low | high | Punishes with no compensation. |
| **Barren** | low | low | Dead space. |

Two design notes. First, **risk folds in kills, not just deaths** — deaths are
sparse enough that the per-cell median is exactly 0, which would collapse the
split into a meaningless binary. Second, the whole layer is **derived on the
client** from the heat grids already in `bundle.json`; it costs zero extra
payload and cannot drift out of sync with the grid definition.

On Ambrose this surfaces **262 loot deserts** — cells taking 20+ visits that
yield no loot whatsoever — sitting next to a dense honeypot core in the town
centre. That is a concrete, mappable list of places to move loot to, and the
r = 0.80 says moving it will move players.

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

## 4b. Why these features, and not others

The four analytical layers were chosen to match how battle-royale telemetry is actually consumed in production, not invented from scratch:

- **Endpoint analysis** — the COD: Warzone *Caldera* telemetry study works on "player movement paths and their endpoint locations"; grid-cell drop/zone marts are standard in PUBG analytics warehouses. §3c applies that to a game where the endpoint event is missing entirely.
- **Rotations** — `mart_player_rotation` at player × match grain is a first-class table in production battle-royale warehouses, which is why direction and coherence get their own layer rather than being folded into the heatmap.
- **Phase grain** — `fact_match_phase` (match × phase) is standard. Phase here is *relative* to each match's own duration because length varies 3–4×.
- **Balance marts** — balance teams consume flagged summaries, not raw graphs. A midcore studio writing up their heatmap tooling made the same point explicitly: interpreting heatmaps needs product expertise, so the tool should do the interpreting.
- **Drop / spawn luck** — PUBG warehouses publish a "zone luck" mart cross-tabbing drop position against finish and survival. §3f asks the same question of fixed spawns, where the position is *assigned* rather than chosen and the causal reading is therefore cleaner.
- **Loot balance** — loot-spawn rates are tuned continuously post-launch from per-event telemetry, alongside weapon damage and zone timing. §3g builds the reward-per-visit vs risk-per-visit grain that work runs on, because loot is 78.9 % of this dataset and a flat loot heatmap mostly restates footfall.

Two features here (§3f, §3g) are not in the brief's requirement list. They are included because the brief asks for product thinking, and both answer questions the required layers raise but cannot close: the required heatmaps show *where* loot is taken but not whether it is worth taking, and §3c found where runs end without ever asking whether where they *began* predicted it.

**What was deliberately rejected:** chokepoint / encounter-density detection, which is textbook for this genre. With 93.3 % of matches containing exactly one human it would have rendered an empty layer. A feature that is correct in principle and empty in practice is worse than no feature.

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
| Flow grid at 28×28, heat grid at 64×64 | One shared resolution | Arrows need breathing room and a decent per-cell sample count; density maps want fine detail. Forcing one resolution makes both worse. | Two grid systems to keep straight; the compare layer uses the 64× grid, the flow layer the 28×. |
| Normalise before diffing in Compare A/B | Subtract raw counts | Raw counts just restate which slice has more rows. Shares answer whether players *redistributed*. | Absolute volume is lost; the right panel carries it instead. |
| Drop position transitions with `dt ≥ 30 s` | Interpolate across the gap | An invented straight line through a telemetry hole is a route no player took, and it would be indistinguishable from a real one. | Slightly fewer samples in the flow field. |
| Reconstruct extraction from exit clustering | Ship without the metric; or infer per-player from "positions stopped" | The population-level signal is overwhelming (24× excess, 0.6 % vs 82.8 % death rate) and it unlocks the genre's headline metric. Per-player inference would have been a fabricated number. | A ~12 % unresolved residual, and no loot-value-carried-out. Everything is labelled `inferred`. |
| Scorecard thresholds as named constants | Hard-code them in the UI; or omit flags entirely | A flag is only useful if you can see and contest the line that produced it. One constant, documented, surfaced in the tooltip. | They are judgements, not benchmarks, and the doc has to keep saying so. |
| No composite "map score" | One headline number per map | Averaging unrelated dimensions hides a catastrophic metric behind healthy ones, and the units are meaningless. | No single-number ranking; the UI ranks by count of critical flags instead. |
| `user_id` shape for bot detection | Trust event-name prefixes | It's an identity property and `BotPosition` corroborates it perfectly. | ~500 rows have contradictory event names; counted, not hidden. |

---

## 6. How I used AI

Used heavily and deliberately, on the leaves rather than the trunk.

**Where it earned its keep:** deck.gl layer boilerplate and prop signatures, the RDP implementation, CSS scaffolding, TypeScript error clean-up, and docs formatting. Easily a 3–4× speed-up on volume work.

**Where I overrode it:** every architectural and product decision. AI's default suggestion for "visualise telemetry" was a Streamlit dashboard, then a DuckDB-WASM + React stack — the first too crude, the second over-engineered for 89k rows. It also happily consumed `ts` as written, which silently dates the entire dataset to 1970, and it had no opinion on splitting Aggregate from Replay or on inverting the traffic heatmap to find dead zones.

The judgment calls that matter here — *reinterpret the timestamp*, *right-size the stack downward*, *validate coordinates against map labels instead of asserting them*, *build the inverse heatmap because the brief asked which areas get ignored* — all came from reading the data and the brief closely. The speed came from the tools.
