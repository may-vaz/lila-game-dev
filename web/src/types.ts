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
  kills: number[];
  deaths: number[];
  loot: number[];
  storm: number[];
}

export interface Bundle {
  generated: string;
  maps: Record<string, MapMeta>;
  dates: string[];
  matches: MatchMeta[];
  journeys: Journey[];
  events: GameEvent[];
  grids: Record<string, Grid>;
  stats: {
    rows: number;
    matches: number;
    humans: number;
    bots: number;
    events: Record<string, number>;
  };
}
