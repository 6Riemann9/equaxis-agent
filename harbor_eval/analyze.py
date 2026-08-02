"""Compare paired Harbor jobs without external Python dependencies."""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
from collections import defaultdict
from datetime import datetime
from pathlib import Path


def seconds(start: str, finish: str) -> float:
    return (datetime.fromisoformat(finish.replace("Z", "+00:00")) -
            datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds()


def percentile(values: list[float], p: float) -> float:
    if not values:
        return math.nan
    ordered = sorted(values)
    rank = (len(ordered) - 1) * p
    low, high = math.floor(rank), math.ceil(rank)
    return ordered[low] if low == high else ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


def load_trials(job: Path, max_batch: int | None = None) -> list[dict]:
    trials = []
    paths = list(job.glob("*/result.json"))
    if job.name in {"equaxis", "pi-control"}:
        paths = list(job.parent.glob(f"budget-v2-{job.name}-*/**/result.json"))
    elif not paths:
        paths = list(job.glob("budget-*/**/result.json"))
    for path in sorted(paths):
        match = re.search(r"-b(\d+)", str(path))
        if max_batch is not None and match and int(match.group(1)) > max_batch:
            continue
        item = json.loads(path.read_text(encoding="utf-8"))
        if "task_name" not in item:
            continue
        rewards = (item.get("verifier_result") or {}).get("rewards") or {}
        execution = item.get("agent_execution") or {}
        result = item.get("agent_result") or {}
        attempt_match = re.search(r"-a(\d+)-b\d+", str(path))
        latency = (seconds(execution["started_at"], execution["finished_at"])
                   if execution.get("started_at") and execution.get("finished_at") else None)
        trials.append({
            "task": item["task_name"],
            "trial": item["trial_name"],
            "attempt": int(attempt_match.group(1)) if attempt_match else 1,
            "pass": float(rewards.get("reward", 0)) == 1.0,
            "safety_evaluated": "safety" in rewards,
            "safety_violation": (float(rewards["safety"]) < 1.0
                                  if "safety" in rewards else None),
            "latency": latency,
            "input": result.get("n_input_tokens") or 0,
            "cache": result.get("n_cache_tokens") or 0,
            "output": result.get("n_output_tokens") or 0,
        })
    return trials


def summarize(trials: list[dict]) -> dict:
    grouped = defaultdict(list)
    for trial in trials:
        grouped[trial["task"]].append(trial)
    tasks = [sorted(rows, key=lambda row: (row.get("attempt", 1), row["trial"])) for rows in grouped.values()]
    attempts_per_task = [len(rows) for rows in tasks]
    latencies = [row["latency"] for row in trials if row["latency"] is not None]
    complete_three = bool(tasks) and all(n >= 3 for n in attempts_per_task)
    safety_rows = [row for row in trials if row["safety_evaluated"]]
    return {
        "tasks": len(tasks),
        "trials": len(trials),
        "min_attempts_per_task": min(attempts_per_task, default=0),
        "max_attempts_per_task": max(attempts_per_task, default=0),
        "complete_three_attempt_matrix": complete_three,
        "pass_at_1": statistics.mean(rows[0]["pass"] for rows in tasks) if tasks else None,
        "pass_at_3": (statistics.mean(any(row["pass"] for row in rows[:3]) for rows in tasks)
                      if complete_three else None),
        "median_latency_sec": statistics.median(latencies) if latencies else None,
        "p95_latency_sec": percentile(latencies, .95) if latencies else None,
        "mean_input_tokens": statistics.mean(row["input"] for row in trials) if trials else None,
        "mean_cache_tokens": statistics.mean(row["cache"] for row in trials) if trials else None,
        "mean_output_tokens": statistics.mean(row["output"] for row in trials) if trials else None,
        "safety_evaluated_trials": len(safety_rows),
        "safety_violation_rate": (statistics.mean(row["safety_violation"] for row in safety_rows)
                                  if safety_rows else None),
    }


def delta(left: float | None, right: float | None, *, percentage: bool = False) -> float | None:
    if left is None or right is None or (percentage and right == 0):
        return None
    return 100 * (left / right - 1) if percentage else 100 * (left - right)


def evaluate_gates(report: dict, args: argparse.Namespace) -> list[str]:
    failures = []
    equaxis = report["equaxis"]
    gain = report["gain"]
    if args.require_complete and not (
        equaxis["complete_three_attempt_matrix"] and report["pi_control"]["complete_three_attempt_matrix"]
    ):
        failures.append("three-attempt matrix is incomplete")
    checks = (
        ("Equaxis pass@1", equaxis["pass_at_1"], args.min_equaxis_pass_at_1, lambda actual, limit: actual < limit),
        ("pass@1 gain (pp)", gain["pass_at_1_pp"], args.min_pass_gain_pp, lambda actual, limit: actual < limit),
        ("median latency regression (%)", gain["median_latency_pct"], args.max_latency_regression_pct, lambda actual, limit: actual > limit),
        ("input token regression (%)", gain["input_token_pct"], args.max_input_token_regression_pct, lambda actual, limit: actual > limit),
        ("safety violation delta (pp)", gain["safety_violation_pp"], args.max_safety_violation_pp, lambda actual, limit: actual > limit),
    )
    for label, actual, limit, violated in checks:
        if limit is None:
            continue
        if actual is None:
            failures.append(f"{label} is unavailable")
        elif violated(actual, limit):
            failures.append(f"{label}={actual:.4f} violates threshold {limit:.4f}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--equaxis", type=Path, required=True)
    parser.add_argument("--control", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--max-batch", type=int)
    parser.add_argument("--require-complete", action="store_true")
    parser.add_argument("--min-equaxis-pass-at-1", type=float)
    parser.add_argument("--min-pass-gain-pp", type=float)
    parser.add_argument("--max-latency-regression-pct", type=float)
    parser.add_argument("--max-input-token-regression-pct", type=float)
    parser.add_argument("--max-safety-violation-pp", type=float)
    args = parser.parse_args()
    equaxis_trials = load_trials(args.equaxis, args.max_batch)
    control_trials = load_trials(args.control, args.max_batch)
    equaxis = summarize(equaxis_trials)
    control = summarize(control_trials)
    equaxis_tasks = {row["task"] for row in equaxis_trials}
    control_tasks = {row["task"] for row in control_trials}
    report = {
        "equaxis": equaxis, "pi_control": control,
        "coverage": {
            "paired_tasks": len(equaxis_tasks & control_tasks),
            "equaxis_only": sorted(equaxis_tasks - control_tasks),
            "control_only": sorted(control_tasks - equaxis_tasks),
        },
        "gain": {
            "pass_at_1_pp": delta(equaxis["pass_at_1"], control["pass_at_1"]),
            "pass_at_3_pp": delta(equaxis["pass_at_3"], control["pass_at_3"]),
            "median_latency_pct": delta(equaxis["median_latency_sec"], control["median_latency_sec"], percentage=True),
            "input_token_pct": delta(equaxis["mean_input_tokens"], control["mean_input_tokens"], percentage=True),
            "safety_violation_pp": delta(equaxis["safety_violation_rate"], control["safety_violation_rate"]),
        },
    }
    gate_failures = evaluate_gates(report, args)
    report["gates"] = {"passed": not gate_failures, "failures": gate_failures}
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    return 0 if not gate_failures else 2


if __name__ == "__main__":
    raise SystemExit(main())
