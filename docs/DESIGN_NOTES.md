# Design notes

`ARCHITECTURE.md` is the one-page overview the brief asked for. This file is the
appendix: the derivations, the statistics and the design arguments behind each
layer, for anyone who wants to check the working rather than take it on trust.

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


## 3e-ii. Marker design: shape carries meaning, colour repeats it

Two of the brief's must-have lines are visual, not analytical: tell humans and
bots apart, and give each event type a distinct marker. An earlier revision
encoded both with colour alone and drew every marker as a circle, which failed
both lines — and the code contained a `square` flag that was threaded through
the layer factory and then never actually applied.

Markers are now an **icon atlas**, generated once on a canvas at runtime
(`web/src/lib/glyphs.tsx`) and drawn with deck.gl's `IconLayer`:

| Channel | Encodes | Values |
|---|---|---|
| **Shape** | what happened | star = kill · saltire = death · square = loot · hexagon = storm |
| **Fill** | who did it | solid = human · outlined = bot |
| **Colour** | what happened (again) | amber · red · cyan · magenta |
| **Line style** | who did it (routes) | solid = human · dashed = bot |

Colour is deliberately **redundant** with shape rather than load-bearing. A
greyscale capture, a washed-out projector, or a red–green colourblind reviewer
all still read the map correctly. In Replay the live player token is a filled
diamond for a human and a hollow triangle for a bot, because that token is what
the eye tracks during playback.

Every glyph is a **closed polygon**, which is why death is a saltire polygon
rather than two crossed strokes — a closed path has both a filled and an
outlined variant, so the human/bot channel works on all five shapes.

`polygon()` is the single source of truth for the vertices and feeds both the
canvas atlas and the inline SVG in the legend, so the legend cannot drift out of
sync with the map. Bot route dashes are generated on the CPU rather than with
`PathStyleExtension`, to avoid taking a dependency for one visual effect.

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


## 6. How I used AI

Used heavily and deliberately, on the leaves rather than the trunk.

**Where it earned its keep:** deck.gl layer boilerplate and prop signatures, the RDP implementation, CSS scaffolding, TypeScript error clean-up, and docs formatting. Easily a 3–4× speed-up on volume work.

**Where I overrode it:** every architectural and product decision. AI's default suggestion for "visualise telemetry" was a Streamlit dashboard, then a DuckDB-WASM + React stack — the first too crude, the second over-engineered for 89k rows. It also happily consumed `ts` as written, which silently dates the entire dataset to 1970, and it had no opinion on splitting Aggregate from Replay or on inverting the traffic heatmap to find dead zones.

The judgment calls that matter here — *reinterpret the timestamp*, *right-size the stack downward*, *validate coordinates against map labels instead of asserting them*, *build the inverse heatmap because the brief asked which areas get ignored* — all came from reading the data and the brief closely. The speed came from the tools.
