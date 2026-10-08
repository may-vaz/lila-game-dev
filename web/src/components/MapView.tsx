import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView, COORDINATE_SYSTEM } from '@deck.gl/core';
import { BitmapLayer, PathLayer, ScatterplotLayer, PolygonLayer, LineLayer, TextLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import { TripsLayer } from '@deck.gl/geo-layers';

import { useStore } from '../store';
import { useFiltered } from '../lib/useFiltered';
import {
  SIZE, toPx, EVENT_COLORS, EVENT_LABEL, HUMAN_COLOR, BOT_COLOR, HEAT_RANGE, fmtTime, shortId,
  buildArrows, diffGrids, diffColor, METRIC_LABEL, OUTCOME_COLOR, EXFIL_COLOR, fmtP,
  coherenceColor, rgbCss, SPAWN_COLOR, spawnRateColor, buildEconomy,
  QUADRANT_COLOR, QUADRANT_LABEL,
} from '../lib/viz';
import type { GameEvent, Journey } from '../types';

const INITIAL = { target: [SIZE / 2, SIZE / 2, 0], zoom: -0.2, minZoom: -2.5, maxZoom: 6 };

/** zoom level that makes the 1024-unit map exactly fill the smaller viewport axis */
function fitZoom(w: number, h: number) {
  if (!w || !h) return -0.2;
  return Math.log2((Math.min(w, h) * 0.94) / SIZE);
}

interface Hover { x: number; y: number; obj: any; kind: 'event' | 'path' | 'cell' | 'flow' | 'diff' | 'exfil' | 'spawn' | 'econ' }

export default function MapView() {
  const bundle = useStore((s) => s.bundle)!;
  const f = useStore((s) => s.filters);
  const mode = useStore((s) => s.mode);
  const time = useStore((s) => s.time);
  const debug = useStore((s) => s.debug);
  const selected = useStore((s) => s.selectedJourney);
  const select = useStore((s) => s.select);
  const region = useStore((s) => s.region);
  const setRegion = useStore((s) => s.setRegion);

  const { journeys, events, match } = useFiltered();
  const [hover, setHover] = useState<Hover | null>(null);
  const [viewState, setViewState] = useState<any>(INITIAL);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);

  // Fit the map to the stage on first paint and whenever the stage resizes.
  useEffect(() => {
    const el = wrapRef.current?.parentElement;
    if (!el) return;
    const apply = (first: boolean) => {
      const r = el.getBoundingClientRect();
      const z = fitZoom(r.width, r.height);
      setViewState((v: any) =>
        first || !fitted.current
          ? { ...v, zoom: z, target: [SIZE / 2, SIZE / 2, 0] }
          : v,
      );
      fitted.current = true;
    };
    apply(true);
    const ro = new ResizeObserver(() => apply(false));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const refit = useCallback(() => {
    const el = wrapRef.current?.parentElement;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setViewState((v: any) => ({ ...v, zoom: fitZoom(r.width, r.height), target: [SIZE / 2, SIZE / 2, 0] }));
  }, []);

  useEffect(() => {
    const h = () => refit();
    window.addEventListener('lila:fit', h);
    return () => window.removeEventListener('lila:fit', h);
  }, [refit]);

  // ---- rectangle (region) selection -------------------------------------
  const drag = useRef<{ u: number; v: number } | null>(null);
  const [live, setLive] = useState<[number, number, number, number] | null>(null);

  const meta = bundle.maps[f.mapId];
  const grid = bundle.grids[f.mapId];
  const flow = bundle.flow?.[f.mapId];
  const exfil = bundle.exfil?.[f.mapId];
  const spawns = bundle.spawns?.[f.mapId];
  // Derived on the client from the grid already in the bundle - no extra
  // payload, and it stays correct if the grid definition ever changes.
  const econ = useMemo(() => (grid ? buildEconomy(grid) : null), [grid]);

  // -------------------------------------------------------------- layers
  const layers = useMemo(() => {
    const L: any[] = [];
    const inReplay = mode === 'replay';

    // 1. minimap --------------------------------------------------------
    L.push(
      new BitmapLayer({
        id: `minimap-${f.mapId}`,
        image: `${import.meta.env.BASE_URL}${meta.image}`,
        // [left, bottom, right, top] - top=0 because our Y axis points down
        bounds: [0, SIZE, SIZE, 0],
        // Any analytical overlay needs the basemap pushed back or it fights
        // the data for attention; raw journeys read better at full brightness.
        opacity: f.showHeat || f.showDiff ? 0.6 : f.showFlow ? 0.72 : 1.0,
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        pickable: false,
      }),
    );

    // 2. heatmap --------------------------------------------------------
    if (f.showHeat) {
      const n = grid.n;
      const cells = grid[f.heatMetric] as number[];
      const pts: { p: [number, number]; w: number }[] = [];
      for (let i = 0; i < cells.length; i++) {
        const w = cells[i];
        if (!w) continue;
        const gx = i % n, gy = Math.floor(i / n);
        pts.push({ p: toPx((gx + 0.5) / n, (gy + 0.5) / n), w });
      }
      L.push(
        new HeatmapLayer({
          id: `heat-${f.mapId}-${f.heatMetric}`,
          data: pts,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getPosition: (d: any) => d.p,
          getWeight: (d: any) => d.w,
          radiusPixels: 36,
          intensity: 1.1,
          threshold: 0.06,
          colorRange: HEAT_RANGE,
          opacity: 0.8,
        } as any),
      );
    }

    // 3. dead zones (inverse traffic) ------------------------------------
    if (f.showDead) {
      const n = grid.n;
      const cells = grid.traffic as number[];
      const playable = grid.playable as number[];
      const max = Math.max(...cells);
      const cut = Math.max(1, max * 0.005);
      const polys: any[] = [];
      for (let i = 0; i < cells.length; i++) {
        // only reachable ground counts - the void outside the island is not
        // a "dead zone", it is simply not part of the level
        if (!playable[i]) continue;
        if (cells[i] > cut) continue;
        const gx = i % n, gy = Math.floor(i / n);
        const u0 = gx / n, u1 = (gx + 1) / n, v0 = gy / n, v1 = (gy + 1) / n;
        polys.push({
          c: [toPx(u0, v0), toPx(u1, v0), toPx(u1, v1), toPx(u0, v1)],
          n: cells[i],
        });
      }
      L.push(
        new PolygonLayer({
          id: 'deadzones',
          data: polys,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getPolygon: (d: any) => d.c,
          getFillColor: [255, 59, 92, 46],
          getLineColor: [255, 59, 92, 90],
          getLineWidth: 1,
          lineWidthUnits: 'pixels',
          stroked: true,
          filled: true,
          pickable: true,
          onHover: (i: any) =>
            setHover(i.object ? { x: i.x, y: i.y, obj: i.object, kind: 'cell' } : null),
        }),
      );
    }

    // 3b. A/B comparison -------------------------------------------------
    // Two slices of the same map, normalised to shares and subtracted, so the
    // question answered is "did players REDISTRIBUTE" rather than "which
    // slice has more rows". Red = more in A, blue = more in B.
    if (f.showDiff) {
      const n = grid.n;
      const A = grid[f.cmpA] as number[];
      const B = grid[f.cmpB] as number[];
      const playable = grid.playable as number[];
      const { diff, scale } = diffGrids(A, B);
      const polys: any[] = [];
      for (let i = 0; i < diff.length; i++) {
        if (!playable[i]) continue;
        const d = diff[i] / scale;
        if (Math.abs(d) < 0.06) continue;   // suppress rounding fuzz
        const gx = i % n, gy = Math.floor(i / n);
        const u0 = gx / n, u1 = (gx + 1) / n, v0 = gy / n, v1 = (gy + 1) / n;
        polys.push({
          c: [toPx(u0, v0), toPx(u1, v0), toPx(u1, v1), toPx(u0, v1)],
          d,
          a: A[i],
          b: B[i],
        });
      }
      L.push(
        new PolygonLayer({
          id: `diff-${f.mapId}-${f.cmpA}-${f.cmpB}`,
          data: polys,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getPolygon: (d: any) => d.c,
          getFillColor: (d: any) => diffColor(d.d),
          stroked: false,
          filled: true,
          pickable: true,
          updateTriggers: { getFillColor: [f.cmpA, f.cmpB] },
          onHover: (i: any) =>
            setHover(i.object ? { x: i.x, y: i.y, obj: i.object, kind: 'diff' } : null),
        }),
      );
    }

    // 3b-ii. loot economy --------------------------------------------------
    // Reward (loot per visit) vs risk (kills+deaths per visit), each split at
    // the map median, painted as four quadrants. See lib/viz.ts buildEconomy.
    if (f.showEconomy && econ) {
      const n = grid.n;
      const polys = econ.cells.map((c) => {
        const gx = c.i % n, gy = Math.floor(c.i / n);
        return {
          c: [toPx(gx / n, gy / n), toPx((gx + 1) / n, gy / n),
              toPx((gx + 1) / n, (gy + 1) / n), toPx(gx / n, (gy + 1) / n)],
          d: c,
        };
      });
      L.push(
        new PolygonLayer({
          id: `econ-${f.mapId}`,
          data: polys,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getPolygon: (d: any) => d.c,
          getFillColor: (d: any) => [...QUADRANT_COLOR[d.d.q as keyof typeof QUADRANT_COLOR], 165] as any,
          stroked: false,
          filled: true,
          pickable: true,
          onHover: (i: any) =>
            setHover(i.object ? { x: i.x, y: i.y, obj: i.object.d, kind: 'econ' } : null),
        }),
      );
    }

    // 3c. flow field -------------------------------------------------------
    // Arrows are three line segments each, built on the CPU in lib/viz.ts.
    if (f.showFlow && flow) {
      const segs = buildArrows(flow, f.flowMin);
      L.push(
        new LineLayer({
          id: `flow-${f.mapId}`,
          data: segs,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getSourcePosition: (d: any) => d.s,
          getTargetPosition: (d: any) => d.t,
          getColor: (d: any) => d.color,
          getWidth: 1.7,
          widthUnits: 'pixels',
          widthMinPixels: 1.2,
          pickable: true,
          updateTriggers: { getColor: [f.flowMin] },
          onHover: (i: any) =>
            setHover(i.object ? { x: i.x, y: i.y, obj: i.object.cell, kind: 'flow' } : null),
        }),
      );
    }

    // 3d. inferred exfil zones --------------------------------------------
    // Recovered from exit clustering, not read from an event - see
    // ARCHITECTURE.md section 3c. Rendered as a ring rather than a solid
    // marker to keep it visually distinct from recorded events, because it
    // is an inference and should not be mistaken for ground truth.
    if (f.showExfil && exfil && exfil.zones.length) {
      const z = exfil.zones;
      const maxExits = Math.max(...z.map((d) => d.exits));
      L.push(
        new ScatterplotLayer({
          id: `exfil-halo-${f.mapId}`,
          data: z,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getPosition: (d: any) => toPx(d.u, d.v),
          getRadius: (d: any) => 11 + 17 * Math.sqrt(d.exits / maxExits),
          radiusUnits: 'pixels',
          filled: true,
          getFillColor: [...EXFIL_COLOR, 38] as any,
          pickable: false,
        }),
      );
      L.push(
        new ScatterplotLayer({
          id: `exfil-${f.mapId}`,
          data: z,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getPosition: (d: any) => toPx(d.u, d.v),
          getRadius: (d: any) => 11 + 17 * Math.sqrt(d.exits / maxExits),
          radiusUnits: 'pixels',
          filled: false,
          stroked: true,
          getLineColor: [...EXFIL_COLOR, 235] as any,
          getLineWidth: 2,
          lineWidthUnits: 'pixels',
          pickable: true,
          onHover: (i: any) =>
            setHover(i.object ? { x: i.x, y: i.y, obj: i.object, kind: 'exfil' } : null),
        }),
      );
      L.push(
        new TextLayer({
          id: `exfil-label-${f.mapId}`,
          data: z,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getPosition: (d: any) => toPx(d.u, d.v),
          getText: (d: any) => `EXFIL · ${d.exits}`,
          getSize: 10,
          sizeUnits: 'pixels',
          getColor: [...EXFIL_COLOR, 255] as any,
          getPixelOffset: [0, -26],
          fontFamily: 'ui-monospace, monospace',
          characterSet: 'auto',
          background: true,
          getBackgroundColor: [8, 12, 20, 190],
          backgroundPadding: [5, 2, 5, 2],
          pickable: false,
        } as any),
      );
    }

    // 3e. spawn points -----------------------------------------------------
    // Squares, deliberately unlike the exfil rings: these are observed first
    // positions, not an inference. Fill encodes the zone's extraction rate on
    // a fixed 0-45% scale so maps stay comparable, and zones below
    // spawns.min_runs are drawn hollow because their rate is not yet real.
    if (f.showSpawns && spawns && spawns.zones.length) {
      const z = spawns.zones;
      const maxRuns = Math.max(...z.map((d) => d.runs));
      const size = (d: any) => 13 + 15 * Math.sqrt(d.runs / maxRuns);
      L.push(
        new ScatterplotLayer({
          id: `spawn-${f.mapId}`,
          data: z,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getPosition: (d: any) => toPx(d.u, d.v),
          getRadius: size,
          radiusUnits: 'pixels',
          filled: true,
          stroked: true,
          getFillColor: (d: any) =>
            (d.runs >= spawns.min_runs
              ? [...spawnRateColor(d.rate), 210]
              : [...SPAWN_COLOR, 30]) as any,
          getLineColor: (d: any) =>
            (d.runs >= spawns.min_runs ? [10, 16, 20, 230] : [...SPAWN_COLOR, 190]) as any,
          getLineWidth: 1.5,
          lineWidthUnits: 'pixels',
          pickable: true,
          updateTriggers: { getFillColor: [f.mapId] },
          onHover: (i: any) =>
            setHover(i.object ? { x: i.x, y: i.y, obj: i.object, kind: 'spawn' } : null),
        }),
      );
      L.push(
        new TextLayer({
          id: `spawn-label-${f.mapId}`,
          data: z.filter((d) => d.runs >= spawns.min_runs),
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getPosition: (d: any) => toPx(d.u, d.v),
          getText: (d: any) => `${Math.round(d.rate * 100)}%`,
          getSize: 10,
          getColor: [8, 14, 18, 255],
          fontWeight: 700,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          pickable: false,
        }),
      );
    }

    // 4. paths -----------------------------------------------------------
    if (f.showPaths && !inReplay) {
      // Aggregate mode: static full journeys. Bots dimmed + thinner.
      const data = journeys.map((j) => ({
        j,
        path: j.x.map((u, i) => toPx(u, j.y[i])),
      }));
      L.push(
        new PathLayer({
          id: 'paths',
          data,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getPath: (d: any) => d.path,
          getColor: (d: any) =>
            d.j.i === selected
              ? [255, 122, 26, 255]
              : f.colorByOutcome
              ? [...OUTCOME_COLOR[d.j.o ?? '?'], d.j.b ? 42 : 130]
              : d.j.b
              ? [...BOT_COLOR, 42]
              : [...HUMAN_COLOR, 120],
          getWidth: (d: any) => (d.j.i === selected ? 3 : d.j.b ? 1 : 1.6),
          widthUnits: 'pixels',
          widthMinPixels: 1,
          capRounded: true,
          jointRounded: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 122, 26, 220],
          onClick: (i: any) => i.object && select(i.object.j.i),
          onHover: (i: any) =>
            setHover(i.object ? { x: i.x, y: i.y, obj: i.object.j, kind: 'path' } : null),
          updateTriggers: { getColor: [selected], getWidth: [selected] },
        }),
      );
    }

    if (f.showPaths && inReplay) {
      // Replay mode: animated fading trails.
      const trips = journeys.map((j) => ({
        j,
        path: j.x.map((u, i) => toPx(u, j.y[i])),
        ts: j.t,
      }));
      L.push(
        new TripsLayer({
          id: 'trips',
          data: trips,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getPath: (d: any) => d.path,
          getTimestamps: (d: any) => d.ts,
          getColor: (d: any) =>
            d.j.i === selected
              ? [255, 122, 26]
              : f.colorByOutcome
              ? OUTCOME_COLOR[d.j.o ?? '?']
              : d.j.b
              ? BOT_COLOR
              : HUMAN_COLOR,
          getWidth: (d: any) => (d.j.i === selected ? 3.2 : d.j.b ? 1.2 : 2),
          widthUnits: 'pixels',
          widthMinPixels: 1.2,
          opacity: 0.95,
          trailLength: 45,
          currentTime: time,
          fadeTrail: true,
          capRounded: true,
          jointRounded: true,
          pickable: true,
          onClick: (i: any) => i.object && select(i.object.j.i),
          onHover: (i: any) =>
            setHover(i.object ? { x: i.x, y: i.y, obj: i.object.j, kind: 'path' } : null),
          updateTriggers: { getColor: [selected], getWidth: [selected] },
        } as any),
      );

      // Current position dot for every active player
      const heads: any[] = [];
      for (const j of journeys) {
        const idx = lastIndexAtOrBefore(j.t, time);
        if (idx < 0) continue;
        if (time - j.t[idx] > 25) continue; // stale -> player gone
        heads.push({ j, p: toPx(j.x[idx], j.y[idx]) });
      }
      L.push(
        new ScatterplotLayer({
          id: 'heads',
          data: heads,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getPosition: (d: any) => d.p,
          getFillColor: (d: any) =>
            d.j.i === selected ? [255, 122, 26] : d.j.b ? [...BOT_COLOR, 200] : HUMAN_COLOR,
          getLineColor: [8, 9, 11, 220],
          lineWidthMinPixels: 1.2,
          stroked: true,
          getRadius: (d: any) => (d.j.i === selected ? 6 : d.j.b ? 3 : 4.5),
          radiusUnits: 'pixels',
          pickable: true,
          onClick: (i: any) => i.object && select(i.object.j.i),
          onHover: (i: any) =>
            setHover(i.object ? { x: i.x, y: i.y, obj: i.object.j, kind: 'path' } : null),
          updateTriggers: { getFillColor: [selected], getRadius: [selected] },
        }),
      );
    }

    // 5. discrete events --------------------------------------------------
    if (f.showEvents) {
      const visible = inReplay ? events.filter((e) => e.t <= time) : events;
      // humans -> circles, bots -> squares, via two layers
      const mk = (id: string, data: GameEvent[], square: boolean) =>
        new ScatterplotLayer({
          id,
          data,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getPosition: (d: GameEvent) => toPx(d.x, d.y),
          getFillColor: (d: GameEvent) => {
            const c = EVENT_COLORS[d.k] ?? EVENT_COLORS.other;
            return [c[0], c[1], c[2], d.b ? 150 : 235];
          },
          getLineColor: [8, 9, 11, 210],
          lineWidthMinPixels: 0.8,
          stroked: true,
          getRadius: (d: GameEvent) => (d.k === 'storm' ? 5.5 : d.k === 'loot' ? 2.6 : 3.6),
          radiusUnits: 'pixels',
          radiusMinPixels: 1.5,
          pickable: true,
          onHover: (i: any) =>
            setHover(i.object ? { x: i.x, y: i.y, obj: i.object, kind: 'event' } : null),
          onClick: (i: any) => i.object && select(i.object.p),
          ...(square ? { } : {}),
        });

      L.push(mk('ev-bot', visible.filter((e) => e.b === 1), true));
      L.push(mk('ev-human', visible.filter((e) => e.b === 0), false));
    }

    // 6. region rectangle --------------------------------------------------
    const rect = live ?? region;
    if (rect) {
      const [u0, v0, u1, v1] = rect;
      L.push(
        new PolygonLayer({
          id: 'region',
          data: [{ c: [toPx(u0, v0), toPx(u1, v0), toPx(u1, v1), toPx(u0, v1)] }],
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getPolygon: (d: any) => d.c,
          getFillColor: [255, 122, 26, 26],
          getLineColor: [255, 122, 26, 230],
          getLineWidth: 1.5,
          lineWidthUnits: 'pixels',
          stroked: true,
          filled: true,
          pickable: false,
        }),
      );
    }

    // 7. coordinate debug overlay ------------------------------------------
    if (debug) {
      const lines: any[] = [];
      const labels: any[] = [];
      const STEP = 0.1;
      for (let i = 0; i <= 10; i++) {
        const t = i * STEP;
        lines.push({ s: toPx(t, 0), e: toPx(t, 1) });
        lines.push({ s: toPx(0, t), e: toPx(1, t) });
        const wx = meta.originX + t * meta.scale;
        const wz = meta.originZ + t * meta.scale;
        labels.push({ p: toPx(t, 0.012), s: `x ${Math.round(wx)}` });
        labels.push({ p: toPx(0.012, t), s: `z ${Math.round(wz)}` });
      }
      L.push(
        new LineLayer({
          id: 'dbg-grid',
          data: lines,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getSourcePosition: (d: any) => d.s,
          getTargetPosition: (d: any) => d.e,
          getColor: [255, 122, 26, 70],
          getWidth: 1,
          widthUnits: 'pixels',
        }),
        new TextLayer({
          id: 'dbg-text',
          data: labels,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getPosition: (d: any) => d.p,
          getText: (d: any) => d.s,
          getSize: 10,
          sizeUnits: 'pixels',
          getColor: [255, 122, 26, 220],
          getTextAnchor: 'start',
          getAlignmentBaseline: 'top',
          fontFamily: 'JetBrains Mono, monospace',
        }),
      );
    }

    return L;
  }, [bundle, f, mode, time, journeys, events, selected, region, live, debug, meta, grid, flow, exfil, select]);

  // ---------------------------------------------------------------- drag
  const unproject = useCallback((info: any): [number, number] | null => {
    if (!info?.coordinate) return null;
    const [px, py] = info.coordinate;
    return [px / SIZE, 1 - py / SIZE];
  }, []);

  const onDragStart = useCallback(
    (info: any, ev: any) => {
      if (!ev?.srcEvent?.shiftKey) return;
      const c = unproject(info);
      if (!c) return;
      drag.current = { u: c[0], v: c[1] };
      setLive([c[0], c[1], c[0], c[1]]);
    },
    [unproject],
  );

  const onDrag = useCallback(
    (info: any) => {
      if (!drag.current) return;
      const c = unproject(info);
      if (!c) return;
      const { u, v } = drag.current;
      setLive([Math.min(u, c[0]), Math.min(v, c[1]), Math.max(u, c[0]), Math.max(v, c[1])]);
    },
    [unproject],
  );

  const onDragEnd = useCallback(() => {
    if (drag.current && live) {
      const [a, b, c, d] = live;
      setRegion(c - a > 0.004 && d - b > 0.004 ? live : null);
    }
    drag.current = null;
    setLive(null);
  }, [live, setRegion]);

  // ---------------------------------------------------------------- render
  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
      <DeckGL
        views={new OrthographicView({ id: 'ortho', flipY: true })}
        viewState={viewState}
        onViewStateChange={(e: any) => setViewState(e.viewState)}
        controller={{ dragPan: !drag.current, dragRotate: false, doubleClickZoom: true, scrollZoom: { speed: 0.012, smooth: true } }}
        layers={layers}
        onDragStart={onDragStart}
        onDrag={onDrag}
        onDragEnd={onDragEnd}
        getCursor={({ isDragging }) => (isDragging ? 'grabbing' : 'crosshair')}
        style={{ position: 'absolute', inset: '0' }}
      />

      {hover && <Tooltip h={hover} />}

      <div className="overlay-tr">
        <div className="pill">
          {meta.label} · <b>{match ? shortId(match.id) : `${useFilteredCount(journeys)} journeys`}</b>
        </div>
        {region && (
          <div className="pill">
            region <b>{((region[2] - region[0]) * meta.scale).toFixed(0)}×{((region[3] - region[1]) * meta.scale).toFixed(0)}</b> world units
          </div>
        )}
        {debug && <div className="pill">debug grid · <b>world coords</b></div>}
      </div>

      <Legend />
    </div>
  );
}

