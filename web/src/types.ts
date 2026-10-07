export type EventKind = 'kill' | 'death' | 'loot' | 'storm' | 'other';

export interface MapMeta {
  id: string;
  label: string;
  image: string;
  scale: number;
  originX: number;
  originZ: number;
  matches: number;
  rows: number;
  elevation: [number, number];
}

export interface PlayerRef {
  u: string;   // user_id
  b: 0 | 1;    // is_bot
  i: number;   // journey index
  samples: number;
  dist: number; // world units travelled
}

export interface MatchMeta {
  id: string;
  map: string;
  start: string;
  date: string;
  dur: number;
  humans: number;
  bots: number;
  players: PlayerRef[];
  counts: Partial<Record<EventKind, number>>;
}

export interface Journey {
  i: number;
  m: string;
  u: string;
  b: 0 | 1;
  t: number[];
  x: number[]; // u in 0..1
  y: number[]; // v in 0..1
}

export interface GameEvent {
  m: string;
  p: number;   // journey index
  b: 0 | 1;
  k: EventKind;
  e: string;   // raw event name
  t: number;
  x: number;
  y: number;
  h: number;   // elevation
}

export interface Grid {
  n: number;
  playable: number[];
  traffic: number[];
  traffic_human: number[];
  traffic_bot: number[];
  traffic_early: number[];
  traffic_mid: number[];
  traffic_late: number[];
  kills: number[];
  deaths: number[];
  loot: number[];
  storm: number[];
}

/**
 * Movement vector field. One entry per cell of an n x n grid, row-major.
 * dx/dy is a unit direction in UV space (v points UP, screen y points down).
 * coherence is |sum(v)| / sum(|v|): 1 = everyone crosses the same way,
 * 0 = players mill about with no net direction.
 */
export interface Flow {
  n: number;
  dx: number[];
  dy: number[];
  coherence: number[];
  speed: number[];
  count: number[];
}

export interface Bundle {
  generated: string;
  maps: Record<string, MapMeta>;
  dates: string[];
  matches: MatchMeta[];
  journeys: Journey[];
  events: GameEvent[];
  grids: Record<string, Grid>;
  flow: Record<string, Flow>;
  stats: {
    rows: number;
    matches: number;
    humans: number;
    bots: number;
    events: Record<string, number>;
  };
}
