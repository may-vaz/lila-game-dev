/**
 * Glyph system: shape carries meaning, not just colour.
 * ---------------------------------------------------------------------------
 * The brief has two separate must-have lines that a colour-only encoding fails:
 *
 *   - "Distinguish between human players and bots visually"
 *   - "Show different event types (kills, deaths, loot, storm deaths) as
 *      distinct markers"
 *
 * Two orthogonal channels are needed, so they get two orthogonal encodings:
 *
 *   SHAPE  = what happened   (star = kill, saltire = death, square = loot,
 *                             hexagon = storm)
 *   FILL   = who did it      (solid = human, hollow = bot)
 *   COLOUR = what happened   (redundant with shape, on purpose)
 *
 * Colour is deliberately redundant rather than load-bearing. A greyscale
 * screenshot, a projector with crushed blacks, or a red-green colourblind
 * reviewer all still read the map correctly. That is the whole point.
 *
 * Every shape below is a CLOSED polygon, including the death saltire, so each
 * one has both a filled and an outlined variant. That constraint is why death
 * is a saltire polygon rather than two crossed strokes.
 *
 * One source of truth: `polygon()` feeds both the canvas icon atlas used by
 * deck.gl and the inline SVG used by the legend. The legend cannot drift out
 * of sync with the map because they are literally the same vertices.
 */

import type { EventKind } from '../types';

// ---------------------------------------------------------------------------
// Shape geometry
// ---------------------------------------------------------------------------

export type GlyphShape = 'star' | 'saltire' | 'square' | 'hexagon' | 'circle' | 'diamond' | 'triangle';

/** Which shape stands for which event. */
export const EVENT_SHAPE: Record<EventKind, GlyphShape> = {
  kill: 'star',
  death: 'saltire',
  loot: 'square',
  storm: 'hexagon',
  other: 'circle',
};

/** Actor shapes, used for the live position token in Replay. */
export const ACTOR_SHAPE = { human: 'diamond' as GlyphShape, bot: 'triangle' as GlyphShape };

type Pt = [number, number];

/**
 * Unit polygon for a shape, centred on (0,0) inside a radius-1 circle.
 * Returned counter-clockwise. `circle` is approximated with 24 segments so
 * that every shape can go down the same fill/stroke path.
 */
export function polygon(shape: GlyphShape): Pt[] {
  const P = (deg: number, r: number): Pt => {
    const a = (deg * Math.PI) / 180;
    return [Math.cos(a) * r, -Math.sin(a) * r];
  };

  switch (shape) {
    case 'star': {
      // 4-pointed star: sharp, reads as an impact / hit marker.
      const out: Pt[] = [];
      for (let i = 0; i < 4; i++) {
        out.push(P(90 - i * 90, 1));
        out.push(P(45 - i * 90, 0.38));
      }
      return out;
    }
    case 'saltire': {
      // A plus-sign polygon rotated 45 degrees -> an X that is still a closed
      // path, so it can be filled (human) or outlined (bot).
      const w = 0.3, l = 1.0;
      const plus: Pt[] = [
        [w, l], [w, w], [l, w], [l, -w], [w, -w], [w, -l],
        [-w, -l], [-w, -w], [-l, -w], [-l, w], [-w, w], [-w, l],
      ];
      const c = Math.SQRT1_2;
      return plus.map(([x, y]) => [x * c - y * c, x * c + y * c] as Pt);
    }
    case 'square': {
      const s = 0.8;
      return [[-s, -s], [s, -s], [s, s], [-s, s]];
    }
    case 'hexagon':
      return [0, 1, 2, 3, 4, 5].map((i) => P(90 + i * 60, 1));
    case 'diamond':
      return [0, 1, 2, 3].map((i) => P(90 + i * 90, 1));
    case 'triangle':
      return [P(90, 1), P(210, 1), P(330, 1)];
    case 'circle':
    default:
      return Array.from({ length: 24 }, (_, i) => P((i * 360) / 24, 1));
  }
}

// ---------------------------------------------------------------------------
// Canvas icon atlas for deck.gl's IconLayer
// ---------------------------------------------------------------------------
//
// Every glyph is drawn in WHITE on transparent and flagged `mask: true`, so
// deck.gl tints it per-datum via getColor. One 12-icon atlas therefore covers
// every event colour, the selection highlight and the outcome palette without
// ever being regenerated.

const CELL = 64;           // atlas cell, in px
const PAD = 5;             // keeps strokes from clipping at the cell edge
const STROKE = 8.5;        // hollow-variant line width, in atlas px

export type GlyphName =
  | `${GlyphShape}-solid`
  | `${GlyphShape}-hollow`;

const ALL_SHAPES: GlyphShape[] = ['star', 'saltire', 'square', 'hexagon', 'circle', 'diamond', 'triangle'];

/** iconMapping handed to deck.gl. */
export const ICON_MAPPING: Record<string, {
  x: number; y: number; width: number; height: number;
  anchorX: number; anchorY: number; mask: boolean;
}> = {};

{
  let i = 0;
  for (const shape of ALL_SHAPES) {
    for (const variant of ['solid', 'hollow'] as const) {
      ICON_MAPPING[`${shape}-${variant}`] = {
        x: i * CELL, y: 0, width: CELL, height: CELL,
        anchorX: CELL / 2, anchorY: CELL / 2, mask: true,
      };
      i++;
    }
  }
}

