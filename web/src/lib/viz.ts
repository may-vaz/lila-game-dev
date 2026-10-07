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

export const EVENT_COLORS: Record<EventKind, [number, number, number]> = {
  kill: [255, 176, 46],
  death: [255, 59, 92],
  loot: [34, 211, 238],
  storm: [168, 85, 247],
  other: [148, 163, 184],
};

export const EVENT_LABEL: Record<EventKind, string> = {
  kill: 'Kill',
  death: 'Death',
  loot: 'Loot',
  storm: 'Storm death',
  other: 'Other',
};

export const HUMAN_COLOR: [number, number, number] = [74, 222, 128];
export const BOT_COLOR: [number, number, number] = [100, 116, 139];

/** Heatmap gradient: transparent -> deep blue -> cyan -> amber -> white-hot */
export const HEAT_RANGE: [number, number, number, number][] = [
  [30, 64, 140, 55],
  [21, 101, 192, 120],
  [34, 211, 238, 170],
  [255, 176, 46, 205],
  [255, 122, 26, 232],
  [255, 245, 235, 255],
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
    [0.0, [72, 100, 140]],
    [0.35, [34, 211, 238]],
    [0.7, [255, 176, 46]],
    [1.0, [255, 240, 220]],
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
  return t >= 0 ? [255, 70, 96, a] : [64, 140, 255, a];
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
