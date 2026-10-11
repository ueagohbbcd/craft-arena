#!/usr/bin/env python3
"""Estimate count-only payload sizes from saved observations, without world access.

Usage: python scripts/estimate-recent-block-context.py EXPORT_DIR --output report.json
The export must contain manifest.json and its three NDJSON files. No server or
model API is contacted; missing detail is never reconstructed.
"""
import argparse
import bisect
import collections
import hashlib
import json
import math
from pathlib import Path
import statistics

AIR = {"air", "cave_air", "void_air"}
AXES = ("x", "y", "z")


def load(source, name, manifest):
    raw = (source / name).read_bytes()
    expected = manifest["files"][name]["sha256"]
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError(f"Checksum does not match manifest: {name}")
    return [json.loads(line) for line in raw.splitlines() if line.strip()]


def detail_counts(observations):
    groups = collections.defaultdict(set)
    for observation in observations:
        for block in (observation.get("local") or {}).get("blocks", []):
            position, name = block.get("position"), block.get("name")
            if not position or not name or name in AIR:
                continue
            scope = (observation["player"], observation.get("freshness", {}).get("epoch"))
            groups[name].add(scope + tuple(position[axis] for axis in AXES))
    return dict(sorted((name, len(positions)) for name, positions in groups.items()))


def measure(counts):
    text = json.dumps(counts, separators=(",", ":"), ensure_ascii=False)
    return {
        "types": len(counts), "characters": len(text), "bytes": len(text.encode()),
        "tokenEstimate": [math.ceil(len(text) / 4), math.ceil(len(text) / 3)],
        "counts": counts,
    }


def distribution(values):
    values = sorted(values)
    if not values:
        return {"n": 0}
    return {
        "n": len(values), "min": values[0], "median": statistics.median(values),
        "p90": values[math.ceil(len(values) * .90) - 1],
        "p95": values[math.ceil(len(values) * .95) - 1], "max": values[-1],
    }


def coordinates(record):
    return tuple(record["position"][axis] for axis in AXES)


def moving_spans(trajectory):
    """Descriptive proxy only: >=3 successive moving steps, not semantic trips."""
    run = []
    for previous, current in zip(trajectory, trajectory[1:]):
        gap = current["sourceTime"] - previous["sourceTime"]
        distance = math.dist(coordinates(previous), coordinates(current))
        moving = (0 < gap <= 5000 and .2 < distance <= 20
                  and previous.get("deaths") == current.get("deaths"))
        if moving:
            if not run:
                run = [previous]
            run.append(current)
        else:
            if len(run) >= 4:
                yield run
            run = []
    if len(run) >= 4:
        yield run


