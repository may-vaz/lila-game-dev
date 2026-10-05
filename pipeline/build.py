#!/usr/bin/env python3
"""
LILA BLACK - Player Journey Visualisation
Offline data pipeline: raw parquet shards  ->  web-ready static artefacts.

Run:
    python pipeline/build.py --input ./player_data --out ./web/public/data

What it does
------------
1. Walks every `*.nakama-0` parquet file (one player, one match).
2. Decodes the bytes-encoded `event` column.
3. Repairs the `ts` column (see TIMESTAMP note below).
4. Classifies humans vs bots from the user_id shape, and cross-checks it
   against the event vocabulary.
5. Projects world (x, z) -> normalised UV using the per-map config.
6. Simplifies movement paths (Ramer-Douglas-Peucker) to cut payload size.
7. Emits a single compact JSON bundle + a per-map prebuilt traffic grid.
8. Writes a data-quality report describing everything it dropped and why.

TIMESTAMP note (important)
--------------------------
The parquet `ts` column is typed `timestamp[ms]`, and the supplied README
claims it is "time elapsed within the match, not wall-clock time".
Read literally, every match in the dataset happens on 1970-01-21 and lasts
~0.4 seconds.

The underlying int64 is actually **epoch SECONDS** that was written with a
millisecond unit. Reinterpreting it as seconds yields timestamps in
Feb 2026 that line up exactly with the day-folder names, and match
durations of a few minutes. We therefore reinterpret, and log the fix.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

# --------------------------------------------------------------------------
# Map configuration (from the dataset README).
# scale / origin define the world->UV projection. The README states the
# minimaps are 1024x1024; they are not (4320, 2160, 9000 px), so we keep
# everything in resolution-independent UV space and let the client scale.
# --------------------------------------------------------------------------
MAP_CONFIG = {
    "AmbroseValley": {"scale": 900.0, "origin_x": -370.0, "origin_z": -473.0,
                      "label": "Ambrose Valley", "image": "AmbroseValley_Minimap.png"},
    "GrandRift":     {"scale": 581.0, "origin_x": -290.0, "origin_z": -290.0,
                      "label": "Grand Rift",     "image": "GrandRift_Minimap.png"},
    "Lockdown":      {"scale": 1000.0, "origin_x": -500.0, "origin_z": -500.0,
                      "label": "Lockdown",       "image": "Lockdown_Minimap.jpg"},
}

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

POSITION_EVENTS = {"Position", "BotPosition"}
# Semantics are relative to the file's owner (the subject of the journey).
EVENT_META = {
    "Position":      {"kind": "position", "actor": "human"},
    "BotPosition":   {"kind": "position", "actor": "bot"},
    "Kill":          {"kind": "kill",     "actor": "human", "victim": "human"},
    "Killed":        {"kind": "death",    "actor": "human", "killer": "human"},
    "BotKill":       {"kind": "kill",     "actor": "human", "victim": "bot"},
    "BotKilled":     {"kind": "death",    "actor": "human", "killer": "bot"},
    "KilledByStorm": {"kind": "storm",    "actor": "human"},
    "Loot":          {"kind": "loot",     "actor": "any"},
}

TRAFFIC_GRID = 64  # NxN occupancy grid per map, used for heatmaps + dead zones


@dataclass
class QualityLog:
    files_seen: int = 0
    files_unreadable: list = field(default_factory=list)
    files_empty: list = field(default_factory=list)
    rows_in: int = 0
    rows_dropped: Counter = field(default_factory=Counter)
    notes: list = field(default_factory=list)
    unknown_events: Counter = field(default_factory=Counter)
    bot_flag_conflicts: int = 0


def rdp(points: np.ndarray, epsilon: float) -> np.ndarray:
    """Ramer-Douglas-Peucker. points = (N,2) in UV space. Returns a boolean keep-mask."""
    n = len(points)
    keep = np.zeros(n, dtype=bool)
    if n == 0:
        return keep
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        start, end = stack.pop()
        if end <= start + 1:
            continue
        seg = points[end] - points[start]
        seg_len = math.hypot(seg[0], seg[1])
        sl = points[start + 1:end] - points[start]
        if seg_len < 1e-12:
            dist = np.hypot(sl[:, 0], sl[:, 1])
        else:
            dist = np.abs(sl[:, 0] * seg[1] - sl[:, 1] * seg[0]) / seg_len
        idx = int(np.argmax(dist))
        if dist[idx] > epsilon:
            mid = start + 1 + idx
            keep[mid] = True
            stack.append((start, mid))
            stack.append((mid, end))
    return keep


def load_raw(input_dir: str, log: QualityLog) -> pd.DataFrame:
    paths = []
    for root, _dirs, files in os.walk(input_dir):
        for fn in files:
            if fn.endswith(".nakama-0") or fn.endswith(".parquet"):
                paths.append(os.path.join(root, fn))
    paths.sort()
    log.files_seen = len(paths)
    print(f"  found {len(paths)} parquet shards")

    frames = []
    for p in paths:
        try:
            df = pq.read_table(p).to_pandas()
        except Exception as e:  # noqa: BLE001
            log.files_unreadable.append((os.path.relpath(p, input_dir), str(e)[:120]))
            continue
        if df.empty:
            log.files_empty.append(os.path.relpath(p, input_dir))
            continue
        df["src_day_folder"] = os.path.basename(os.path.dirname(p))
        frames.append(df)

    if not frames:
        sys.exit("No readable parquet files found. Check --input path.")
    raw = pd.concat(frames, ignore_index=True)
    log.rows_in = len(raw)
    return raw


def clean(raw: pd.DataFrame, log: QualityLog) -> pd.DataFrame:
    df = raw.copy()

    # 1. event column is parquet `binary` -> decode to utf-8
    if df["event"].dtype == object and isinstance(df["event"].iloc[0], (bytes, bytearray)):
        df["event"] = df["event"].str.decode("utf-8")
    df["event"] = df["event"].astype(str).str.strip()

    unknown = set(df["event"].unique()) - set(EVENT_META)
    if unknown:
        for u in unknown:
            log.unknown_events[u] = int((df["event"] == u).sum())
        log.notes.append(f"Unknown event types encountered and kept as 'other': {sorted(unknown)}")

    # 2. Timestamp repair: stored as timestamp[ms] but the int64 is epoch seconds.
    epoch_units = df["ts"].astype("int64")  # ms since epoch, as stored
    ts_literal = pd.to_datetime(epoch_units, unit="ms", utc=True)
    ts_fixed = pd.to_datetime(epoch_units, unit="s", utc=True)
    df["ts_utc"] = ts_fixed
    log.notes.append(
        f"Timestamp reinterpreted from ms->s. Literal reading spans "
        f"{ts_literal.min()} .. {ts_literal.max()} (implausible); "
        f"reinterpreted spans {ts_fixed.min()} .. {ts_fixed.max()}."
    )

    # 3. match_id carries a server-instance suffix; keep a clean id for display
    df["match_id"] = df["match_id"].astype(str)
    df["match_key"] = df["match_id"].str.replace(r"\.nakama-\d+$", "", regex=True)

    # 4. Bot classification from user_id shape, cross-checked against events
    df["user_id"] = df["user_id"].astype(str)
    df["is_bot"] = ~df["user_id"].str.match(UUID_RE)

    # Cross-check: BotPosition should only ever belong to a numeric (bot) user.
    conflict = df[(df["event"] == "BotPosition") & (~df["is_bot"])]
    log.bot_flag_conflicts = len(conflict)
    pos_by_numeric = int(((df["event"] == "Position") & (df["is_bot"])).sum())
    if pos_by_numeric:
        log.notes.append(
            f"{pos_by_numeric} rows have event='Position' (documented as human-only) but a "
            f"numeric user_id. user_id shape is treated as the source of truth for the "
            f"human/bot flag; the event vocabulary is treated as a hint only."
        )

    # 5. Drop unusable geometry
    before = len(df)
    df = df[np.isfinite(df["x"]) & np.isfinite(df["z"]) & np.isfinite(df["y"])]
    log.rows_dropped["non_finite_coordinates"] += before - len(df)

    before = len(df)
    df = df[~((df["x"] == 0) & (df["z"] == 0))]
    log.rows_dropped["exact_origin_(0,0)_placeholder"] += before - len(df)

    before = len(df)
    df = df[df["map_id"].isin(MAP_CONFIG)]
    log.rows_dropped["unknown_map_id"] += before - len(df)

    # 6. Project to UV
    scale = df["map_id"].map(lambda m: MAP_CONFIG[m]["scale"])
    ox = df["map_id"].map(lambda m: MAP_CONFIG[m]["origin_x"])
    oz = df["map_id"].map(lambda m: MAP_CONFIG[m]["origin_z"])
    df["u"] = (df["x"] - ox) / scale
    df["v"] = (df["z"] - oz) / scale

    before = len(df)
    oob = (df["u"] < -0.02) | (df["u"] > 1.02) | (df["v"] < -0.02) | (df["v"] > 1.02)
    log.rows_dropped["outside_minimap_bounds"] += int(oob.sum())
    df = df[~oob]
    df["u"] = df["u"].clip(0, 1)
    df["v"] = df["v"].clip(0, 1)

    # 7. De-duplicate identical rows (same user, match, ts, event, position)
    before = len(df)
    df = df.drop_duplicates(subset=["user_id", "match_key", "ts_utc", "event", "x", "z"])
    log.rows_dropped["exact_duplicate_rows"] += before - len(df)

    df = df.sort_values(["match_key", "user_id", "ts_utc"]).reset_index(drop=True)
    return df


def build_bundle(df: pd.DataFrame, log: QualityLog, rdp_eps: float):
    # Match-relative time: t = 0 at the first event of the match
    match_start = df.groupby("match_key")["ts_utc"].transform("min")
    df["t"] = (df["ts_utc"] - match_start).dt.total_seconds().astype("float32")

    df["kind"] = df["event"].map(lambda e: EVENT_META.get(e, {}).get("kind", "other"))

    matches, journeys, events = [], [], []

    for (map_id, match_key), m in df.groupby(["map_id", "match_key"], sort=False):
        m_start = m["ts_utc"].min()
        duration = float(m["t"].max())
        players = []

        for uid, p in m.groupby("user_id", sort=False):
            is_bot = bool(p["is_bot"].iloc[0])
            pos = p[p["event"].isin(POSITION_EVENTS)]
            path_t, path_u, path_v = [], [], []
            if len(pos) >= 2:
                pts = pos[["u", "v"]].to_numpy(dtype=np.float64)
                mask = rdp(pts, rdp_eps)
                sel = pos[mask]
                path_t = np.round(sel["t"].to_numpy(), 2).tolist()
                path_u = np.round(sel["u"].to_numpy(), 5).tolist()
                path_v = np.round(sel["v"].to_numpy(), 5).tolist()
            elif len(pos) == 1:
                log.rows_dropped["single_sample_path_not_drawable"] += 1

            pidx = len(journeys)
            journeys.append({
                "i": pidx, "m": match_key, "u": uid, "b": int(is_bot),
                "t": path_t, "x": path_u, "y": path_v,
            })

            nonpos = p[~p["event"].isin(POSITION_EVENTS)]
            for r in nonpos.itertuples(index=False):
                events.append({
                    "m": match_key, "p": pidx, "b": int(is_bot),
                    "k": r.kind, "e": r.event,
                    "t": round(float(r.t), 2),
                    "x": round(float(r.u), 5), "y": round(float(r.v), 5),
                    "h": round(float(r.y), 1),
                })

            players.append({
                "u": uid, "b": int(is_bot), "i": pidx,
                "samples": int(len(pos)),
                "dist": round(float(path_distance(pos)), 1),
            })

        ev = m[~m["event"].isin(POSITION_EVENTS)]["kind"].value_counts().to_dict()
        matches.append({
            "id": match_key,
            "map": map_id,
            "start": m_start.isoformat(),
            "date": m_start.date().isoformat(),
            "dur": round(duration, 1),
            "humans": int(m[~m["is_bot"]]["user_id"].nunique()),
            "bots": int(m[m["is_bot"]]["user_id"].nunique()),
            "players": players,
            "counts": {k: int(v) for k, v in ev.items()},
        })

    return matches, journeys, events


def path_distance(pos: pd.DataFrame) -> float:
    """Total travelled distance in WORLD units."""
    if len(pos) < 2:
        return 0.0
    dx = np.diff(pos["x"].to_numpy(dtype=np.float64))
    dz = np.diff(pos["z"].to_numpy(dtype=np.float64))
    return float(np.sum(np.hypot(dx, dz)))


def dilate(mask: np.ndarray, r: int) -> np.ndarray:
    """Binary dilation with a square structuring element, pure NumPy."""
    out = mask.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= np.roll(np.roll(mask, dy, axis=0), dx, axis=1)
    return out


def build_grids(df: pd.DataFrame):
    """
    Pre-binned NxN grids per map for traffic / kills / deaths / loot.

    Also derives a `playable` mask. Without it, "dead zone" would include the
    empty void outside the island, which is useless to a level designer - the
    interesting question is which *reachable* ground gets ignored. The mask is
    a morphological closing of the observed-traffic footprint: dilate to bridge
    gaps between corridors, then erode back so the outer silhouette is honest.
    """
    grids = {}
    for map_id, g in df.groupby("map_id"):
        n = TRAFFIC_GRID
        layers = {}
        for name, sel in [
            ("traffic", g["event"].isin(POSITION_EVENTS)),
            ("traffic_human", g["event"].isin(POSITION_EVENTS) & ~g["is_bot"]),
            ("kills", g["kind"] == "kill"),
            ("deaths", g["kind"] == "death"),
            ("loot", g["kind"] == "loot"),
            ("storm", g["kind"] == "storm"),
        ]:
            s = g[sel]
            grid = np.zeros((n, n), dtype=np.int32)
            if len(s):
                ix = np.clip((s["u"].to_numpy() * n).astype(int), 0, n - 1)
                iy = np.clip((s["v"].to_numpy() * n).astype(int), 0, n - 1)
                np.add.at(grid, (iy, ix), 1)
            layers[name] = grid
        occupied = layers["traffic"] > 0
        playable = dilate(occupied, 3)
        playable = ~dilate(~playable, 2)          # erode back
        playable |= occupied                      # never exclude real traffic
        grids[map_id] = {
            "n": n,
            "playable": playable.astype(np.uint8).flatten().tolist(),
            **{k: v.flatten().tolist() for k, v in layers.items()},
        }
    return grids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="folder containing February_* day folders")
    ap.add_argument("--out", required=True, help="output folder (web/public/data)")
    ap.add_argument("--rdp", type=float, default=0.0015,
                    help="path simplification tolerance in UV units (0 disables)")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    log = QualityLog()

    print("[1/5] loading raw parquet ...")
    raw = load_raw(args.input, log)
    print(f"      {log.rows_in:,} rows from {log.files_seen} files")

    print("[2/5] cleaning + projecting ...")
    df = clean(raw, log)
    print(f"      {len(df):,} rows survive")

    print("[3/5] building match / journey / event bundle ...")
    matches, journeys, events = build_bundle(df, log, args.rdp)
    print(f"      {len(matches)} matches, {len(journeys)} journeys, {len(events)} events")

    print("[4/5] building heat grids ...")
    grids = build_grids(df)

    print("[5/5] writing artefacts ...")
    maps_meta = {}
    for map_id, cfg in MAP_CONFIG.items():
        sub = df[df["map_id"] == map_id]
        if sub.empty:
            continue
        maps_meta[map_id] = {
            "id": map_id, "label": cfg["label"], "image": f"maps/{map_id}.webp",
            "scale": cfg["scale"], "originX": cfg["origin_x"], "originZ": cfg["origin_z"],
            "matches": int(sub["match_key"].nunique()),
            "rows": int(len(sub)),
            "elevation": [round(float(sub["y"].min()), 1), round(float(sub["y"].max()), 1)],
        }

    bundle = {
        "generated": pd.Timestamp.utcnow().isoformat(),
        "maps": maps_meta,
        "dates": sorted(df["ts_utc"].dt.date.astype(str).unique().tolist()),
        "matches": matches,
        "journeys": journeys,
        "events": events,
        "grids": grids,
        "stats": {
            "rows": int(len(df)),
            "matches": int(df["match_key"].nunique()),
            "humans": int(df[~df["is_bot"]]["user_id"].nunique()),
            "bots": int(df[df["is_bot"]]["user_id"].nunique()),
            "events": {k: int(v) for k, v in df["event"].value_counts().items()},
        },
    }

    out_json = os.path.join(args.out, "bundle.json")
    with open(out_json, "w") as f:
        json.dump(bundle, f, separators=(",", ":"))
    size = os.path.getsize(out_json) / 1e6
    print(f"      wrote {out_json}  ({size:.2f} MB)")

    write_report(args, log, df, bundle)
    print("done.")


def write_report(args, log: QualityLog, df: pd.DataFrame, bundle: dict):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "DATA_QUALITY.md")
    total_dropped = sum(log.rows_dropped.values())
    lines = [
        "# Data Quality Report",
        "",
        "Generated by `pipeline/build.py`. Every row the pipeline discarded is accounted for here.",
        "",
        "## Intake",
        "",
        f"| Metric | Value |",
        f"|---|---|",
        f"| Parquet shards found | {log.files_seen:,} |",
        f"| Unreadable shards | {len(log.files_unreadable)} |",
        f"| Empty shards | {len(log.files_empty)} |",
        f"| Rows read | {log.rows_in:,} |",
        f"| Rows dropped | {total_dropped:,} |",
        f"| Rows retained | {len(df):,} ({100*len(df)/max(log.rows_in,1):.2f}%) |",
        "",
        "## Rows dropped, by reason",
        "",
        "| Reason | Rows |",
        "|---|---|",
    ]
    if total_dropped == 0:
        lines.append("| _(nothing dropped)_ | 0 |")
    for reason, count in log.rows_dropped.most_common():
        if count:
            lines.append(f"| `{reason}` | {count:,} |")

    lines += ["", "## Notes & assumptions", ""]
    for n in log.notes:
        lines.append(f"- {n}")
    if log.unknown_events:
        lines.append(f"- Unknown event types: {dict(log.unknown_events)}")

    lines += [
        "",
        "## Retained dataset",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Matches | {bundle['stats']['matches']:,} |",
        f"| Human players | {bundle['stats']['humans']:,} |",
        f"| Bots | {bundle['stats']['bots']:,} |",
        f"| Journeys | {len(bundle['journeys']):,} |",
        f"| Discrete events | {len(bundle['events']):,} |",
        "",
        "### Event vocabulary",
        "",
        "| Event | Rows |",
        "|---|---|",
    ]
    for k, v in bundle["stats"]["events"].items():
        lines.append(f"| `{k}` | {v:,} |")

    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"      wrote {path}")


if __name__ == "__main__":
    main()
