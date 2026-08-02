"""Run the paired benchmark while enforcing a conservative token budget."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


AGENTS = (("equaxis", "harbor_eval.agent:Equaxis"),
          ("pi-control", "harbor_eval.agent:PiControl"))


def usage(jobs_dir: Path) -> int:
    total = 0
    for result in jobs_dir.glob("budget-*/result.json"):
        data = json.loads(result.read_text(encoding="utf-8"))
        stats = data.get("stats", {})
        total += (stats.get("n_input_tokens") or 0) + (stats.get("n_output_tokens") or 0)
    return total


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--budget", type=int, default=10_000_000)
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=5)
    parser.add_argument("--reserve-per-trial", type=int, default=250_000)
    parser.add_argument("--model", default="openai-inprior/gpt-5.5")
    parser.add_argument("--dataset", type=Path, default=Path("harbor_eval/benchmark-dataset/tasks"))
    parser.add_argument("--task-source", type=Path, default=Path("harbor_eval/benchmark-dataset/tasks"))
    parser.add_argument("--jobs", type=Path, default=Path("harbor_eval/jobs"))
    args = parser.parse_args()
    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY is required")

    tasks = sorted(path.name for path in args.task_source.iterdir() if path.is_dir())
    batches = [tasks[i:i + args.batch_size] for i in range(0, len(tasks), args.batch_size)]
    args.jobs.mkdir(parents=True, exist_ok=True)
    manifest = {"budget": args.budget, "attempts_requested": args.attempts,
                "reserve_per_trial": args.reserve_per_trial, "runs": []}

    # Alternate agents within each attempt so neither group systematically receives
    # the larger remaining budget. Existing completed jobs make the run resumable.
    for attempt in range(1, args.attempts + 1):
        order = AGENTS if attempt % 2 else tuple(reversed(AGENTS))
        for batch_index, batch in enumerate(batches, 1):
            for label, agent in order:
                job_name = f"budget-v2-{label}-a{attempt}-b{batch_index}"
                result = args.jobs / job_name / "result.json"
                if result.exists():
                    continue
                consumed = usage(args.jobs)
                reserve = args.reserve_per_trial * len(batch)
                if consumed + reserve > args.budget:
                    manifest["tokens_consumed"] = consumed
                    manifest["stopped"] = "insufficient_reserved_budget"
                    (args.jobs / "budget-manifest.json").write_text(
                        json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
                    print(f"STOP: {consumed:,} tokens used; {reserve:,} reserved for next batch")
                    return 2
                command = ["harbor", "run", "-p", str(args.dataset), "-a", agent,
                           "-m", args.model, "-n", str(len(batch)), "-o", str(args.jobs),
                           "--job-name", job_name, "--agent-timeout-multiplier", "3", "-y"]
                for task in batch:
                    command.extend(["-i", task])
                print(f"RUN {job_name}: used={consumed:,}, reserve={reserve:,}", flush=True)
                completed = subprocess.run(command, env=os.environ.copy(), check=False)
                manifest["runs"].append({"job": job_name, "exit_code": completed.returncode})
                if not result.exists():
                    raise SystemExit(f"Harbor did not produce {result}")
                if usage(args.jobs) > args.budget:
                    raise SystemExit("Token budget exceeded despite reservation; increase reserve-per-trial")

    manifest["tokens_consumed"] = usage(args.jobs)
    manifest["stopped"] = "complete"
    (args.jobs / "budget-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
