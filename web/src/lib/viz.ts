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
