"""Deterministic Harbor-to-Equaxis evaluation and improvement cycle."""

from __future__ import annotations

import json
import math
import re
import statistics
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from .schema import DEFAULT_POLICY, INFRASTRUCTURE_FAILURES


def rounded(value: float | None, digits: int = 4) -> float | None:
    return None if value is None or not math.isfinite(value) else round(value, digits)


def mean(values: list[float | int | None]) -> float | None:
    usable = [float(value) for value in values if value is not None and math.isfinite(float(value))]
    return statistics.mean(usable) if usable else None


def relative_change(candidate: float | None, baseline: float | None) -> float | None:
    if candidate is None or baseline is None or baseline == 0:
        return 0.0 if candidate == baseline == 0 else None
    return rounded((candidate - baseline) / baseline)


def parse_timestamp(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def elapsed_ms(start: str | None, finish: str | None) -> float | None:
    left, right = parse_timestamp(start), parse_timestamp(finish)
    return rounded((right - left).total_seconds() * 1000, 2) if left and right else None


def load_taxonomy(path: Path) -> dict[str, dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    tasks = data.get("tasks") if isinstance(data, dict) else None
    if not isinstance(tasks, dict):
        raise ValueError(f"{path} must contain an object named 'tasks'")
    return tasks


def _result_paths(job: Path) -> list[Path]:
    paths = list(job.glob("*/result.json"))
    if job.name in {"equaxis", "pi-control"}:
        paths = list(job.parent.glob(f"budget-v2-{job.name}-*/**/result.json"))
    elif not paths:
        paths = list(job.glob("budget*/**/result.json"))
    return sorted(set(paths))


def _read_jsonl_events(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    events = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if not line.strip():
            continue
        try:
            item = json.loads(line)
            if isinstance(item, dict):
                events.append(item)
        except json.JSONDecodeError:
            # A corrupt trace line is evidence loss, not a reason to discard a valid Harbor result.
            events.append({"event": "TRACE_PARSE_ERROR", "line": line_number})
    return events


def _trace_summary(trial_dir: Path) -> dict[str, Any]:
    events = _read_jsonl_events(trial_dir / "agent" / "equaxis-harness-traces.jsonl")
    tool_errors = [event for event in events if event.get("event") == "tool_result" and event.get("isError")]
    validation = [event for event in events if event.get("event") == "tool_validation_failed"]
    blocked = [event for event in events if event.get("event") == "tool_blocked"]
    parse_errors = [event for event in events if event.get("event") == "TRACE_PARSE_ERROR"]
    return {
        "toolErrors": len(tool_errors),
        "failedTools": dict(Counter(str(event.get("toolName", "unknown")) for event in tool_errors)),
        "validationFailures": len(validation),
        "repairExhausted": any(event.get("repairAllowed") is False for event in validation),
        "blockedCalls": len(blocked),
        "traceParseErrors": len(parse_errors),
    }


def _exception_failure_code(exception: dict[str, Any]) -> str:
    kind = str(exception.get("exception_type") or "").upper()
    message = str(exception.get("exception_message") or "").upper()
    combined = f"{kind} {message}"
    if "TIMEOUT" in combined or "TIMED OUT" in combined:
        return "TASK_TIMEOUT"
    if any(token in combined for token in ("ECONNREFUSED", "ENOTFOUND", "NETWORK")):
        return "AGENT_SETUP_NETWORK_FAILED"
    if "SETUP" in combined or "INSTALL" in combined:
        return "AGENT_SETUP_FAILED"
    if "VERIFIER" in combined:
        return "VERIFIER_ERROR"
    return "AGENT_EXECUTION_ERROR"


def _failure_code(item: dict[str, Any], trace: dict[str, Any]) -> str | None:
    exception = item.get("exception_info")
    if isinstance(exception, dict):
        return _exception_failure_code(exception)
    rewards = ((item.get("verifier_result") or {}).get("rewards") or {})
    if "reward" not in rewards:
        return "VERIFIER_RESULT_MISSING"
    if "safety" in rewards and float(rewards["safety"]) < 1:
        return "SAFETY_VIOLATION"
    if float(rewards.get("reward", 0)) >= 1:
        return None
    if trace["repairExhausted"]:
        return "TOOL_ARGUMENT_REPAIR_EXHAUSTED"
    if trace["blockedCalls"]:
        return "POLICY_BLOCKED_TASK"
    if trace["toolErrors"]:
        return "TOOL_EXECUTION_FAILURE"
    return "FUNCTIONAL_VERIFIER_FAILED"


def load_harbor_records(
    job: Path,
    taxonomy: dict[str, dict[str, Any]],
    *,
    variant: str,
    max_batch: int | None = None,
) -> list[dict[str, Any]]:
    """Translate Harbor trial results and Equaxis traces into evaluation records."""
    records = []
    for result_path in _result_paths(job):
        batch_match = re.search(r"-b(\d+)", str(result_path))
        if max_batch is not None and batch_match and int(batch_match.group(1)) > max_batch:
            continue
        item = json.loads(result_path.read_text(encoding="utf-8"))
        if "task_name" not in item:
            continue
        task_id = str(item["task_name"]).split("/")[-1]
        metadata = taxonomy.get(task_id, {})
        trace = _trace_summary(result_path.parent)
        rewards = ((item.get("verifier_result") or {}).get("rewards") or {})
        reward = float(rewards.get("reward", 0)) if "reward" in rewards else 0.0
        safety_violation = "safety" in rewards and float(rewards["safety"]) < 1
        execution = item.get("agent_execution") or {}
        agent_result = item.get("agent_result") or {}
        attempt_match = re.search(r"-a(\d+)-b\d+", str(result_path))
        input_tokens = int(agent_result.get("n_input_tokens") or 0)
        output_tokens = int(agent_result.get("n_output_tokens") or 0)
        records.append({
            "taskId": task_id,
            "trialId": item.get("trial_name"),
            "attempt": int(attempt_match.group(1)) if attempt_match else 1,
            "variant": variant,
            "taskArea": metadata.get("taskArea", "unclassified"),
            "capabilityTags": metadata.get("capabilityTags", ["unlabeled"]),
            "expectedSuccessRate": float(metadata.get("expectedSuccessRate", DEFAULT_POLICY["expected_success_rate"])),
            "success": reward >= 1 and not safety_violation,
            "score": reward,
            "failureCode": _failure_code(item, trace),
            "safetyViolation": safety_violation,
            "safetyEvaluated": "safety" in rewards,
            "latencyMs": elapsed_ms(execution.get("started_at"), execution.get("finished_at")),
            "costUsd": agent_result.get("cost_usd"),
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "totalTokens": input_tokens + output_tokens,
            "trace": trace,
            "resultPath": str(result_path),
        })
    return records


def _aggregate(records: list[dict[str, Any]]) -> dict[str, Any]:
    attempts = len(records)
    successes = sum(bool(record["success"]) for record in records)
    safety = [record for record in records if record.get("safetyEvaluated")]
    return {
        "attempts": attempts,
        "successes": successes,
        "failures": attempts - successes,
        "successRate": rounded(successes / attempts) if attempts else None,
        "averageScore": rounded(mean([record.get("score") for record in records])),
        "averageLatencyMs": rounded(mean([record.get("latencyMs") for record in records]), 2),
        "averageCostUsd": rounded(mean([record.get("costUsd") for record in records]), 6),
        "averageTotalTokens": rounded(mean([record.get("totalTokens") for record in records]), 2),
        "safetyEvaluated": len(safety),
        "safetyViolationRate": rounded(mean([int(record["safetyViolation"]) for record in safety])),
    }


def _is_infrastructure_failure(record: dict[str, Any]) -> bool:
    return record.get("failureCode") in INFRASTRUCTURE_FAILURES


def _quality_aggregate(records: list[dict[str, Any]]) -> dict[str, Any]:
    eligible = [record for record in records if not _is_infrastructure_failure(record)]
    infrastructure = [record for record in records if _is_infrastructure_failure(record)]
    metrics = _aggregate(eligible)
    metrics.update({
        "rawAttempts": len(records),
        "excludedInfrastructureFailures": len(infrastructure),
        "infrastructureFailureRate": rounded(len(infrastructure) / len(records)) if records else None,
    })
    return metrics


def _groups(records: list[dict[str, Any]], key: Callable[[dict[str, Any]], str]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        grouped[key(record)].append(record)
    return grouped


def diagnose(records: list[dict[str, Any]], policy: dict[str, Any] | None = None) -> dict[str, Any]:
    rules = {**DEFAULT_POLICY, **(policy or {})}
    overall = _aggregate(records)
    infrastructure_records = [record for record in records if _is_infrastructure_failure(record)]
    quality_records = [record for record in records if not _is_infrastructure_failure(record)]
    task_table = []
    for task_id, rows in _groups(records, lambda record: record["taskId"]).items():
        metrics = _quality_aggregate(rows)
        expected = rounded(mean([record["expectedSuccessRate"] for record in rows]))
        task_table.append({
            "taskId": task_id,
            "taskArea": rows[0]["taskArea"],
            "capabilityTags": sorted(set(tag for record in rows for tag in record["capabilityTags"])),
            **metrics,
            "expectedSuccessRate": expected,
            "gapToExpected": (rounded(expected - metrics["successRate"])
                              if metrics["successRate"] is not None else None),
            "failureCodes": dict(Counter(record["failureCode"] for record in rows if not record["success"])),
        })
    task_table.sort(key=lambda row: (-(row["gapToExpected"] if row["gapToExpected"] is not None else -1), row["taskId"]))

    capabilities = sorted(set(tag for record in quality_records for tag in record["capabilityTags"]))
    areas = sorted(set(record["taskArea"] for record in quality_records))
    matrix = []
    for capability in capabilities:
        rows = [record for record in quality_records if capability in record["capabilityTags"]]
        metrics = _quality_aggregate(rows)
        expected = rounded(mean([record["expectedSuccessRate"] for record in rows]))
        matrix.append({
            "capability": capability,
            **metrics,
            "expectedSuccessRate": expected,
            "gapToExpected": rounded(expected - metrics["successRate"]),
            "areas": {area: _quality_aggregate([record for record in rows if record["taskArea"] == area])
                      for area in areas if any(record["taskArea"] == area for record in rows)},
        })
    weak = [row for row in matrix if (
        row["attempts"] >= rules["diagnostic_minimum_samples"]
        and row["gapToExpected"] >= rules["weak_capability_gap"]
    )]
    weak.sort(key=lambda row: (-row["gapToExpected"], -row["failures"], row["capability"]))

    failure_regions = []
    quality_failures = sum(not record["success"] for record in quality_records)
    for area, rows in _groups(quality_records, lambda record: record["taskArea"]).items():
        metrics = _quality_aggregate(rows)
        if not metrics["failures"]:
            continue
        failed = [record for record in rows if not record["success"]]
        failure_regions.append({
            "taskArea": area,
            **metrics,
            "failureShare": rounded(metrics["failures"] / quality_failures) if quality_failures else 0,
            "failureCodes": dict(Counter(record["failureCode"] for record in failed)),
            "capabilities": dict(Counter(tag for record in failed for tag in record["capabilityTags"])),
        })
    failure_regions.sort(key=lambda row: (-row["failures"], row["successRate"]))
    return {
        "policy": rules,
        "overall": overall,
        "taskQuality": _quality_aggregate(records),
        "infrastructure": {
            "failures": len(infrastructure_records),
            "failureRate": rounded(len(infrastructure_records) / len(records)) if records else None,
            "failureCodes": dict(Counter(record["failureCode"] for record in infrastructure_records)),
            "affectedTasks": sorted(set(record["taskId"] for record in infrastructure_records)),
        },
        "taskTable": task_table,
        "capabilityMatrix": matrix,
        "weakCapabilities": weak,
        "failureRegions": failure_regions,
    }


def _layer(failure_codes: dict[str, int]) -> str:
    text = " ".join(failure_codes).upper()
    if re.search(r"PROMPT|INSTRUCTION|TOOL_(SELECT|DISCOVER|DESCRIPTION)|ARGUMENT|SCHEMA", text):
        return "surface"
    if re.search(r"INPUT|PARSE|RETRIEV|CONTEXT|PIPELINE|PLAN|REASON|LOOP|TIMEOUT|TOOL_EXECUTION", text):
        return "middle"
    return "deep"


LAYER_DETAILS = {
    "surface": (1, "Refine prompts, tool descriptions or argument guidance for this capability.",
                "Fixed-seed A/B run with identical model, tools, task inputs and budgets."),
    "middle": (2, "Change the input/context pipeline or selectively switch reasoning mode.",
               "Tagged A/B run measuring target uplift plus latency, token, cost and unrelated-tag regressions."),
    "deep": (3, "Evaluate a scoped model, planner or harness-core capability change.",
             "Larger canary after cheaper hypotheses fail, with explicit rollback gates."),
}


def build_hypotheses(diagnosis: dict[str, Any], policy: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    rules = {**DEFAULT_POLICY, **diagnosis.get("policy", {}), **(policy or {})}
    candidates = diagnosis["weakCapabilities"] or sorted(
        (row for row in diagnosis["capabilityMatrix"] if row["failures"]),
        key=lambda row: (row["successRate"], -row["failures"]),
    )[:3]
    hypotheses = []
    for index, capability in enumerate(candidates, 1):
        tasks = [row for row in diagnosis["taskTable"] if capability["capability"] in row["capabilityTags"]]
        failures = Counter()
        for task in tasks:
            failures.update(task["failureCodes"])
        layer = _layer(dict(failures))
        phase, change, validation = LAYER_DETAILS[layer]
        uplift = min(
            rules["target_uplift_ceiling"],
            max(rules["target_uplift_floor"], max(0, capability["gapToExpected"]) * 0.5),
        )
        slug = re.sub(r"[^a-z0-9]+", "-", capability["capability"].lower()).strip("-")
        hypotheses.append({
            "id": f"H{index}-{layer}-{slug}",
            "layer": layer,
            "phase": phase,
            "capabilityTags": [capability["capability"]],
            "taskAreas": sorted(set(task["taskArea"] for task in tasks)),
            "evidence": {
                "attempts": capability["attempts"],
                "currentSuccessRate": capability["successRate"],
                "gapToExpected": capability["gapToExpected"],
                "failureCodes": dict(failures),
            },
            "proposedChange": change,
            "expectedUplift": rounded(uplift),
            "targetSuccessRate": rounded(min(1, capability["successRate"] + uplift)),
            "validationMethod": validation,
            "primaryMetric": "successRate",
            "guardrails": ["averageLatencyMs", "averageTotalTokens", "averageCostUsd",
                           "safetyViolationRate", "unrelatedCapabilityRegression"],
        })
    return hypotheses


def _compare(
    baseline: list[dict[str, Any]],
    candidate: list[dict[str, Any]],
    predicate: Callable[[dict[str, Any]], bool] = lambda _: True,
) -> dict[str, Any]:
    left = _quality_aggregate([record for record in baseline if predicate(record)])
    right = _quality_aggregate([record for record in candidate if predicate(record)])
    return {
        "baseline": left,
        "candidate": right,
        "successRateUplift": (rounded(right["successRate"] - left["successRate"])
                              if left["successRate"] is not None and right["successRate"] is not None else None),
        "latencyChangeRate": relative_change(right["averageLatencyMs"], left["averageLatencyMs"]),
        "tokenChangeRate": relative_change(right["averageTotalTokens"], left["averageTotalTokens"]),
        "costChangeRate": relative_change(right["averageCostUsd"], left["averageCostUsd"]),
        "safetyViolationChange": (
            rounded(right["safetyViolationRate"] - left["safetyViolationRate"])
            if left["safetyViolationRate"] is not None and right["safetyViolationRate"] is not None else None
        ),
        "infrastructureFailureChange": (
            rounded(right["infrastructureFailureRate"] - left["infrastructureFailureRate"])
            if left["infrastructureFailureRate"] is not None and right["infrastructureFailureRate"] is not None else None
        ),
    }


def analyze_experiment(
    hypothesis: dict[str, Any],
    baseline: list[dict[str, Any]],
    candidate: list[dict[str, Any]],
    *,
    name: str,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rules = {**DEFAULT_POLICY, **(policy or {})}
    target_tags = hypothesis.get("capabilityTags", [])
    target_areas = hypothesis.get("taskAreas", [])

    def targeted(record: dict[str, Any]) -> bool:
        return ((not target_tags or any(tag in record["capabilityTags"] for tag in target_tags))
                and (not target_areas or record["taskArea"] in target_areas))

    capabilities = sorted(set(tag for record in baseline + candidate for tag in record["capabilityTags"]))
    by_capability = [{
        "capability": capability,
        **_compare(baseline, candidate, lambda record, tag=capability: tag in record["capabilityTags"]),
    } for capability in capabilities]
    regressions = [{
        "capability": row["capability"],
        "uplift": row["successRateUplift"],
        "baselineAttempts": row["baseline"]["attempts"],
        "candidateAttempts": row["candidate"]["attempts"],
    } for row in by_capability if (
        row["capability"] not in target_tags
        and row["successRateUplift"] is not None
        and row["successRateUplift"] < -rules["regression_tolerance"]
    )]
    failure_codes = sorted(set(record["failureCode"] for record in baseline + candidate if record["failureCode"]))
    areas = sorted(set(record["taskArea"] for record in baseline + candidate))
    primary = _compare(baseline, candidate, targeted)
    paired_tasks = set(record["taskId"] for record in baseline) & set(record["taskId"] for record in candidate)
    return {
        "name": name,
        "hypothesisId": hypothesis["id"],
        "phase": hypothesis.get("phase"),
        "targetCapabilities": target_tags,
        "targetAreas": target_areas,
        "coverage": {
            "pairedTasks": len(paired_tasks),
            "baselineOnly": sorted(set(record["taskId"] for record in baseline) - paired_tasks),
            "candidateOnly": sorted(set(record["taskId"] for record in candidate) - paired_tasks),
        },
        "primary": primary,
        "byCapability": by_capability,
        "failurePatterns": {
            "byCode": sorted([{
                "failureCode": code,
                "baselineCount": sum(record["failureCode"] == code for record in baseline),
                "candidateCount": sum(record["failureCode"] == code for record in candidate),
                "countDelta": (sum(record["failureCode"] == code for record in candidate)
                               - sum(record["failureCode"] == code for record in baseline)),
            } for code in failure_codes], key=lambda row: -abs(row["countDelta"])),
            "byArea": [{
                "taskArea": area,
                **_compare(baseline, candidate, lambda record, value=area: record["taskArea"] == value),
            } for area in areas],
        },
        "sideEffects": {
            "unrelatedCapabilityRegressions": regressions,
            "latencyChangeRate": primary["latencyChangeRate"],
            "tokenChangeRate": primary["tokenChangeRate"],
            "costChangeRate": primary["costChangeRate"],
            "safetyViolationChange": primary["safetyViolationChange"],
            "infrastructureFailureChange": primary["infrastructureFailureChange"],
        },
    }


def decide(experiment: dict[str, Any], hypothesis: dict[str, Any], policy: dict[str, Any] | None = None) -> dict[str, Any]:
    rules = {**DEFAULT_POLICY, **(policy or {})}
    primary = experiment["primary"]
    if (primary["baseline"]["attempts"] < rules["experiment_minimum_samples"]
            or primary["candidate"]["attempts"] < rules["experiment_minimum_samples"]):
        return {"hypothesisId": hypothesis["id"], "decision": "insufficient_data",
                "reason": "Not enough samples in both experiment arms."}
    uplift = primary["successRateUplift"]
    expected = hypothesis.get("expectedUplift", rules["target_uplift_floor"])
    constraints = {
        "hasRegression": bool(experiment["sideEffects"]["unrelatedCapabilityRegressions"]),
        "latencyExpensive": primary["latencyChangeRate"] is not None
                            and primary["latencyChangeRate"] > rules["max_latency_increase_rate"],
        "tokenExpensive": primary["tokenChangeRate"] is not None
                          and primary["tokenChangeRate"] > rules["max_token_increase_rate"],
        "costExpensive": primary["costChangeRate"] is not None
                         and primary["costChangeRate"] > rules["max_cost_increase_rate"],
        "safetyRegression": primary["safetyViolationChange"] is not None
                            and primary["safetyViolationChange"] > rules["max_safety_violation_increase"],
        "infrastructureRegression": primary["infrastructureFailureChange"] is not None
                                    and primary["infrastructureFailureChange"] > rules["max_infrastructure_failure_increase"],
    }
    meets_target = uplift is not None and uplift >= expected
    practical = uplift is not None and uplift >= rules["target_uplift_floor"]
    constrained = any(constraints.values())
    decision_value = "deploy" if meets_target and not constrained else "scoped" if practical else "reject"
    overhead = 1 + max(0, primary["latencyChangeRate"] or 0) + max(0, primary["tokenChangeRate"] or 0) + max(0, primary["costChangeRate"] or 0)
    return {
        "hypothesisId": hypothesis["id"],
        "decision": decision_value,
        "meetsTarget": meets_target,
        "expectedUplift": expected,
        "observedUplift": uplift,
        "costBenefitScore": rounded(max(0, uplift or 0) / overhead),
        "constraints": constraints,
        "reason": (
            "Target uplift met without exceeding side-effect guardrails." if decision_value == "deploy"
            else "Useful uplift observed, but rollout must be limited by target, cost or regression constraints."
            if decision_value == "scoped" else "Observed uplift did not reach the minimum practical threshold."
        ),
    }


def llm_prompt(report: dict[str, Any]) -> str:
    evidence = {
        "cycleId": report["cycleId"],
        "overall": report["diagnosis"]["overall"],
        "taskQuality": report["diagnosis"]["taskQuality"],
        "infrastructure": report["diagnosis"]["infrastructure"],
        "weakCapabilities": report["diagnosis"]["weakCapabilities"],
        "failureRegions": report["diagnosis"]["failureRegions"][:10],
        "hypotheses": report["hypotheses"],
        "experiments": report["experiments"],
        "decisions": report["decisions"],
    }
    return ("Analyze this Equaxis Harbor evaluation cycle using only the supplied evidence. "
            "Describe changed failure patterns, likely root capabilities, trade-offs, and the next three experiments. "
            "Do not override deterministic deployment decisions. Return concise Markdown.\n\n"
            + json.dumps(evidence, ensure_ascii=False, indent=2))


def build_report(
    cycle_id: str,
    baseline: list[dict[str, Any]],
    experiments: list[dict[str, Any]] | None = None,
    *,
    policy: dict[str, Any] | None = None,
    llm_analyze: Callable[[str], str] | None = None,
) -> dict[str, Any]:
    diagnosis = diagnose(baseline, policy)
    hypotheses = build_hypotheses(diagnosis, policy)
    by_id = {hypothesis["id"]: hypothesis for hypothesis in hypotheses}
    analyzed, decisions = [], []
    for spec in experiments or []:
        hypothesis = spec.get("hypothesis") or by_id.get(spec.get("hypothesisId"))
        if not hypothesis:
            raise ValueError(f"Unknown hypothesis for experiment {spec.get('name', 'unnamed')}")
        result = analyze_experiment(hypothesis, baseline, spec["candidateRecords"],
                                    name=spec.get("name", hypothesis["id"]), policy=policy)
        analyzed.append(result)
        decisions.append(decide(result, hypothesis, policy))
    report = {
        "schemaVersion": 1,
        "cycleId": cycle_id,
        "generatedAt": datetime.now().astimezone().isoformat(),
        "diagnosis": diagnosis,
        "hypotheses": hypotheses,
        "experiments": analyzed,
        "decisions": decisions,
        "nextIterationFocus": [{
            "taskArea": region["taskArea"],
            "failureShare": region["failureShare"],
            "leadingFailureCodes": list(region["failureCodes"])[:3],
        } for region in diagnosis["failureRegions"][:3]],
    }
    if llm_analyze:
        report["llmAnalysis"] = llm_analyze(llm_prompt(report))
    return report


def render_markdown(report: dict[str, Any]) -> str:
    diagnosis = report["diagnosis"]
    lines = [
        f"# Equaxis Harbor Evaluation: {report['cycleId']}", "",
        f"Generated: {report['generatedAt']}", "",
        "## Baseline diagnosis", "",
        f"- Attempts: {diagnosis['overall']['attempts']}",
        f"- Observed success rate: {diagnosis['overall']['successRate']}",
        f"- Task-quality success rate: {diagnosis['taskQuality']['successRate']}",
        f"- Excluded infrastructure failures: {diagnosis['infrastructure']['failures']}",
        f"- Average latency: {diagnosis['overall']['averageLatencyMs']} ms",
        f"- Average total tokens: {diagnosis['overall']['averageTotalTokens']}", "",
        "## Per-task results", "",
        "| Task | Area | Capabilities | Attempts | Success | Expected | Gap | Failure codes |",
        "|---|---|---|---:|---:|---:|---:|---|",
    ]
    lines.extend(
        f"| {row['taskId']} | {row['taskArea']} | {', '.join(row['capabilityTags'])} | {row['attempts']} | "
        f"{row['successRate']} | {row['expectedSuccessRate']} | {row['gapToExpected']} | {', '.join(row['failureCodes'])} |"
        for row in diagnosis["taskTable"]
    )
    lines += ["", "## Capability matrix", "",
              "| Capability | Attempts | Success | Expected | Gap | Area success rates |",
              "|---|---:|---:|---:|---:|---|"]
    for row in diagnosis["capabilityMatrix"]:
        areas = "; ".join(f"{area}: {value['successRate']}" for area, value in row["areas"].items() if value["attempts"])
        lines.append(f"| {row['capability']} | {row['attempts']} | {row['successRate']} | "
                     f"{row['expectedSuccessRate']} | {row['gapToExpected']} | {areas} |")
    lines += ["", "## Failure regions", "", "| Area | Failures | Share | Leading codes |",
              "|---|---:|---:|---|"]
    lines.extend(f"| {row['taskArea']} | {row['failures']} | {row['failureShare']} | {', '.join(list(row['failureCodes'])[:3])} |"
                 for row in diagnosis["failureRegions"])
    lines += ["", "## Improvement hypotheses", "",
              "| ID | Layer | Phase | Capability | Target uplift | Validation |",
              "|---|---|---:|---|---:|---|"]
    lines.extend(f"| {item['id']} | {item['layer']} | {item['phase']} | {', '.join(item['capabilityTags'])} | "
                 f"{item['expectedUplift']} | {item['validationMethod']} |" for item in report["hypotheses"])
    lines += ["", "## Deployment decisions", "",
              "| Hypothesis | Decision | Uplift | Cost-benefit | Reason |",
              "|---|---|---:|---:|---|"]
    lines.extend(f"| {item['hypothesisId']} | {item['decision']} | {item.get('observedUplift', 'n/a')} | "
                 f"{item.get('costBenefitScore', 'n/a')} | {item['reason']} |" for item in report["decisions"])
    if report.get("llmAnalysis"):
        lines += ["", "## LLM analysis", "", str(report["llmAnalysis"])]
    return "\n".join(lines) + "\n"
