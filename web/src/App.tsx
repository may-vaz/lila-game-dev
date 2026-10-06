import { useEffect, useState } from 'react';
import { useStore, DEFAULT_FILTERS } from './store';
import type { Bundle } from './types';
import MapView from './components/MapView';
import LeftPanel from './components/LeftPanel';
import RightPanel from './components/RightPanel';
import Timeline from './components/Timeline';
import { fmtNum } from './lib/viz';
import './theme.css';

// --------------------------------------------------------------- URL state
function readUrl() {
  const q = new URLSearchParams(location.search);
  const b: any = {};
  const mode = q.get('mode');
  if (mode === 'replay' || mode === 'aggregate') b.mode = mode;
  const f: any = {};
  if (q.get('map')) f.mapId = q.get('map');
  if (q.get('date')) f.date = q.get('date');
  if (q.get('match')) f.matchId = q.get('match');
  if (q.get('heat')) { f.showHeat = true; f.heatMetric = q.get('heat'); }
  if (q.get('dead') === '1') f.showDead = true;
  if (q.get('nopaths') === '1') f.showPaths = false;
  if (q.get('nobots') === '1') f.showBots = false;
  if (q.get('nohumans') === '1') f.showHumans = false;
  return { base: b, filters: f, t: q.get('t') ? +q.get('t')! : null };
}

function writeUrl() {
  const s = useStore.getState();
  const f = s.filters;
  const q = new URLSearchParams();
  q.set('mode', s.mode);
  q.set('map', f.mapId);
  if (f.date !== 'all') q.set('date', f.date);
  if (s.mode === 'replay' && f.matchId) q.set('match', f.matchId);
  if (f.showHeat) q.set('heat', f.heatMetric);
  if (f.showDead) q.set('dead', '1');
  if (!f.showPaths) q.set('nopaths', '1');
  if (!f.showBots) q.set('nobots', '1');
  if (!f.showHumans) q.set('nohumans', '1');
  if (s.mode === 'replay' && s.time > 0) q.set('t', s.time.toFixed(1));
  history.replaceState(null, '', `${location.pathname}?${q}`);
}

// Captured at module load: the store subscriber below rewrites the query string
// on every change, so the incoming deep-link must be read before that happens.
const INCOMING = readUrl();