function useFilteredCount(j: Journey[]) {
  return j.length;
}

function lastIndexAtOrBefore(arr: number[], t: number): number {
  let lo = 0, hi = arr.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) { res = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return res;
}

function Tooltip({ h }: { h: Hover }) {
  const style: React.CSSProperties = { left: h.x + 14, top: h.y + 14 };
  if (h.kind === 'event') {
    const e: GameEvent = h.obj;
    return (
      <div className="tooltip" style={style}>
        <div className="tt-h">{EVENT_LABEL[e.k] ?? e.k}</div>
        <div className="tt-r"><span>raw</span><span>{e.e}</span></div>
        <div className="tt-r"><span>actor</span><span>{e.b ? 'BOT' : 'HUMAN'}</span></div>
        <div className="tt-r"><span>t</span><span>{fmtTime(e.t)}</span></div>
        <div className="tt-r"><span>elev</span><span>{e.h}</span></div>
      </div>
    );
  }
  if (h.kind === 'cell') {
    return (
      <div className="tooltip" style={style}>
        <div className="tt-h">Dead zone</div>
        <div className="tt-r"><span>samples</span><span>{h.obj.n}</span></div>
        <div className="tt-r"><span></span><span>near-zero traffic</span></div>
      </div>
    );
  }
  if (h.kind === 'flow') {
    const c = h.obj;
    const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][
      Math.round(c.bearing / 45) % 8
    ];
    const reading =
      c.coherence >= 0.7 ? 'one-way route'
      : c.coherence >= 0.4 ? 'preferred direction'
      : 'milling / two-way';
    return (
      <div className="tooltip" style={style}>
        <div className="tt-h">Flow · {compass}</div>
        <div className="tt-r"><span>coherence</span><span>{c.coherence.toFixed(2)} — {reading}</span></div>
        <div className="tt-r"><span>bearing</span><span>{c.bearing.toFixed(0)}°</span></div>
        <div className="tt-r"><span>mean speed</span><span>{c.speed.toFixed(1)} u/s</span></div>
        <div className="tt-r"><span>transitions</span><span>{c.count}</span></div>
      </div>
    );
  }
  if (h.kind === 'exfil') {
    const z = h.obj;
    return (
      <div className="tooltip" style={style}>
        <div className="tt-h">Inferred exfil zone</div>
        <div className="tt-r"><span>runs ended here</span><span>{z.exits}</span></div>
        <div className="tt-r"><span>traffic predicts</span><span>{z.expected.toFixed(1)}</span></div>
        <div className="tt-r"><span>excess</span><span>{z.ratio}× · {fmtP(z.p)}</span></div>
        <div className="tt-r"><span>died anyway</span><span>{z.deaths} ({((z.deaths / z.exits) * 100).toFixed(0)}%)</span></div>
        <div className="tt-r"><span>median run</span><span>{fmtTime(z.median_run)}</span></div>
      </div>
    );
  }

  if (h.kind === 'spawn') {
    const z = h.obj;
    return (
      <div className="tooltip" style={style}>
        <div className="tt-h">Spawn point</div>
        <div className="tt-r"><span>runs started here</span><span>{z.runs}</span></div>
        <div className="tt-r"><span>extracted</span><span>{z.extracted} ({(z.rate * 100).toFixed(0)}%)</span></div>
        <div className="tt-r"><span>died</span><span>{z.died}</span></div>
        <div className="tt-r"><span>median run</span><span>{fmtTime(z.median_run)}</span></div>
        {z.runs < 10 && <div className="tt-n">too few runs to rank</div>}
      </div>
    );
  }

  if (h.kind === 'econ') {
    const c = h.obj;
    return (
      <div className="tooltip" style={style}>
        <div className="tt-h">{QUADRANT_LABEL[c.q as keyof typeof QUADRANT_LABEL]}</div>
        <div className="tt-r"><span>visits</span><span>{c.visits}</span></div>
        <div className="tt-r"><span>loot picked up</span><span>{c.loot}</span></div>
        <div className="tt-r"><span>reward</span><span>{c.reward.toFixed(3)} / visit</span></div>
        <div className="tt-r"><span>risk</span><span>{c.risk.toFixed(3)} / visit</span></div>
      </div>
    );
  }
  if (h.kind === 'diff') {
    const d = h.obj;
    return (
      <div className="tooltip" style={style}>
        <div className="tt-h">{d.d >= 0 ? 'Busier in A' : 'Busier in B'}</div>
        <div className="tt-r"><span>shift</span><span>{(d.d * 100).toFixed(0)}% of max</span></div>
        <div className="tt-r"><span>A samples</span><span>{d.a}</span></div>
        <div className="tt-r"><span>B samples</span><span>{d.b}</span></div>
      </div>
    );
  }
  const j: Journey = h.obj;
  return (
    <div className="tooltip" style={style}>
      <div className="tt-h">{j.b ? 'BOT' : 'HUMAN'} {shortId(j.u, 10)}</div>
      <div className="tt-r"><span>samples</span><span>{j.t.length}</span></div>
      <div className="tt-r"><span>on map</span><span>{fmtTime(j.t[j.t.length - 1] - j.t[0])}</span></div>
      <div className="tt-r"><span>match</span><span>{shortId(j.m)}</span></div>
    </div>
  );
}

