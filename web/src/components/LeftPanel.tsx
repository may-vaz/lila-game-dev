import { useStore } from '../store';
import type { HeatMetric } from '../store';
import { useFiltered } from '../lib/useFiltered';
import { fmtTime, fmtNum, shortId } from '../lib/viz';

const HEAT_OPTIONS: { v: HeatMetric; l: string }[] = [
  { v: 'traffic', l: 'Traffic — all players' },
  { v: 'traffic_human', l: 'Traffic — humans only' },
  { v: 'kills', l: 'Kill zones' },
  { v: 'deaths', l: 'Death zones' },
  { v: 'loot', l: 'Loot density' },
  { v: 'storm', l: 'Storm deaths' },
];

function Row({
  on, onClick, children, count, k,
}: { on: boolean; onClick: () => void; children: React.ReactNode; count?: number; k?: string }) {
  return (
    <div className={`row ${on ? 'on' : ''}`} onClick={onClick}>
      <div className="box" />
      <span className="nm">{children}</span>
      {count !== undefined && <span className="ct">{fmtNum(count)}</span>}
      {k && <kbd>{k}</kbd>}
    </div>
  );
}

export default function LeftPanel() {
  const bundle = useStore((s) => s.bundle)!;
  const f = useStore((s) => s.filters);
  const patch = useStore((s) => s.patch);
  const mode = useStore((s) => s.mode);
  const setRegion = useStore((s) => s.setRegion);
  const select = useStore((s) => s.select);
  const { matches, match, events, journeys } = useFiltered();

  const counts = events.reduce<Record<string, number>>((a, e) => {
    a[e.k] = (a[e.k] ?? 0) + 1;
    return a;
  }, {});

  return (
    <div className="panel left">
      <div className="sect">
        <h3>Scope</h3>

        <div className="field">
          <label>Map</label>
          <select
            value={f.mapId}
            onChange={(e) => {
              patch({ mapId: e.target.value, matchId: null });
              setRegion(null);
              select(null);
            }}
          >
            {Object.values(bundle.maps).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} · {m.matches} matches
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Date (UTC)</label>
          <select value={f.date} onChange={(e) => patch({ date: e.target.value, matchId: null })}>
            <option value="all">All dates</option>
            {bundle.dates.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>

        {mode === 'replay' && (
          <div className="field">
            <label>Match · {matches.length} available</label>
            <select
              value={match?.id ?? ''}
              onChange={(e) => { patch({ matchId: e.target.value }); select(null); }}
            >
              {matches.length === 0 && <option value="">no matches in scope</option>}
              {matches
                .slice()
                .sort(
                  (a, b) =>
                    b.humans - a.humans ||
                    Object.values(b.counts).reduce((x, y) => x + (y ?? 0), 0) -
                      Object.values(a.counts).reduce((x, y) => x + (y ?? 0), 0),
                )
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {shortId(m.id)} · {m.humans}H/{m.bots}B · {fmtTime(m.dur)}
                  </option>
                ))}
            </select>
          </div>
        )}

        {mode === 'aggregate' && (
          <div className="field">
            <label>Min. human players per match · {f.minHumans}</label>
            <input
              type="range" min={0} max={2} step={1} value={f.minHumans}
              onChange={(e) => patch({ minHumans: +e.target.value })}
              style={{ width: '100%', accentColor: 'var(--accent)' }}
            />
          </div>
        )}
      </div>

      <div className="sect">
        <h3>Players</h3>
        <Row on={f.showHumans} onClick={() => patch({ showHumans: !f.showHumans })} k="H">
          Humans
        </Row>
        <Row on={f.showBots} onClick={() => patch({ showBots: !f.showBots })} k="B">
          Bots
        </Row>
      </div>

      <div className="sect">
        <h3>Layers</h3>
        <Row on={f.showPaths} onClick={() => patch({ showPaths: !f.showPaths })} count={journeys.length} k="1">
          Journeys
        </Row>
        <Row on={f.showEvents} onClick={() => patch({ showEvents: !f.showEvents })} count={events.length} k="2">
          Events
        </Row>
        <Row on={f.showHeat} onClick={() => patch({ showHeat: !f.showHeat })} k="3">
          Heatmap
        </Row>
        <Row on={f.showDead} onClick={() => patch({ showDead: !f.showDead })} k="4">
          Dead zones
        </Row>

        {f.showHeat && (
          <div className="field" style={{ marginTop: 9 }}>
            <label>Heatmap metric</label>
            <select value={f.heatMetric} onChange={(e) => patch({ heatMetric: e.target.value as HeatMetric })}>
              {HEAT_OPTIONS.map((o) => (
                <option key={o.v} value={o.v}>{o.l}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="sect">
        <h3>Event types</h3>
        {(['kill', 'death', 'loot', 'storm'] as const).map((k) => (
          <div
            key={k}
            className={`row ${f.eventKinds[k] !== false ? 'on' : ''}`}
            onClick={() => patch({ eventKinds: { ...f.eventKinds, [k]: f.eventKinds[k] === false } })}
          >
            <div className="box" />
            <span
              className="swatch"
              style={{
                background: { kill: '#ffb02e', death: '#ff3b5c', loot: '#22d3ee', storm: '#a855f7' }[k],
              }}
            />
            <span className="nm" style={{ textTransform: 'capitalize' }}>
              {k === 'storm' ? 'Storm death' : k}
            </span>
            <span className="ct">{fmtNum(counts[k] ?? 0)}</span>
          </div>
        ))}
      </div>

      <div className="sect">
        <h3>Region tool</h3>
        <div className="note">
          Hold <b>Shift</b> and drag on the map to measure an area. Stats appear in the
          inspector.
        </div>
      </div>
    </div>
  );
}