def analyze(source):
    manifest = json.loads((source / "manifest.json").read_text())
    observations = load(source, "observation-boundaries.ndjson", manifest)
    trajectories = load(source, "trajectory.ndjson", manifest)
    queries = load(source, "queried-block-batches.ndjson", manifest)
    boundaries, segments, batches = [], [], []
    union_types = collections.defaultdict(set)
    filtered_without_omission = 0
    for observation in observations:
        local = observation.get("local") or {}
        coverage = local.get("counts") or {}
        counts = detail_counts([observation])
        known_non_air = (coverage.get("solid") or 0) + (coverage.get("nonColliding") or 0)
        omitted = local.get("omitted") or 0
        if not omitted and known_non_air > sum(counts.values()):
            filtered_without_omission += 1
        boundaries.append({
            "player": observation["player"], "omitted": omitted,
            "knownNonAir": known_non_air, "sourceResult": observation["sourceResult"],
            **measure(counts),
        })
        union_types[observation["player"]].update(counts)
    for player in sorted(union_types):
        points = sorted((r for r in trajectories if r["player"] == player), key=lambda r: r["sourceTime"])
        sample_times = [r["sourceTime"] for r in points]
        local_observations = [o for o in observations if o["player"] == player
                              and o.get("freshness", {}).get("sampledAt") is not None]
        for span in moving_spans(points):
            start, end = span[0]["sourceTime"], span[-1]["sourceTime"]
            selected = [o for o in local_observations if start <= o["freshness"]["sampledAt"] <= end]
            if not selected:
                continue
            time_differences = []
            for observation in selected:
                stamp = observation["freshness"]["sampledAt"]
                index = bisect.bisect_left(sample_times, stamp)
                nearest = min(points[max(0, index - 1):index + 1], key=lambda r: abs(r["sourceTime"] - stamp))
                time_differences.append(abs(nearest["sourceTime"] - stamp))
            segments.append({
                "player": player, "durationMs": end - start,
                "distance": sum(math.dist(coordinates(a), coordinates(b)) for a, b in zip(span, span[1:])),
                "trajectoryPoints": len(span), "boundaries": len(selected),
                "omitted": sum((o.get("local") or {}).get("omitted") or 0 for o in selected),
                "maxNearestTrajectoryTimeDifferenceMs": max(time_differences),
                "sourceResults": [o["sourceResult"] for o in selected],
                **measure(detail_counts(selected)),
            })
    for query in queries:
        groups, unknown = collections.defaultdict(set), 0
        for block in query["cells"]:
            position, name = block.get("position"), block.get("name")
            if block.get("known") is False or not position or not name:
                unknown += 1
            elif name not in AIR:
                groups[name].add(tuple(position[axis] for axis in AXES))
        counts = dict(sorted((name, len(positions)) for name, positions in groups.items()))
        union_types[query["player"]].update(counts)
        batches.append({
            "player": query["player"], "cells": len(query["cells"]), "unknown": unknown,
            "sourceResult": query["sourceResult"], "sampleTimeInterval": query["sampleTimeInterval"],
            **measure(counts),
        })
    examples = lambda rows, count: sorted(rows, key=lambda row: (row["types"], row["characters"]), reverse=True)[:count]
    return {
        "sourceManifest": {"capturedAt": manifest["capturedAt"], "files": manifest["files"]},
        "method": {
            "counts": "Only supplied non-air names and coordinates. Boundary unions deduplicate by player, epoch, coordinate and type; dimension is not in this export, so no cross-world identity is claimed.",
            "movement": "At least 3 consecutive native displacements >0.2 and <=20 blocks, gaps <=5 seconds and unchanged death count; boundary sampledAt lies within the span. Query batches remain separate because their sample time is only task-bounded.",
            "tokens": "characters / 4 through characters / 3, rounded up; rough estimates, not tokenizer counts. Counts-object payload only; shared model envelope is additional.",
            "limits": "Saved 5x5x5 detail is filtered and sometimes truncated. Even omitted=0 is not all non-air blocks. Missing detail is never air or an invented type. This is a lower-bound proxy, not radius-6 connected-space coverage.",
        },
        "summary": {
            "boundaries": len(boundaries),
            "boundariesWithOmitted": sum(row["omitted"] > 0 for row in boundaries),
            "totalOmitted": sum(row["omitted"] for row in boundaries),
            "filteredEvenWithoutOmitted": filtered_without_omission,
            "boundaryTypes": distribution([row["types"] for row in boundaries]),
            "boundaryCharacters": distribution([row["characters"] for row in boundaries]),
            "movementSpans": len(segments),
            "movementTypes": distribution([row["types"] for row in segments]),
            "movementCharacters": distribution([row["characters"] for row in segments]),
            "queryBatches": len(batches),
            "queryTypes": distribution([row["types"] for row in batches]),
            "queryCharacters": distribution([row["characters"] for row in batches]),
            "wholeExportTypesByPlayer": {player: len(names) for player, names in sorted(union_types.items())},
            "wholeExportTypeUnion": len(set().union(*union_types.values())),
        },
        "boundaryExamples": examples(boundaries, 2),
        "movementExamples": examples(segments, 2),
        "queryExamples": examples(batches, 3),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    text = json.dumps(analyze(args.source), indent=2, ensure_ascii=False) + "\n"
    if args.output:
        args.output.write_text(text)
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
