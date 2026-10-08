import { useStore } from '../store';
import type { HeatMetric } from '../store';
import { useFiltered } from '../lib/useFiltered';
import { fmtTime, fmtNum, shortId, METRIC_LABEL, EVENT_COLORS, rgbCss,
  spawnRateColor, buildEconomy, QUADRANT_COLOR, QUADRANT_LABEL } from '../lib/viz';
import { useMemo } from 'react';

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`metric ${accent ? 'accent' : ''}`}>
      <div className="lbl">{label}</div>
      <div className="val sm">{value}</div>
    </div>
  );
}

const HEAT_OPTIONS: { v: HeatMetric; l: string }[] = [
  { v: 'traffic', l: 'Traffic — all players' },
  { v: 'traffic_human', l: 'Traffic — humans only' },
  { v: 'traffic_bot', l: 'Traffic — bots only' },
  { v: 'kills', l: 'Kill zones' },
  { v: 'deaths', l: 'Death zones' },
  { v: 'loot', l: 'Loot density' },
  { v: 'storm', l: 'Storm deaths' },
];

/** Everything that can sit on either side of the A/B comparison. */
const CMP_OPTIONS: HeatMetric[] = [
  'traffic_early', 'traffic_mid', 'traffic_late',
  'traffic_human', 'traffic_bot', 'traffic',
  'kills', 'deaths', 'loot', 'storm',
];

