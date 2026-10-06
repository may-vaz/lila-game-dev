import { useMemo } from 'react';
import { useStore } from '../store';
import type { GameEvent, Journey, MatchMeta } from '../types';

export interface Filtered {
  matches: MatchMeta[];
  match: MatchMeta | null;
  journeys: Journey[];
  events: GameEvent[];
  duration: number;
  /** events inside the lasso region, if one is drawn */
  regionEvents: GameEvent[];
  regionJourneyPts: number;
}

/**
 * Single source of truth for "what is currently on screen".
 * Everything downstream (layers, inspector, timeline histogram) reads this,
 * so the panels can never disagree with the canvas.
 */
export function useFiltered(): Filtered {
  const bundle = useStore((s) => s.bundle);
  const f = useStore((s) => s.filters);
  const mode = useStore((s) => s.mode);
  const region = useStore((s) => s.region);

  return useMemo<Filtered>(() => {
    const empty: Filtered = {
      matches: [], match: null, journeys: [], events: [],
      duration: 0, regionEvents: [], regionJourneyPts: 0,
    };
    if (!bundle) return empty;

    // ---- match-level filtering ------------------------------------------
    let matches = bundle.matches.filter((m) => m.map === f.mapId);
    if (f.date !== 'all') matches = matches.filter((m) => m.date === f.date);
    if (f.minHumans > 0) matches = matches.filter((m) => m.humans >= f.minHumans);
    matches.sort((a, b) => a.start.localeCompare(b.start));

    // In replay mode a single match must be selected. When the user has not
    // picked one, default to the most *interesting* match in scope (most
    // human players, then most events) rather than whichever happens to be
    // chronologically first - a 1-player match is a bad first impression.
    let match = null;
    if (mode === 'replay') {
      match = matches.find((m) => m.id === f.matchId) ?? null;
      if (!match && matches.length) {
        match = matches.reduce((best, m) => {
          const score = (x: typeof m) =>
            x.humans * 1000 + Object.values(x.counts).reduce((a, b) => a + (b ?? 0), 0);
          return score(m) > score(best) ? m : best;
        }, matches[0]);
      }
    }

    const scope = match ? [match] : matches;
    const ids = new Set(scope.map((m) => m.id));

    // ---- journeys --------------------------------------------------------
    const journeys = bundle.journeys.filter((j) => {
      if (!ids.has(j.m)) return false;
      if (j.b === 1 && !f.showBots) return false;
      if (j.b === 0 && !f.showHumans) return false;
      return j.t.length > 1;
    });

    // ---- discrete events -------------------------------------------------
    const events = bundle.events.filter((e) => {
      if (!ids.has(e.m)) return false;
      if (e.b === 1 && !f.showBots) return false;
      if (e.b === 0 && !f.showHumans) return false;
      return f.eventKinds[e.k] !== false;
    });

    const duration = match ? match.dur : scope.reduce((a, m) => Math.max(a, m.dur), 0);

    // ---- region selection -------------------------------------------------
    let regionEvents: GameEvent[] = [];
    let regionJourneyPts = 0;
    if (region) {
      const [u0, v0, u1, v1] = region;
      const inside = (x: number, y: number) => x >= u0 && x <= u1 && y >= v0 && y <= v1;
      regionEvents = events.filter((e) => inside(e.x, e.y));
      for (const j of journeys) {
        for (let i = 0; i < j.x.length; i++) if (inside(j.x[i], j.y[i])) regionJourneyPts++;
      }
    }

    return { matches, match, journeys, events, duration, regionEvents, regionJourneyPts };
  }, [bundle, f, mode, region]);
}
