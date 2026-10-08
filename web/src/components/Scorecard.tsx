import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { STATUS_COLOR, fmtTime } from '../lib/viz';
import type { ScorecardRow } from '../types';

/**
 * Map Health Scorecard.
 *
 * Every other layer in this tool is interrogative: you have to already suspect
 * something to go looking for it. This one is declarative - it opens with the
 * problems already found and ranked, which is the difference between a tool a
 * designer uses when they remember to and one they open every morning.
 *
 * Two deliberate omissions:
 *
 *  - There is no single composite "map score". Averaging area utilisation
 *    against PvP share yields a number with no units, and it would let a map
 *    hide one catastrophic metric behind six healthy ones.
 *  - Thresholds are not presented as industry truth. They are design
 *    judgements declared in pipeline/build.py (SCORECARD_RULES) and shown
 *    next to every value, so a designer can disagree with the threshold
 *    rather than with the tool.
 */

function Gauge({ row }: { row: ScorecardRow }) {
  // Place the value on a 0..1 track with the critical and warn thresholds
  // marked, so "how bad" is legible without reading the numbers.
  const span = row.key === 'coherence' || row.key === 'concentration' ? 1 : 100;
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / span) * 100))}%`;
  const color = STATUS_COLOR[row.status];

  return (
    <div className="gauge">
      <div className="gauge-track">
        <div className="gauge-fill" style={{ width: pct(row.value), background: color }} />
        <div className="gauge-tick" style={{ left: pct(row.crit), background: '#ff3b5c' }} title={`critical at ${row.crit}`} />
        <div className="gauge-tick" style={{ left: pct(row.warn), background: '#ffb02e' }} title={`warning at ${row.warn}`} />
      </div>
    </div>
  );
}

/**
 * Each check knows which layers prove it. A flag you cannot interrogate is
 * just a number; this turns every row into a one-click jump to the evidence,
 * which is the difference between a report and a tool.
 */
const EVIDENCE: Record<string, { patch: any; label: string }> = {
  utilisation: {
    label: 'Show ignored area',
    patch: { showDead: true, showHeat: false, showDiff: false, showFlow: false, showPaths: false, showEvents: false },
  },
  coherence: {
    label: 'Show flow field',
    patch: { showFlow: true, flowMin: 0.3, showHeat: true, heatMetric: 'traffic', showDiff: false, showDead: false, showPaths: false, showEvents: false },
  },
  concentration: {
    label: 'Show traffic density',
    patch: { showHeat: true, heatMetric: 'traffic', showDiff: false, showFlow: false, showDead: false, showPaths: false, showEvents: false },
  },
  extraction: {
    label: 'Show exfil zones',
    patch: { showExfil: true, colorByOutcome: true, showHeat: false, showDiff: false, showFlow: false, showDead: false, showPaths: false, showEvents: false },
  },
  storm_reach: {
    label: 'Show storm deaths',
    patch: { showHeat: true, heatMetric: 'storm', showDiff: false, showFlow: false, showDead: false, showPaths: false, showEvents: true },
  },
  pvp_share: {
    label: 'Show kill zones',
    patch: { showHeat: true, heatMetric: 'kills', showDiff: false, showFlow: false, showDead: false, showPaths: false, showEvents: false },
  },
  shared: {
    label: 'Show shared matches only',
    patch: { minHumans: 2, showHeat: true, heatMetric: 'traffic_human', showDiff: false, showFlow: false, showDead: false, showPaths: false, showEvents: false },
  },
};

function Row({ row }: { row: ScorecardRow }) {
  const [open, setOpen] = useState(false);
  const patch = useStore((s) => s.patch);
  const setOpenCard = useStore((s) => s.setScorecard);
  const ev = EVIDENCE[row.key];
  const color = STATUS_COLOR[row.status];
  return (
    <div className={`sc-row ${row.status}`} onClick={() => setOpen(!open)}>
      <div className="sc-top">
        <span className="sc-dot" style={{ background: color }} />
        <span className="sc-label">{row.label}</span>
        <span className="sc-value" style={{ color }}>
          {row.value}
          <em>{row.unit}</em>
        </span>
      </div>
      <Gauge row={row} />
      <div className="sc-why">
        {row.why}
        {ev && (
          <button
            className="sc-ev"
            onClick={(e) => {
              e.stopPropagation();
              patch(ev.patch);
              setOpenCard(false);
            }}
          >
            {ev.label} →
          </button>
        )}
        {open && (
          <div className="sc-thr">
            {row.higher ? 'Higher is better. ' : 'Lower is better. '}
            Flags at <b>{row.warn}{row.unit}</b> (warn) and <b>{row.crit}{row.unit}</b> (critical).
            Thresholds are design judgements declared in <code>SCORECARD_RULES</code>, not industry constants.
          </div>
        )}
      </div>
    </div>
  );
}

export default function Scorecard() {
  const bundle = useStore((s) => s.bundle)!;
  const open = useStore((s) => s.scorecardOpen);
  const setOpen = useStore((s) => s.setScorecard);
  const mapId = useStore((s) => s.filters.mapId);
  const patch = useStore((s) => s.patch);
  const [copied, setCopied] = useState(false);

  const cards = bundle.scorecard ?? {};
  const card = cards[mapId];

  // Rank the three maps by how much is wrong with them. Comparing a map
  // against its siblings is more honest than comparing it to an invented
  // absolute, since all three ship in the same game.
  const ranked = useMemo(
    () =>
      Object.entries(cards)
        .map(([id, c]) => ({ id, ...c }))
        .sort((a, b) => b.critical - a.critical || b.flags - a.flags),
    [cards],
  );

  const markdown = useMemo(() => {
    if (!card) return '';
    const lines = [
      `# Map health — ${bundle.maps[mapId]?.label ?? mapId}`,
      '',
      `${card.matches} matches · median duration ${fmtTime(card.median_duration)} · ${card.kills_per_match} kills/match`,
      `**${card.critical} critical**, ${card.flags - card.critical} warnings of ${card.rows.length} checks.`,
      '',
      '| Status | Metric | Value | Warn | Critical |',
      '|---|---|---|---|---|',
      ...card.rows.map(
        (r) =>
          `| ${r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️' : '🛑'} | ${r.label} | ${r.value}${r.unit} | ${r.warn}${r.unit} | ${r.crit}${r.unit} |`,
      ),
      '',
      '## Flagged',
      ...card.rows.filter((r) => r.status !== 'ok').map((r) => `- **${r.label}** at ${r.value}${r.unit} — ${r.why}`),
      '',
      `_Generated by the LILA BLACK Player Journey tool from ${bundle.stats.rows.toLocaleString()} telemetry rows. Thresholds are design judgements, declared in \`pipeline/build.py\`._`,
    ];
    return lines.join('\n');
  }, [card, mapId, bundle]);

  if (!open) return null;

  return (
    <div className="help" onClick={() => setOpen(false)}>
      <div className="card scorecard" onClick={(e) => e.stopPropagation()}>
        <div className="sc-head">
          <div>
            <h2>Map health · {bundle.maps[mapId]?.label ?? mapId}</h2>
            <div className="note">
              {card ? (
                <>
                  {card.matches} matches · median {fmtTime(card.median_duration)} ·{' '}
                  {card.kills_per_match} kills/match —{' '}
                  <b style={{ color: card.critical ? '#ff3b5c' : '#34d399' }}>
                    {card.critical} critical
                  </b>
                  , {card.flags - card.critical} warnings of {card.rows.length} checks
                </>
              ) : (
                'No data for this map.'
              )}
            </div>
          </div>
          <div className="sc-actions">
            <button
              className="btn"
              onClick={() => {
                navigator.clipboard?.writeText(markdown);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              }}
            >
              {copied ? '✓ Copied' : '⧉ Copy as Markdown'}
            </button>
            <button className="btn" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>

        <div className="sc-maps">
          {ranked.map((r) => (
            <button
              key={r.id}
              className={`sc-map ${r.id === mapId ? 'on' : ''}`}
              onClick={() => patch({ mapId: r.id, matchId: null })}
            >
              <span>{bundle.maps[r.id]?.label ?? r.id}</span>
              <span className="sc-chips">
                {r.critical > 0 && <em className="crit">{r.critical}</em>}
                {r.flags - r.critical > 0 && <em className="warn">{r.flags - r.critical}</em>}
                {r.flags === 0 && <em className="ok">clear</em>}
              </span>
            </button>
          ))}
        </div>

        {card && (
          <>
            <div className="sc-grid">
              {card.rows
                .slice()
                .sort(
                  (a, b) =>
                    ({ critical: 0, warn: 1, ok: 2 }[a.status] - { critical: 0, warn: 1, ok: 2 }[b.status]),
                )
                .map((r) => (
                  <Row key={r.key} row={r} />
                ))}
            </div>
            <div className="note" style={{ marginTop: 12 }}>
              Checks are ordered by severity, not by importance. Click any row for its
              thresholds. Nothing here is a composite score — averaging these dimensions
              would let one catastrophic metric hide behind six healthy ones.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