export default function App() {
  const { bundle, loading, error, mode, setMode, setBundle, setError } = useStore();
  const patch = useStore((s) => s.patch);
  const toggleDebug = useStore((s) => s.toggleDebug);
  const [help, setHelp] = useState(false);
  const [copied, setCopied] = useState(false);

  // ---- load bundle ------------------------------------------------------
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/bundle.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Bundle>;
      })
      .then((b) => {
        const { base, filters, t } = INCOMING;
        const first = Object.keys(b.maps)[0];
        // setMode applies this mode's default layer set; deep-linked layer
        // flags are applied after it so the URL always wins.
        if (base.mode) setMode(base.mode);
        const mode = base.mode ?? useStore.getState().mode;
        const init = {
          ...DEFAULT_FILTERS,
          showPaths: mode === 'replay',
          showHeat: mode === 'aggregate',
          ...filters,
        };
        if (!b.maps[init.mapId]) init.mapId = first;
        patch(init);
        if (t != null) useStore.getState().setTime(t);
        setBundle(b);
      })
      .catch((e) => setError(String(e)));
  }, [setBundle, setError, patch, setMode]);

  // ---- keep URL in sync --------------------------------------------------
  useEffect(() => {
    if (!bundle) return;
    return useStore.subscribe(() => writeUrl());
  }, [bundle]);

  // ---- keyboard ----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const s = useStore.getState();
      const f = s.filters;
      switch (e.key) {
        case ' ': e.preventDefault(); if (s.mode === 'replay') s.setPlaying(!s.playing); break;
        case 'ArrowLeft': e.preventDefault(); s.setTime(Math.max(0, s.time - (e.shiftKey ? 10 : 1))); break;
        case 'ArrowRight': e.preventDefault(); s.setTime(s.time + (e.shiftKey ? 10 : 1)); break;
        case '1': s.patch({ showPaths: !f.showPaths }); break;
        case '2': s.patch({ showEvents: !f.showEvents }); break;
        case '3': s.patch({ showHeat: !f.showHeat }); break;
        case '4': s.patch({ showDead: !f.showDead }); break;
        case 'h': case 'H': s.patch({ showHumans: !f.showHumans }); break;
        case 'b': case 'B': s.patch({ showBots: !f.showBots }); break;
        case 'r': case 'R': s.setMode(s.mode === 'replay' ? 'aggregate' : 'replay'); break;
        case 'd': case 'D': if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleDebug(); } break;
        case 'Escape': s.setRegion(null); s.select(null); setHelp(false); break;
        case '?': setHelp((v) => !v); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleDebug]);

  if (loading) {
    return (
      <div className="loader">
        <div className="in">
          <div className="mk">LILA BLACK</div>
          <div className="spin"><i /></div>
          <div className="ms">loading telemetry…</div>
        </div>
      </div>
    );
  }

  if (error || !bundle) {
    return (
      <div className="loader">
        <div className="in">
          <div className="mk" style={{ color: 'var(--death)' }}>LOAD FAILED</div>
          <div className="ms">{error ?? 'bundle.json missing'}</div>
          <div className="ms" style={{ marginTop: 10, color: 'var(--text-3)' }}>
            Run the pipeline: <code>python pipeline/build.py</code>
          </div>
        </div>
      </div>
    );
  }

  const s = bundle.stats;

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="mark">LILA BLACK</span>
          <span className="sub">Player Journey</span>
        </div>

        <div className="seg">
          <button className={mode === 'aggregate' ? 'on' : ''} onClick={() => setMode('aggregate')}>
            Aggregate
          </button>
          <button className={mode === 'replay' ? 'on' : ''} onClick={() => setMode('replay')}>
            Match Replay
          </button>
        </div>

        <div className="stat-chips">
          <div><b>{fmtNum(s.matches)}</b> matches</div>
          <div><b>{fmtNum(s.humans)}</b> humans</div>
          <div><b>{fmtNum(s.bots)}</b> bots</div>
          <div><b>{fmtNum(s.rows)}</b> rows</div>
        </div>

        <div className="spacer" />

        <button className={`hbtn ${copied ? 'ok' : ''}`} onClick={() => {
          navigator.clipboard?.writeText(location.href);
          setCopied(true); setTimeout(() => setCopied(false), 1400);
        }}>
          {copied ? '✓ Copied' : '⧉ Copy view link'}
        </button>
        <button className="hbtn" onClick={() => setHelp(true)}>?</button>
      </header>

      <div className="body">
        <LeftPanel />
        <div className="stage">
          <MapView />
          {mode === 'replay' && <Timeline />}
        </div>
        <RightPanel />
      </div>

      {help && (
        <div className="help" onClick={() => setHelp(false)}>
          <div className="card" onClick={(e) => e.stopPropagation()}>
            <h2>Keyboard shortcuts</h2>
            {[
              ['Space', 'Play / pause (replay mode)'],
              ['← →', 'Step 1 second'],
              ['Shift + ← →', 'Jump 10 seconds'],
              ['1 / 2 / 3 / 4', 'Toggle journeys / events / heatmap / dead zones'],
              ['H / B', 'Toggle humans / bots'],
              ['R', 'Switch Aggregate ⇄ Replay'],
              ['Shift + drag', 'Measure a region on the map'],
              ['Ctrl/⌘ + D', 'Coordinate debug grid'],
              ['Esc', 'Clear selection & region'],
              ['?', 'This panel'],
            ].map(([k, d]) => (
              <div className="kb" key={k}><span>{d}</span><kbd>{k}</kbd></div>
            ))}
            <button className="hbtn close" onClick={() => setHelp(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
