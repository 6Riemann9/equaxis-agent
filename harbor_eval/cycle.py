"""CLI for the Equaxis Harbor evaluation improvement cycle."""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from harbor_eval.evaluation_cycle import (
    build_report,
    llm_prompt,
    load_harbor_records,
    load_taxonomy,
    render_markdown,
)


def responses_analyst(config: dict[str, Any]) -> Callable[[str], str]:
    key_name = config.get("apiKeyEnv", "OPENAI_API_KEY")
    api_key = os.environ.get(key_name)
    if not api_key:
        raise ValueError(f"LLM analysis requires environment variable {key_name}")
    model = config.get("model")
    if not model:
        raise ValueError("LLM analysis requires llm.model")
    endpoint = config.get("endpoint", "https://api.openai.com/v1/responses")

    def analyze(prompt: str) -> str:
        body = {"model": model, "input": prompt, "store": False, **config.get("request", {})}
        headers = {"content-type": "application/json", "authorization": f"Bearer {api_key}",
                   **config.get("headers", {})}
        request = urllib.request.Request(endpoint, data=json.dumps(body).encode(), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=float(config.get("timeoutSec", 180))) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:1000]
            raise RuntimeError(f"LLM analysis failed ({error.code}): {detail}") from error
        if isinstance(payload.get("output_text"), str):
            return payload["output_text"]
        text = "\n".join(
            str(part.get("text") or part.get("output_text") or "")
            for item in payload.get("output", [])
            for part in item.get("content", [])
            if part.get("text") or part.get("output_text")
        )
        if not text:
            raise RuntimeError("LLM analysis returned no text")
        return text

    return analyze


def write_outputs(output_dir: Path, report: dict[str, Any]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "cycle-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output_dir / "cycle-report.md").write_text(render_markdown(report), encoding="utf-8")
    (output_dir / "hypotheses.json").write_text(
        json.dumps(report["hypotheses"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output_dir / "llm-analysis-prompt.txt").write_text(llm_prompt(report) + "\n", encoding="utf-8")


def resolve(base: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else (base / path).resolve()


def main() -> int:
    parser = argparse.ArgumentParser(description="Equaxis Harbor evaluation improvement cycle")
    subparsers = parser.add_subparsers(dest="command", required=True)
    diagnose_parser = subparsers.add_parser("diagnose", help="Diagnose one Harbor baseline job")
    diagnose_parser.add_argument("--job", type=Path, required=True)
    diagnose_parser.add_argument("--taxonomy", type=Path, default=Path("harbor_eval/capabilities.json"))
    diagnose_parser.add_argument("--output-dir", type=Path, required=True)
    diagnose_parser.add_argument("--cycle-id")
    diagnose_parser.add_argument("--max-batch", type=int)

    cycle_parser = subparsers.add_parser("cycle", help="Analyze baseline/candidate experiments from a manifest")
    cycle_parser.add_argument("--manifest", type=Path, required=True)
    cycle_parser.add_argument("--output-dir", type=Path, required=True)
    cycle_parser.add_argument("--llm", action="store_true")
    args = parser.parse_args()

    if args.command == "diagnose":
        taxonomy = load_taxonomy(args.taxonomy.resolve())
        baseline = load_harbor_records(args.job.resolve(), taxonomy, variant="baseline", max_batch=args.max_batch)
        report = build_report(args.cycle_id or args.job.name, baseline)
    else:
        manifest_path = args.manifest.resolve()
        base = manifest_path.parent
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        taxonomy = load_taxonomy(resolve(base, manifest.get("taxonomy", "capabilities.json")))
        baseline_spec = manifest["baseline"]
        baseline = load_harbor_records(resolve(base, baseline_spec["job"]), taxonomy,
                                       variant=baseline_spec.get("name", "baseline"),
                                       max_batch=baseline_spec.get("maxBatch"))
        experiments = []
        for spec in manifest.get("experiments", []):
            experiments.append({
                **spec,
                "candidateRecords": load_harbor_records(
                    resolve(base, spec["job"]), taxonomy,
                    variant=spec.get("name", spec.get("hypothesisId", "candidate")),
                    max_batch=spec.get("maxBatch"),
                ),
            })
        report = build_report(
            manifest.get("cycleId", manifest_path.stem), baseline, experiments,
            policy=manifest.get("policy"),
            llm_analyze=responses_analyst(manifest.get("llm", {})) if args.llm else None,
        )
    write_outputs(args.output_dir.resolve(), report)
    print(f"Equaxis Harbor evaluation report written to {args.output_dir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