let atlasUrl: string | null = null;

/**
 * Build (once) and return the icon atlas as a data URL.
 * Lazy because it needs `document`; cached because it never changes.
 */
export function glyphAtlas(): string {
  if (atlasUrl) return atlasUrl;

  const n = ALL_SHAPES.length * 2;
  const cv = document.createElement('canvas');
  cv.width = n * CELL;
  cv.height = CELL;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineJoin = 'round';

  let i = 0;
  for (const shape of ALL_SHAPES) {
    for (const variant of ['solid', 'hollow'] as const) {
      const cx = i * CELL + CELL / 2;
      const cy = CELL / 2;
      const r = CELL / 2 - PAD - (variant === 'hollow' ? STROKE / 2 : 0);

      ctx.beginPath();
      polygon(shape).forEach(([x, y], k) => {
        const px = cx + x * r;
        const py = cy + y * r;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();

      if (variant === 'solid') {
        ctx.fill();
      } else {
        ctx.lineWidth = STROKE;
        ctx.stroke();
      }
      i++;
    }
  }

  atlasUrl = cv.toDataURL('image/png');
  return atlasUrl;
}

/** Icon name for a discrete event: shape by kind, fill by actor. */
export function eventIcon(kind: EventKind, isBot: boolean | 0 | 1): GlyphName {
  const shape = EVENT_SHAPE[kind] ?? 'circle';
  return `${shape}-${isBot ? 'hollow' : 'solid'}` as GlyphName;
}

/** Icon name for a live player token in Replay. */
export function actorIcon(isBot: boolean | 0 | 1): GlyphName {
  return isBot ? 'triangle-hollow' : 'diamond-solid';
}

/** On-screen pixel size per event kind. Storm reads largest, loot smallest. */
export function eventGlyphSize(kind: EventKind): number {
  if (kind === 'storm') return 17;
  if (kind === 'loot') return 10;
  if (kind === 'death') return 14;
  return 14;
}

// ---------------------------------------------------------------------------
// Dashed paths, without pulling in @deck.gl/extensions
// ---------------------------------------------------------------------------

/**
 * Split a polyline into dash segments so bot routes read as dashed and human
 * routes as solid. Done on the CPU rather than with PathStyleExtension to
 * avoid adding a dependency for one visual effect, and because the vertex
 * count here is small (bots are a minority of journeys).
 *
 * `dash` and `gap` are in the same units as the path (map px, where the map
 * is SIZE units across).
 */
export function dashPath(path: Pt[] | number[][], dash = 9, gap = 7): number[][][] {
  const out: number[][][] = [];
  if (!path || path.length < 2) return out;

  let seg: number[][] = [];
  let drawing = true;
  let budget = dash;

  let [px, py] = path[0] as number[];
  seg.push([px, py]);

  for (let i = 1; i < path.length; i++) {
    let [qx, qy] = path[i] as number[];
    let remaining = Math.hypot(qx - px, qy - py);

    while (remaining > budget) {
      const t = budget / remaining;
      const mx = px + (qx - px) * t;
      const my = py + (qy - py) * t;

      if (drawing) {
        seg.push([mx, my]);
        if (seg.length > 1) out.push(seg);
        seg = [];
      } else {
        seg = [[mx, my]];
      }

      drawing = !drawing;
      px = mx;
      py = my;
      remaining -= budget;
      budget = drawing ? dash : gap;
    }

    budget -= remaining;
    if (drawing) seg.push([qx, qy]);
    px = qx;
    py = qy;
  }

  if (drawing && seg.length > 1) out.push(seg);
  return out;
}

// ---------------------------------------------------------------------------
// Legend rendering — same geometry, drawn as inline SVG
// ---------------------------------------------------------------------------

export function GlyphSwatch({
  shape,
  hollow = false,
  color,
  size = 13,
}: {
  shape: GlyphShape;
  hollow?: boolean;
  color: string;
  size?: number;
}) {
  const r = hollow ? 44 : 48;
  const pts = polygon(shape)
    .map(([x, y]) => `${(50 + x * r).toFixed(1)},${(50 + y * r).toFixed(1)}`)
    .join(' ');
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      style={{ flex: 'none', display: 'block', overflow: 'visible' }}
      aria-hidden="true"
    >
      <polygon
        points={pts}
        fill={hollow ? 'none' : color}
        stroke={hollow ? color : 'none'}
        strokeWidth={hollow ? 13 : 0}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A human glyph and its bot counterpart, side by side. */
export function GlyphPair({
  shape,
  color,
  size = 13,
}: {
  shape: GlyphShape;
  color: string;
  size?: number;
}) {
  return (
    <span style={{ display: 'flex', gap: 3, flex: 'none', alignItems: 'center' }}>
      <GlyphSwatch shape={shape} color={color} size={size} />
      <GlyphSwatch shape={shape} color={color} size={size} hollow />
    </span>
  );
}

/** Short line of text teaching the encoding. Rendered above the glyph rows. */
export function GlyphRule() {
  return (
    <div
      style={{
        color: 'var(--text-3)',
        fontSize: 9.5,
        lineHeight: 1.35,
        margin: '0 0 6px',
        maxWidth: 210,
      }}
    >
      Shape = what happened · solid = human, outlined = bot
    </div>
  );
}