/** One-click comparisons a level designer actually asks for. */
const CMP_PRESETS: { l: string; a: HeatMetric; b: HeatMetric; why: string }[] = [
  { l: 'Late vs early game', a: 'traffic_late', b: 'traffic_early', why: 'where does the match migrate to?' },
  { l: 'Bots vs humans', a: 'traffic_bot', b: 'traffic_human', why: 'do bots hold ground players never see?' },
  { l: 'Deaths vs traffic', a: 'deaths', b: 'traffic', why: 'lethal beyond simple footfall' },
  { l: 'Loot vs traffic', a: 'loot', b: 'traffic', why: 'loot drawing players off-route' },
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
  const setScorecard = useStore((s) => s.setScorecard);
  const exfil = bundle.exfil?.[f.mapId];
  const spawns = bundle.spawns?.[f.mapId];
  const econ = useMemo(() => {
    const g = bundle.grids[f.mapId];
    return g ? buildEconomy(g) : null;
  }, [bundle, f.mapId]);
  const card = bundle.scorecard?.[f.mapId];

  const counts = events.reduce<Record<string, number>>((a, e) => {
    a[e.k] = (a[e.k] ?? 0) + 1;
    return a;
  }, {});

  return (
    <div className="panel left">
      {card && (
        <div className="sect">
          <button className="btn sc-open" onClick={() => setScorecard(true)}>
            <span>Map health</span>
            <span className="sc-chips">
              {card.critical > 0 && <em className="crit">{card.critical}</em>}
              {card.flags - card.critical > 0 && <em className="warn">{card.flags - card.critical}</em>}
              {card.flags === 0 && <em className="ok">clear</em>}
            </span>
          </button>
        </div>
      )}

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
            {matches.length === 0 && (
              <div className="warnline">
                No match passes the current filters.
                {f.minHumans > 0 && <> Only <b>1 of 796</b> matches in the whole dataset has 2+ humans.</>}
                {' '}<button className="lnk" onClick={() => patch({ minHumans: 0, date: 'all' })}>reset filters</button>
              </div>
            )}
          </div>
        )}

        {/* Scope filter, shown in BOTH modes. It used to be aggregate-only,
            which meant it could silently empty the match list in Replay with
            no visible cause and no way to undo it. */}
        <div className="field">
          <label>Min. human players per match · {f.minHumans}</label>
          <input
            type="range" min={0} max={2} step={1} value={f.minHumans}
            onChange={(e) => patch({ minHumans: +e.target.value })}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
          />
          {f.minHumans > 0 && (
            <div className="warnline">
              Only {f.minHumans}+ human matches are in scope.
              {' '}<button className="lnk" onClick={() => patch({ minHumans: 0 })}>show all</button>
            </div>
          )}
        </div>
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
        <Row on={f.showFlow} onClick={() => patch({ showFlow: !f.showFlow })} k="5">
          Flow field
        </Row>
        <Row on={f.showDiff} onClick={() => patch({ showDiff: !f.showDiff })} k="6">
          Compare A/B
        </Row>
        <Row on={f.showExfil} onClick={() => patch({ showExfil: !f.showExfil })} count={exfil?.zones.length} k="7">
          Exfil zones <sup className="inf">inferred</sup>
        </Row>
        <Row on={f.showSpawns} onClick={() => patch({ showSpawns: !f.showSpawns })} count={spawns?.zones.length} k="8">
          Spawn points
        </Row>
        <Row on={f.showEconomy} onClick={() => patch({ showEconomy: !f.showEconomy })} k="9">
          Loot economy
        </Row>
        <Row on={f.colorByOutcome} onClick={() => patch({ colorByOutcome: !f.colorByOutcome })} k="O">
          Colour by outcome
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

      {f.showExfil && exfil && (
        <div className="sect">
          <h3>Exfil zones <sup className="inf">inferred</sup></h3>
          <div className="note" style={{ marginBottom: 9 }}>
            The telemetry has no <code>Extracted</code> event. These are recovered
            statistically: locations where far more runs end than traffic predicts.
            Players ending inside one die <b>~1%</b> of the time; everyone else dies{' '}
            <b>~80%</b> of the time.
          </div>
          <div className="metric-grid" style={{ marginBottom: 9 }}>
            <Metric label="Extraction rate" value={`${(exfil.rate * 100).toFixed(1)}%`} accent />
            <Metric label="Zones found" value={`${exfil.zones.length}`} />
          </div>
          {exfil.zones.slice(0, 6).map((z, i) => (
            <div className="row static" key={i}>
              <span className="nm">Zone {i + 1} · {z.ratio}× expected</span>
              <span className="ct">{z.exits}</span>
            </div>
          ))}
        </div>
      )}

      {f.showSpawns && spawns && (
        <div className="sect">
          <h3>Spawn → outcome</h3>
          <div className="note" style={{ marginBottom: 9 }}>
            Entries land in only {spawns.zones.length} places at up to 57× the rate
            traffic predicts, so these are <b>fixed spawn points</b>, not a free drop.
            That makes spawn a controlled variable: crossed against the inferred
            outcome, it answers whether the spawn you are handed decides your run.
          </div>
          <div className="metric-grid" style={{ marginBottom: 9 }}>
            <Metric
              label="Fairness spread"
              value={`${spawns.spread}×`}
              accent={spawns.spread >= 2}
            />
            <Metric label="Ranked spawns" value={`${spawns.ranked} of ${spawns.zones.length}`} />
          </div>
          {spawns.zones
            .filter((z) => z.runs >= spawns.min_runs)
            .slice()
            .sort((a, b) => b.rate - a.rate)
            .map((z, i) => (
              <div className="fun" key={i}>
                <span className="bar">
                  <i style={{ width: `${Math.min(100, (z.rate / 0.45) * 100)}%`,
                              background: rgbCss(spawnRateColor(z.rate)) }} />
                </span>
                <span className="v">{(z.rate * 100).toFixed(0)}%</span>
                <span className="n">{z.runs} runs</span>
              </div>
            ))}
          <div className="note" style={{ marginTop: 8 }}>
            {spawns.spread >= 2
              ? `Worst spawn extracts ${spawns.spread}× less often than the best — a balance defect, not variance.`
              : 'Spawns are within noise of each other here. This map is balanced.'}
            {' '}Zones under {spawns.min_runs} runs are drawn hollow and left unranked.
          </div>
        </div>
      )}

      {f.showEconomy && econ && (
        <div className="sect">
          <h3>Loot economy</h3>
          <div className="note" style={{ marginBottom: 9 }}>
            Loot is <b>78.9%</b> of all events, but a loot heatmap mostly restates
            where players walk. This is the ratio instead: per visit, what a cell{' '}
            <b>pays</b> (loot) against what it <b>costs</b> (kills + deaths), each
            split at the map median over cells with ≥{econ.minVisits} visits.
          </div>
          <div className="quad">
            {(['honeypot', 'freefarm', 'deathtrap', 'barren'] as const).map((q) => (
              <div className="q" key={q}>
                <span className="qn">
                  <span className="dot" style={{ background: rgbCss(QUADRANT_COLOR[q]) }} />
                  {QUADRANT_LABEL[q].split(' — ')[0]}
                </span>
                <span className="qv">{econ.counts[q]}</span>
              </div>
            ))}
          </div>
          <div className="row static">
            <span className="nm">Loot deserts (≥{econ.minVisits} visits, 0 loot)</span>
            <span className="ct">{econ.deserts}</span>
          </div>
          <div className="row static">
            <span className="nm">corr(loot, traffic)</span>
            <span className="ct">{econ.corr.toFixed(2)}</span>
          </div>
          <div className="note" style={{ marginTop: 8 }}>
            {econ.corr > 0.7
              ? 'Loot tracks footfall almost exactly — it is following players rather than steering them. Moving loot is the cheapest way to redirect traffic.'
              : 'Loot and footfall are only loosely coupled here, so loot is not what is pulling players through this map.'}
          </div>
        </div>
      )}

      {f.showFlow && (
        <div className="sect">
          <h3>Flow field</h3>
          <div className="note" style={{ marginBottom: 9 }}>
            Mean direction of travel per cell. Colour is <b>coherence</b> — amber means
            everyone crosses the same way (a corridor), blue means players mill about
            (a pocket or a dead end). Arrow length is how busy the cell is.
          </div>
          <div className="field">
            <label>Min. coherence · {f.flowMin.toFixed(2)}</label>
            <input
              type="range" min={0} max={0.9} step={0.05} value={f.flowMin}
              onChange={(e) => patch({ flowMin: +e.target.value })}
              style={{ width: '100%', accentColor: 'var(--accent)' }}
            />
            <div className="note" style={{ marginTop: 4 }}>
              Raise this to strip out churn and leave only committed routes.
            </div>
          </div>
        </div>
      )}

      {f.showDiff && (
        <div className="sect">
          <h3>Compare A/B</h3>
          <div className="note" style={{ marginBottom: 9 }}>
            Both slices are normalised to a share of their own total before subtracting,
            so this shows players <b>redistributing</b>, not just one slice having more rows.
          </div>
          <div className="field">
            <label>A — shown red</label>
            <select value={f.cmpA} onChange={(e) => patch({ cmpA: e.target.value as HeatMetric })}>
              {CMP_OPTIONS.map((o) => <option key={o} value={o}>{METRIC_LABEL[o]}</option>)}
            </select>
          </div>
          <div className="field">
            <label>B — shown blue</label>
            <select value={f.cmpB} onChange={(e) => patch({ cmpB: e.target.value as HeatMetric })}>
              {CMP_OPTIONS.map((o) => <option key={o} value={o}>{METRIC_LABEL[o]}</option>)}
            </select>
          </div>
          <label style={{ marginTop: 4 }}>Presets</label>
          {CMP_PRESETS.map((p) => (
            <div
              key={p.l}
              className={`row ${f.cmpA === p.a && f.cmpB === p.b ? 'on' : ''}`}
              onClick={() => patch({ cmpA: p.a, cmpB: p.b })}
              title={p.why}
            >
              <div className="box" />
              <span className="nm">{p.l}</span>
            </div>
          ))}
        </div>
      )}

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
              style={{ background: rgbCss(EVENT_COLORS[k]) }}
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
