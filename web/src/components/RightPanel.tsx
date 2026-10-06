import { useMemo } from 'react';
import { useStore } from '../store';
import { useFiltered } from '../lib/useFiltered';
import { fmtTime, fmtNum, shortId } from '../lib/viz';

function Metric({ label, value, accent, sm }: { label: string; value: string; accent?: boolean; sm?: boolean }) {
  return (
    <div className={`metric ${accent ? 'accent' : ''}`}>
      <div className="lbl">{label}</div>
      <div className={`val ${sm ? 'sm' : ''}`}>{value}</div>
    </div>
  );
}

function Bar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="bar-row">
      <div className="bl">
        <span>{label}</span>
        <b>{fmtNum(value)} · {pct.toFixed(0)}%</b>
      </div>
      <div className="bar"><i style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  );
}

export default function RightPanel() {
  const bundle = useStore((s) => s.bundle)!;
  const mode = useStore((s) => s.mode);
  const f = useStore((s) => s.filters);
  const selected = useStore((s) => s.selectedJourney);
  const select = useStore((s) => s.select);
  const region = useStore((s) => s.region);
  const setRegion = useStore((s) => s.setRegion);
  const { matches, match, events, journeys, regionEvents, regionJourneyPts } = useFiltered();

  const meta = bundle.maps[f.mapId];
  const journey = selected != null ? bundle.journeys[selected] : null;

  const agg = useMemo(() => {
    const c: Record<'kill'|'death'|'loot'|'storm', number> = { kill: 0, death: 0, loot: 0, storm: 0 };
    for (const e of events) { if (e.k in c) c[e.k as 'kill'] = (c[e.k as 'kill'] ?? 0) + 1; }
    const humans = journeys.filter((j) => !j.b).length;
    const bots = journeys.filter((j) => j.b).length;
    const dur = matches.reduce((a, m) => a + m.dur, 0);
    return { ...c, humans, bots, avgDur: matches.length ? dur / matches.length : 0 };
  }, [events, journeys, matches]);

  // dead-zone share of the map
  const deadPct = useMemo(() => {
    const g = bundle.grids[f.mapId];
    const cells = g.traffic;
    const max = Math.max(...cells);
    const cut = Math.max(1, max * 0.005);
    let playable = 0, dead = 0;
    for (let i = 0; i < cells.length; i++) {
      if (!g.playable[i]) continue;
      playable++;
      if (cells[i] <= cut) dead++;
    }
    return { dead, total: playable, occupied: playable - dead, pct: playable ? (dead / playable) * 100 : 0 };
  }, [bundle, f.mapId]);

  const humanKills = events.filter((e) => e.k === 'kill' && e.e === 'Kill').length;
  const botKills = events.filter((e) => e.k === 'kill' && e.e === 'BotKill').length;

  return (
    <div className="panel right">
      {region && (
        <div className="sect">
          <h3>Selected region</h3>
          <div className="metric-grid" style={{ marginBottom: 9 }}>
            <Metric label="Position pts" value={fmtNum(regionJourneyPts)} accent />
            <Metric label="Events" value={fmtNum(regionEvents.length)} />
          </div>
          <Bar label="Kills" value={regionEvents.filter((e) => e.k === 'kill').length} total={regionEvents.length} color="#ffb02e" />
          <Bar label="Deaths" value={regionEvents.filter((e) => e.k === 'death').length} total={regionEvents.length} color="#ff3b5c" />
          <Bar label="Loot" value={regionEvents.filter((e) => e.k === 'loot').length} total={regionEvents.length} color="#22d3ee" />
          <Bar label="Storm" value={regionEvents.filter((e) => e.k === 'storm').length} total={regionEvents.length} color="#a855f7" />
          <button className="hbtn" style={{ width: '100%', marginTop: 8, justifyContent: 'center' }} onClick={() => setRegion(null)}>
            Clear region
          </button>
        </div>
      )}

      {mode === 'replay' && match ? (
        <>
          <div className="sect">
            <h3>Match</h3>
            <div className="kv"><span className="k">ID</span><span className="v">{shortId(match.id, 13)}</span></div>
            <div className="kv"><span className="k">Map</span><span className="v">{meta.label}</span></div>
            <div className="kv"><span className="k">Start (UTC)</span><span className="v">{match.start.slice(11, 19)}</span></div>
            <div className="kv"><span className="k">Date</span><span className="v">{match.date}</span></div>
          </div>
          <div className="sect">
            <h3>Composition</h3>
            <div className="metric-grid">
              <Metric label="Duration" value={fmtTime(match.dur)} accent />
              <Metric label="Players" value={`${match.humans + match.bots}`} />
              <Metric label="Humans" value={`${match.humans}`} />
              <Metric label="Bots" value={`${match.bots}`} />
            </div>
          </div>
          <div className="sect">
            <h3>Events this match</h3>
            {(['kill', 'death', 'loot', 'storm'] as const).map((k) => (
              <Bar
                key={k}
                label={k === 'storm' ? 'Storm deaths' : k[0].toUpperCase() + k.slice(1)}
                value={match.counts[k] ?? 0}
                total={Object.values(match.counts).reduce((a, b) => a + (b ?? 0), 0)}
                color={{ kill: '#ffb02e', death: '#ff3b5c', loot: '#22d3ee', storm: '#a855f7' }[k]}
              />
            ))}
          </div>
          <div className="sect">
            <h3>Players · click to isolate</h3>
            <div className="plist">
              {match.players
                .slice()
                .sort((a, b) => a.b - b.b || b.dist - a.dist)
                .map((p) => (
                  <div
                    key={p.i}
                    className={`pitem ${selected === p.i ? 'sel' : ''}`}
                    onClick={() => select(selected === p.i ? null : p.i)}
                  >
                    <span
                      className={`swatch ${p.b ? 'sq' : ''}`}
                      style={{ background: p.b ? '#64748b' : '#4ade80' }}
                    />
                    <span className="uid">{p.b ? `bot ${p.u}` : shortId(p.u, 12)}</span>
                    <span className="d">{Math.round(p.dist)}m</span>
                  </div>
                ))}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="sect">
            <h3>{meta.label} · aggregate</h3>
            <div className="metric-grid">
              <Metric label="Matches" value={fmtNum(matches.length)} accent />
              <Metric label="Avg length" value={fmtTime(agg.avgDur)} />
              <Metric label="Journeys" value={fmtNum(journeys.length)} />
              <Metric label="Events" value={fmtNum(events.length)} />
            </div>
          </div>

          <div className="sect">
            <h3>Event mix</h3>
            <Bar label="Loot" value={agg.loot} total={events.length} color="#22d3ee" />
            <Bar label="Kills" value={agg.kill} total={events.length} color="#ffb02e" />
            <Bar label="Deaths" value={agg.death} total={events.length} color="#ff3b5c" />
            <Bar label="Storm deaths" value={agg.storm} total={events.length} color="#a855f7" />
          </div>

          <div className="sect">
            <h3>PvP vs PvE</h3>
            <div className="metric-grid" style={{ marginBottom: 9 }}>
              <Metric label="Human kills" value={fmtNum(humanKills)} sm />
              <Metric label="Bot kills" value={fmtNum(botKills)} sm accent />
            </div>
            <div className="note">
              {humanKills + botKills > 0
                ? `${((humanKills / (humanKills + botKills)) * 100).toFixed(1)}% of kills in scope are human-vs-human. The rest are players killing bots.`
                : 'No kill events in scope.'}
            </div>
          </div>

          <div className="sect">
            <h3>Match composition</h3>
            {(() => {
              const solo = matches.filter((m) => m.humans <= 1 && m.bots === 0).length;
              const withBots = matches.filter((m) => m.bots > 0).length;
              const multi = matches.filter((m) => m.humans > 1).length;
              const pct = (n: number) => (matches.length ? (n / matches.length) * 100 : 0);
              return (
                <>
                  <Bar label="Solo — 1 human, no bots" value={solo} total={matches.length} color="#ff3b5c" />
                  <Bar label="Human(s) + bots" value={withBots} total={matches.length} color="#ffb02e" />
                  <Bar label="2+ humans" value={multi} total={matches.length} color="#4ade80" />
                  <div className="note" style={{ marginTop: 8 }}>
                    {pct(solo).toFixed(0)}% of matches on this map contain a single human and no
                    bots. Players are almost never sharing a map with anyone.
                  </div>
                </>
              );
            })()}
          </div>

          <div className="sect">
            <h3>Map utilisation</h3>
            <div className="metric-grid" style={{ marginBottom: 9 }}>
              <Metric label="Ignored" value={`${deadPct.pct.toFixed(0)}%`} accent />
              <Metric label="Reachable cells" value={`${deadPct.total}`} />
            </div>
            <div className="note">
              {deadPct.dead} of {deadPct.total} grid cells see effectively no traffic. Enable the
              <b> Dead zones</b> layer to see which parts of the map players never visit.
            </div>
          </div>
        </>
      )}

      {journey && (
        <div className="sect">
          <h3>Selected journey</h3>
          <div className="kv"><span className="k">Type</span><span className="v">{journey.b ? 'BOT' : 'HUMAN'}</span></div>
          <div className="kv"><span className="k">User</span><span className="v">{shortId(journey.u, 13)}</span></div>
          <div className="kv"><span className="k">Samples</span><span className="v">{journey.t.length}</span></div>
          <div className="kv"><span className="k">On map</span><span className="v">{fmtTime(journey.t[journey.t.length - 1] - journey.t[0])}</span></div>
          <button className="hbtn" style={{ width: '100%', marginTop: 9, justifyContent: 'center' }} onClick={() => select(null)}>
            Clear selection
          </button>
        </div>
      )}
    </div>
  );
}
