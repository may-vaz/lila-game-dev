import { create } from 'zustand';
import type { Bundle } from './types';

export type Mode = 'replay' | 'aggregate';
export type HeatMetric =
  | 'traffic' | 'traffic_human' | 'traffic_bot'
  | 'traffic_early' | 'traffic_mid' | 'traffic_late'
  | 'kills' | 'deaths' | 'loot' | 'storm';

export interface Filters {
  mapId: string;
  date: string | 'all';
  matchId: string | null;
  showHumans: boolean;
  showBots: boolean;
  showPaths: boolean;
  showEvents: boolean;
  showHeat: boolean;
  showDead: boolean;
  heatMetric: HeatMetric;
  eventKinds: Record<string, boolean>;
  minHumans: number;

  // --- flow field -----------------------------------------------------
  showFlow: boolean;
  /** hide arrows below this coherence so the field reads as routes, not noise */
  flowMin: number;

  // --- A/B compare ----------------------------------------------------
  showDiff: boolean;
  cmpA: HeatMetric;
  cmpB: HeatMetric;

  // --- exfil ----------------------------------------------------------
  showExfil: boolean;
  /** colour journeys by inferred outcome instead of by human/bot */
  colorByOutcome: boolean;

  // --- spawn / run funnel ---------------------------------------------
  showSpawns: boolean;

  // --- loot economy ---------------------------------------------------
  showEconomy: boolean;
}

interface State {
  bundle: Bundle | null;
  loading: boolean;
  error: string | null;
  mode: Mode;
  filters: Filters;
  time: number;
  playing: boolean;
  speed: number;
  selectedJourney: number | null;
  hover: unknown | null;
  scorecardOpen: boolean;
  region: [number, number, number, number] | null; // u0,v0,u1,v1
  debug: boolean;

  setBundle: (b: Bundle) => void;
  setError: (e: string) => void;
  setMode: (m: Mode) => void;
  patch: (f: Partial<Filters>) => void;
  setTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setSpeed: (s: number) => void;
  select: (i: number | null) => void;
  setRegion: (r: [number, number, number, number] | null) => void;
  toggleDebug: () => void;
  setScorecard: (o: boolean) => void;
}

export const DEFAULT_FILTERS: Filters = {
  mapId: 'AmbroseValley',
  date: 'all',
  matchId: null,
  showHumans: true,
  showBots: true,
  showPaths: false,
  showEvents: true,
  showHeat: true,
  showDead: false,
  heatMetric: 'traffic',
  eventKinds: { kill: true, death: true, loot: true, storm: true },
  minHumans: 0,
  showFlow: false,
  flowMin: 0.25,
  showDiff: false,
  cmpA: 'traffic_late',
  cmpB: 'traffic_early',
  showExfil: false,
  colorByOutcome: false,
  showSpawns: false,
  showEconomy: false,
};

export const useStore = create<State>((set) => ({
  bundle: null,
  loading: true,
  error: null,
  mode: 'aggregate',
  filters: { ...DEFAULT_FILTERS },
  time: 0,
  playing: false,
  speed: 4,
  selectedJourney: null,
  hover: null,
  scorecardOpen: false,
  region: null,
  debug: false,

  setBundle: (b) => set({ bundle: b, loading: false }),
  setError: (e) => set({ error: e, loading: false }),
  setMode: (m) =>
    set((s) => ({
      mode: m,
      playing: false,
      time: 0,
      region: null,
      selectedJourney: null,
      filters: {
        ...s.filters,
        // Aggregate = "where do things happen across many matches" -> heatmap first.
        // Replay    = "what happened in THIS match"               -> paths first.
        showPaths: m === 'replay',
        showHeat: m === 'aggregate',
        // flow + diff are aggregate-only analyses; a single match has no field
        showFlow: false,
        showDiff: false,
        showEconomy: false,
      },
    })),
  patch: (f) =>
    set((s) => {
      const next = { ...s.filters, ...f };
      // The diff layer and the heatmap both paint the same cells; showing
      // both at once produces a colour soup nobody can read. Last one wins.
      // The diff, heatmap and economy layers all paint the same cells.
      // Only one cell-fill layer may be on at a time; last one wins.
      const fills = ['showHeat', 'showDiff', 'showEconomy'] as const;
      for (const on of fills) {
        if (f[on] && !s.filters[on]) for (const off of fills) if (off !== on) next[off] = false;
      }
      return { filters: next };
    }),
  setTime: (t) => set({ time: t }),
  setPlaying: (p) => set({ playing: p }),
  setSpeed: (s) => set({ speed: s }),
  select: (i) => set({ selectedJourney: i }),
  setRegion: (r) => set({ region: r }),
  toggleDebug: () => set((s) => ({ debug: !s.debug })),
  setScorecard: (o) => set({ scorecardOpen: o }),
}));
