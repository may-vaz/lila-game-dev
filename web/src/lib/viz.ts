import type { EventKind } from '../types';

/**
 * The whole app works in a fixed 1024x1024 "minimap space".
 *
 *   u = (worldX - originX) / scale        // 0..1
 *   v = (worldZ - originZ) / scale        // 0..1
 *   px =        u  * SIZE
 *   py = (1  -  v) * SIZE                 // image origin is top-left
 *
 * The pipeline already emits u/v, so the client only applies the final
 * scale + Y flip. SIZE is arbitrary - it exists so deck.gl zoom levels and
 * pixel radii are easy to reason about, and so the renderer is completely
 * independent of the real minimap resolution (which is 2160-9000px and is
 * NOT the 1024 the dataset README claims).
 */
export const SIZE = 1024;

export const toPx = (u: number, v: number): [number, number] => [u * SIZE, (1 - v) * SIZE];

/**
 * Event palette, sampled from the LILA BLACK key art in the brief.
 * The mapping is semantic as well as decorative: the storm really is the
 * magenta vortex from the artwork, and the death red is the glowing eye.
 */
export const EVENT_COLORS: Record<EventKind, [number, number, number]> = {
  kill: [255, 176, 46],   // the jacket
  death: [240, 56, 74],   // the eye
  loot: [34, 211, 238],   // atmosphere teal
  storm: [194, 74, 224],  // the vortex
  other: [139, 163, 171],
};

export const EVENT_LABEL: Record<EventKind, string> = {
  kill: 'Kill',
  death: 'Death',
  loot: 'Loot',
  storm: 'Storm death',
  other: 'Other',
};

export const HUMAN_COLOR: [number, number, number] = [142, 224, 60];  // foliage lime
export const BOT_COLOR: [number, number, number] = [90, 122, 133];    // desaturated teal-slate

/** Heatmap gradient: transparent -> deep blue -> cyan -> amber -> white-hot */
/** Heatmap gradient: deep teal -> cyan -> lime -> amber -> white-hot.
 *  Runs through the key art's own hues while keeping luminance monotonic,
 *  so it still reads correctly as low-to-high at a glance. */
export const HEAT_RANGE: [number, number, number, number][] = [
  [16, 58, 68, 58],
  [22, 112, 128, 125],
  [34, 200, 216, 170],
  [142, 224, 60, 200],
  [255, 160, 46, 230],
  [255, 246, 232, 255],
];

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

export function shortId(id: string, n = 8): string {
  return id.length <= n ? id : id.slice(0, n);
}

// ---------------------------------------------------------------------------
// Flow field
// ---------------------------------------------------------------------------

/**
 * Coherence ramp. Deliberately diverging rather than sequential, because the
 * two ends mean opposite things to a level designer:
 *   low  (slate blue)  players mill around here - a pocket, a hub, a dead end
 *   high (amber)       players cross here the same way every time - a corridor
 */
