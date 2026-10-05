import { create } from 'zustand';
import type { Bundle } from './types';

export type Mode = 'replay' | 'aggregate';
export type HeatMetric = 'traffic' | 'traffic_human' | 'kills' | 'deaths' | 'loot' | 'storm';

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
      },
    })),
  patch: (f) => set((s) => ({ filters: { ...s.filters, ...f } })),
  setTime: (t) => set({ time: t }),
  setPlaying: (p) => set({ playing: p }),
  setSpeed: (s) => set({ speed: s }),
  select: (i) => set({ selectedJourney: i }),
  setRegion: (r) => set({ region: r }),
  toggleDebug: () => set((s) => ({ debug: !s.debug })),
}));
