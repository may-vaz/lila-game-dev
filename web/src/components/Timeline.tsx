import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../store';
import { useFiltered } from '../lib/useFiltered';
import { fmtTime } from '../lib/viz';

const BINS = 110;
const SPEEDS = [1, 2, 4, 8, 16];

export default function Timeline() {
  const time = useStore((s) => s.time);
  const setTime = useStore((s) => s.setTime);
  const playing = useStore((s) => s.playing);
  const setPlaying = useStore((s) => s.setPlaying);
  const speed = useStore((s) => s.speed);
  const setSpeed = useStore((s) => s.setSpeed);
  const { match, events, duration } = useFiltered();

  const trackRef = useRef<HTMLDivElement>(null);
  const raf = useRef<number>(0);
  const last = useRef<number>(0);

  // animation loop
  useEffect(() => {
    if (!playing) {
      cancelAnimationFrame(raf.current);
      return;
    }
    last.current = performance.now();
    const tick = (now: number) => {
      const dt = (now - last.current) / 1000;
      last.current = now;
      const next = useStore.getState().time + dt * useStore.getState().speed;
      if (next >= duration) {
        setTime(duration);
        setPlaying(false);
        return;
      }
      setTime(next);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, duration, setTime, setPlaying]);

  // event-density histogram baked into the scrubber
  const hist = useMemo(() => {
    const h = new Array(BINS).fill(0);
    if (duration <= 0) return h;
    for (const e of events) {
      const b = Math.min(BINS - 1, Math.max(0, Math.floor((e.t / duration) * BINS)));
      h[b]++;
    }
    const max = Math.max(...h, 1);
    return h.map((v) => v / max);
  }, [events, duration]);

  const seek = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    setTime(p * duration);
  };

  if (!match) {
    return (
      <div className="timeline">
        <div style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 11.5, padding: '8px 0' }}>
          No match in scope — clear the date or <b>min. human players</b> filter in the left panel, or switch map.
        </div>
      </div>
    );
  }

  const pct = duration > 0 ? (time / duration) * 100 : 0;

  return (
    <div className="timeline">
      <div className="tl-top">
        <button
          className={`play ${playing ? '' : 'paused'}`}
          onClick={() => {
            if (time >= duration) setTime(0);
            setPlaying(!playing);
          }}
          title="Space"
        >
          {playing ? '❚❚' : '▶'}
        </button>

        <div className="clock">
          {fmtTime(time)} <span className="dim">/ {fmtTime(duration)}</span>
        </div>

        <div className="speeds">
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-3)' }}>
          {events.filter((e) => e.t <= time).length} / {events.length} events elapsed
        </div>
      </div>

      <div
        className="track-wrap"
        ref={trackRef}
        onMouseDown={(e) => {
          seek(e.clientX);
          const mv = (m: MouseEvent) => seek(m.clientX);
          const up = () => {
            window.removeEventListener('mousemove', mv);
            window.removeEventListener('mouseup', up);
          };
          window.addEventListener('mousemove', mv);
          window.addEventListener('mouseup', up);
        }}
      >
        <div className="hist">
          {hist.map((v, i) => (
            <i
              key={i}
              style={{
                height: `${Math.max(2, v * 100)}%`,
                opacity: i / BINS <= time / Math.max(duration, 1) ? 1 : 0.32,
              }}
            />
          ))}
        </div>
        <div className="track">
          <div className="fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="playhead" style={{ left: `${pct}%` }} />
      </div>
    </div>
  );
}