export function coherenceColor(c: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, c));
  const stops: [number, [number, number, number]][] = [
    [0.0, [58, 96, 108]],
    [0.35, [34, 211, 238]],
    [0.7, [255, 176, 46]],
    [1.0, [255, 242, 224]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (t <= b) {
      const k = (t - a) / (b - a);
      return [
        Math.round(ca[0] + (cb[0] - ca[0]) * k),
        Math.round(ca[1] + (cb[1] - ca[1]) * k),
        Math.round(ca[2] + (cb[2] - ca[2]) * k),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

export interface ArrowSeg {
  s: [number, number];
  t: [number, number];
  color: [number, number, number, number];
  cell: { gx: number; gy: number; coherence: number; speed: number; count: number; bearing: number };
}

/**
 * Turn a vector field into drawable geometry.
 *
 * deck.gl has no arrow primitive, so each arrow is three LineLayer segments
 * (a shaft plus two barbs) built here in plain JS. That is cheaper than it
 * sounds - the grid is 28x28, so the worst case is ~2.3k segments, and it
 * avoids shipping an icon atlas just to draw a triangle.
 *
 * Note the Y negation: v increases upward in map space but screen y increases
 * downward, so a "north" vector must be drawn with a negative pixel dy.
 */
export function buildArrows(
  flow: { n: number; dx: number[]; dy: number[]; coherence: number[]; speed: number[]; count: number[] },
  minCoherence: number,
): ArrowSeg[] {
  const { n } = flow;
  const cell = SIZE / n;
  const out: ArrowSeg[] = [];
  const maxCount = Math.max(1, ...flow.count);

  for (let i = 0; i < flow.count.length; i++) {
    const c = flow.coherence[i];
    const cnt = flow.count[i];
    if (!cnt || c < minCoherence) continue;

    const dx = flow.dx[i];
    const dy = flow.dy[i];
    if (dx === 0 && dy === 0) continue;

    const gx = i % n;
    const gy = Math.floor(i / n);
    const [cx, cy] = toPx((gx + 0.5) / n, (gy + 0.5) / n);

    // Arrow length encodes how well-travelled the cell is (log, because
    // traffic is heavily skewed), clamped so arrows never overlap neighbours.
    const vol = Math.log1p(cnt) / Math.log1p(maxCount);
    const len = cell * (0.34 + 0.54 * vol);

    const px = dx, py = -dy;            // map space -> screen space
    const hx = cx + px * len * 0.5, hy = cy + py * len * 0.5;
    const tx = cx - px * len * 0.5, ty = cy - py * len * 0.5;

    const rgb = coherenceColor(c);
    const alpha = Math.round(120 + 135 * Math.min(1, 0.35 + vol));
    const color: [number, number, number, number] = [rgb[0], rgb[1], rgb[2], alpha];

    // bearing in compass degrees, for the tooltip
    const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
    const meta = {
      gx, gy,
      coherence: c,
      speed: flow.speed[i],
      count: cnt,
      bearing: (bearing + 360) % 360,
    };

    out.push({ s: [tx, ty], t: [hx, hy], color, cell: meta });

    // barbs: rotate the shaft direction +/- 150 degrees, 36% of its length
    const bl = len * 0.36;
    for (const a of [2.618, -2.618]) {
      const ca = Math.cos(a), sa = Math.sin(a);
      out.push({
        s: [hx, hy],
        t: [hx + (px * ca - py * sa) * bl, hy + (px * sa + py * ca) * bl],
        color,
        cell: meta,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A/B comparison
// ---------------------------------------------------------------------------

/** Red = more in A, blue = more in B. Symmetric so neither side reads as "good". */
export function diffColor(d: number): [number, number, number, number] {
  const t = Math.max(-1, Math.min(1, d));
  // sqrt, not linear: the diff distribution is long-tailed, so a linear ramp
  // leaves everything but a couple of cells invisible.
  const a = Math.round(40 + 195 * Math.sqrt(Math.abs(t)));
  return t >= 0 ? [255, 74, 94, a] : [48, 184, 232, a];
}

/**
 * Normalise two grids to shares of their own total before subtracting.
 *
 * This is the whole point of the feature: raw counts would just show that
 * whichever slice has more samples is "bigger everywhere". Comparing shares
 * answers the real question - did the *distribution* of players move?
 */
export function diffGrids(a: number[], b: number[]): { diff: number[]; scale: number } {
  const sa = a.reduce((x, y) => x + y, 0) || 1;
  const sb = b.reduce((x, y) => x + y, 0) || 1;
  const diff = a.map((v, i) => v / sa - b[i] / sb);
  const scale = Math.max(1e-9, ...diff.map(Math.abs));
  return { diff, scale };
}

export const METRIC_LABEL: Record<string, string> = {
  traffic: 'All traffic',
  traffic_human: 'Human traffic',
  traffic_bot: 'Bot traffic',
  traffic_early: 'Early game (0–33%)',
  traffic_mid: 'Mid game (33–66%)',
  traffic_late: 'Late game (66–100%)',
  kills: 'Kills',
  deaths: 'Deaths',
  loot: 'Loot',
  storm: 'Storm deaths',
};

// ---------------------------------------------------------------------------
// Inferred run outcomes
// ---------------------------------------------------------------------------

export const OUTCOME_COLOR: Record<string, [number, number, number]> = {
  x: [52, 232, 160],    // extracted - mint
  d: [240, 56, 74],     // died      - the eye
  '?': [139, 163, 171], // unresolved
  b: [90, 122, 133],    // bot
};

export const OUTCOME_LABEL: Record<string, string> = {
  x: 'Extracted (inferred)',
  d: 'Died',
  '?': 'Unresolved',
  b: 'Bot',
};

export const EXFIL_COLOR: [number, number, number] = [52, 232, 160];

/** Format a Poisson tail probability for display without pretending to more precision than we have. */
export function fmtP(p: number): string {
  if (p === 0) return 'p < 1e-16';
  if (p < 1e-4) return `p ≈ ${p.toExponential(0)}`;
  return `p ≈ ${p.toFixed(4)}`;
}

export const STATUS_COLOR: Record<string, string> = {
  ok: '#34e8a0',
  warn: '#ffb02e',
  critical: '#f0384a',
};

/** CSS rgb() string from one of the palette triples above. */
export const rgbCss = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

// ---------------------------------------------------------------------------
// Spawn points
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

const mix = (a: RGB, b: RGB, t: number): RGB =>
  [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as RGB;

/** Spawn markers are squares, not circles, so they never read as exfil rings. */
export const SPAWN_COLOR: RGB = [255, 159, 46];

/**
 * Extraction rate -> colour, on a fixed scale rather than a relative one.
 * A relative scale would make the best spawn on a badly balanced map look
 * healthy; anchoring to the ~30% game-wide rate keeps maps comparable.
 */
export function spawnRateColor(rate: number): RGB {
  const t = Math.max(0, Math.min(1, rate / 0.45));
  return t < 0.5
    ? mix([240, 56, 74], [255, 176, 46], t * 2)
    : mix([255, 176, 46], [142, 224, 60], (t - 0.5) * 2);
}

// ---------------------------------------------------------------------------
// Loot economy
// ---------------------------------------------------------------------------
//
// Loot is 78.9% of all recorded events - by far the biggest lever a level
// designer actually controls - but a flat loot heatmap only answers "where is
// loot picked up", which is mostly a restatement of "where do players walk"
// (r = 0.80 on Ambrose). The designer question is the ratio one: per unit of
// foot traffic, what does a cell PAY, and what does it COST?
//
//   reward = loot pickups / visits
//   risk   = (kills + deaths) / visits
//
// Splitting both at the map median gives the four-way classification that
// loot-balance teams use. Deaths alone are too sparse to split on (median 0),
// which is why risk folds in kills.

export type Quadrant = 'honeypot' | 'freefarm' | 'deathtrap' | 'barren';

export const QUADRANT_COLOR: Record<Quadrant, RGB> = {
  honeypot: [255, 176, 46],   // pays well, hurts     -> the intended tension
  freefarm: [142, 224, 60],   // pays well, safe      -> too generous
  deathtrap: [240, 56, 74],   // pays nothing, hurts  -> punishes for free
  barren: [90, 122, 133],     // pays nothing, safe   -> dead space
};

export const QUADRANT_LABEL: Record<Quadrant, string> = {
  honeypot: 'Honeypot — high reward, high risk',
  freefarm: 'Free farm — high reward, low risk',
  deathtrap: 'Deathtrap — low reward, high risk',
  barren: 'Barren — low reward, low risk',
};

export interface EconCell {
  i: number;
  reward: number;
  risk: number;
  visits: number;
  loot: number;
  q: Quadrant;
}

export interface Economy {
  cells: EconCell[];
  medReward: number;
  medRisk: number;
  counts: Record<Quadrant, number>;
  /** cells with real footfall that yield no loot at all */
  deserts: number;
  /** Pearson r between loot volume and traffic. High = loot merely follows players. */
  corr: number;
  minVisits: number;
}

const ECON_MIN_VISITS = 20;

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function buildEconomy(grid: {
  n: number; playable: number[]; traffic: number[];
  loot: number[]; kills: number[]; deaths: number[];
}): Economy | null {
  const { traffic, loot, kills, deaths, playable } = grid;
  const idx: number[] = [];
  for (let i = 0; i < traffic.length; i++) {
    if (playable[i] && traffic[i] >= ECON_MIN_VISITS) idx.push(i);
  }
  if (idx.length < 24) return null;

  const reward = idx.map((i) => loot[i] / traffic[i]);
  const risk = idx.map((i) => (kills[i] + deaths[i]) / traffic[i]);
  const medReward = median(reward);
  const medRisk = median(risk);

  const counts: Record<Quadrant, number> = { honeypot: 0, freefarm: 0, deathtrap: 0, barren: 0 };
  const cells: EconCell[] = idx.map((i, k) => {
    const hiR = reward[k] > medReward;
    const hiK = risk[k] > medRisk;
    const q: Quadrant = hiR ? (hiK ? 'honeypot' : 'freefarm') : hiK ? 'deathtrap' : 'barren';
    counts[q]++;
    return { i, reward: reward[k], risk: risk[k], visits: traffic[i], loot: loot[i], q };
  });

  // Pearson r(loot, traffic) over the same cells.
  const xs = idx.map((i) => loot[i]);
  const ys = idx.map((i) => traffic[i]);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, dx = 0, dy = 0;
  for (let k = 0; k < xs.length; k++) {
    const a = xs[k] - mx, b = ys[k] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const corr = dx && dy ? num / Math.sqrt(dx * dy) : 0;

  return {
    cells,
    medReward,
    medRisk,
    counts,
    deserts: cells.filter((c) => c.loot === 0).length,
    corr,
    minVisits: ECON_MIN_VISITS,
  };
}