function Legend() {
  const f = useStore((s) => s.filters);
  const mode = useStore((s) => s.mode);
  // Every swatch reads from the same constants the layers render with, so the
  // legend physically cannot drift out of sync with the map.
  const Sw = ({ c, sq, ring }: { c: [number, number, number]; sq?: boolean; ring?: boolean }) => (
    <span
      className={`swatch${sq ? ' sq' : ''}`}
      style={ring ? { background: 'transparent', boxShadow: `inset 0 0 0 2px ${rgbCss(c)}` } : { background: rgbCss(c) }}
    />
  );
  return (
    <div className="legend" style={{ bottom: mode === 'replay' ? 92 : 12 }}>
      <h4>Legend</h4>
      <div className="li"><Sw c={HUMAN_COLOR} /> Human</div>
      <div className="li"><Sw c={BOT_COLOR} sq /> Bot</div>
      {f.showEvents && (['kill', 'death', 'loot', 'storm'] as const).map((k) => (
        <div className="li" key={k}><Sw c={EVENT_COLORS[k]} /> {EVENT_LABEL[k]}</div>
      ))}
      {f.showExfil && <div className="li"><Sw c={EXFIL_COLOR} ring /> Inferred exfil</div>}
      {f.showSpawns && (
        <>
          <div className="li"><Sw c={spawnRateColor(0.45)} /> Spawn ≥45% extract</div>
          <div className="li"><Sw c={spawnRateColor(0.22)} /> Spawn ~22%</div>
          <div className="li"><Sw c={spawnRateColor(0)} /> Spawn 0%</div>
        </>
      )}
      {f.showEconomy && (['honeypot', 'freefarm', 'deathtrap', 'barren'] as const).map((q) => (
        <div className="li" key={q}><Sw c={QUADRANT_COLOR[q]} sq /> {QUADRANT_LABEL[q]}</div>
      ))}
      {f.colorByOutcome && (
        <>
          <div className="li"><Sw c={OUTCOME_COLOR.x} /> Extracted (inferred)</div>
          <div className="li"><Sw c={OUTCOME_COLOR.d} /> Died</div>
          <div className="li"><Sw c={OUTCOME_COLOR['?']} /> Unresolved</div>
        </>
      )}
      {f.showFlow && (
        <>
          <div className="li"><Sw c={coherenceColor(0.85)} sq /> One-way route</div>
          <div className="li"><Sw c={coherenceColor(0.45)} sq /> Mixed flow</div>
          <div className="li"><Sw c={coherenceColor(0.05)} sq /> Milling / churn</div>
        </>
      )}
      {f.showDiff && (
        <>
          <div className="li"><Sw c={[255, 74, 94]} sq /> Busier in A — {METRIC_LABEL[f.cmpA]}</div>
          <div className="li"><Sw c={[48, 184, 232]} sq /> Busier in B — {METRIC_LABEL[f.cmpB]}</div>
        </>
      )}
      {f.showDead && (
        <div className="li">
          <span className="swatch sq" style={{ background: 'rgba(240,56,74,.35)', border: '1px solid rgba(240,56,74,.6)' }} /> Dead zone
        </div>
      )}
    </div>
  );
}
