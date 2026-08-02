from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from harbor_eval.evaluation_cycle import (
    analyze_experiment,
    build_hypotheses,
    build_report,
    decide,
    diagnose,
    load_harbor_records,
    render_markdown,
)


def record(task: str, success: bool, tags: list[str], area: str = "navigation", **extra) -> dict:
    return {
        "taskId": task,
        "trialId": f"{task}-trial",
        "attempt": 1,
        "variant": "baseline",
        "taskArea": area,
        "capabilityTags": tags,
        "expectedSuccessRate": 0.8,
        "success": success,
        "score": int(success),
        "failureCode": None if success else "TOOL_SELECTION_FAILED",
        "safetyViolation": False,
        "safetyEvaluated": True,
        "latencyMs": extra.get("latencyMs", 100),
        "costUsd": extra.get("costUsd", 0.01),
        "inputTokens": 80,
        "outputTokens": 20,
        "totalTokens": extra.get("totalTokens", 100),
        "trace": {},
        "resultPath": "fixture",
    }


class HarborAdapterTests(unittest.TestCase):
    def test_loads_harbor_result_and_uses_trace_for_failure_code(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory) / "job"
            trial = job / "search__abc"
            (trial / "agent").mkdir(parents=True)
            result = {
                "task_name": "equaxis/search",
                "trial_name": "search__abc",
                "agent_result": {"n_input_tokens": 80, "n_output_tokens": 20},
                "agent_execution": {"started_at": "2026-01-01T00:00:00Z", "finished_at": "2026-01-01T00:00:01Z"},
                "verifier_result": {"rewards": {"reward": 0, "safety": 1}},
                "exception_info": None,
            }
            (trial / "result.json").write_text(json.dumps(result), encoding="utf-8")
            (trial / "agent" / "equaxis-harness-traces.jsonl").write_text(
                json.dumps({"event": "tool_result", "toolName": "bash", "isError": True}) + "\n",
                encoding="utf-8",
            )
            records = load_harbor_records(job, {"search": {
                "taskArea": "repository-navigation", "capabilityTags": ["tool-selection"],
                "expectedSuccessRate": 0.8,
            }}, variant="baseline")
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["failureCode"], "TOOL_EXECUTION_FAILURE")
            self.assertEqual(records[0]["totalTokens"], 100)
            self.assertEqual(records[0]["latencyMs"], 1000)

    def test_classifies_setup_network_failures_before_verifier_failures(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory) / "job"
            trial = job / "task__abc"
            trial.mkdir(parents=True)
            (trial / "result.json").write_text(json.dumps({
                "task_name": "equaxis/task", "trial_name": "task__abc",
                "agent_result": None, "verifier_result": None,
                "exception_info": {"exception_type": "NonZeroAgentExitCodeError",
                                   "exception_message": "npm ECONNREFUSED during install"},
            }), encoding="utf-8")
            [loaded] = load_harbor_records(job, {}, variant="baseline")
            self.assertEqual(loaded["failureCode"], "AGENT_SETUP_NETWORK_FAILED")
            diagnosis = diagnose([loaded])
            self.assertEqual(diagnosis["infrastructure"]["failures"], 1)
            self.assertEqual(diagnosis["capabilityMatrix"], [])
            self.assertIsNone(diagnosis["taskQuality"]["successRate"])


class EvaluationCycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.baseline = [record(f"search-{index}", index < 4, ["tool-selection", "evidence-gathering"])
                         for index in range(10)]
        self.baseline += [record(f"edit-{index}", index < 9, ["precise-editing"], "code-editing")
                          for index in range(10)]

    def test_builds_task_matrix_failure_regions_and_layered_hypotheses(self) -> None:
        diagnosis = diagnose(self.baseline)
        self.assertEqual(diagnosis["overall"]["successRate"], 0.65)
        self.assertEqual(diagnosis["failureRegions"][0]["taskArea"], "navigation")
        hypotheses = build_hypotheses(diagnosis)
        self.assertEqual(hypotheses[0]["layer"], "surface")
        self.assertEqual(hypotheses[0]["phase"], 1)
        self.assertEqual(hypotheses[0]["expectedUplift"], 0.2)

    def test_compares_capabilities_and_deploys_only_without_side_effects(self) -> None:
        hypothesis = next(item for item in build_hypotheses(diagnose(self.baseline))
                          if item["capabilityTags"] == ["tool-selection"])
        candidate = [record(f"search-{index}", index < 8, ["tool-selection", "evidence-gathering"],
                            latencyMs=105, totalTokens=105) for index in range(10)]
        candidate += self.baseline[10:]
        experiment = analyze_experiment(hypothesis, self.baseline, candidate, name="prompt-v2")
        decision = decide(experiment, hypothesis)
        self.assertEqual(experiment["primary"]["successRateUplift"], 0.4)
        self.assertEqual(decision["decision"], "deploy")
        self.assertEqual(experiment["failurePatterns"]["byCode"][0]["countDelta"], -4)

        regressed = candidate[:10] + [record(f"edit-{index}", index < 5, ["precise-editing"], "code-editing")
                                      for index in range(10)]
        scoped = analyze_experiment(hypothesis, self.baseline, regressed, name="prompt-v2")
        self.assertEqual(decide(scoped, hypothesis)["decision"], "scoped")

    def test_report_supports_llm_analysis_without_delegating_decisions(self) -> None:
        report = build_report("cycle-1", self.baseline, llm_analyze=lambda prompt: "Next experiment")
        self.assertEqual(report["llmAnalysis"], "Next experiment")
        markdown = render_markdown(report)
        self.assertIn("## Per-task results", markdown)
        self.assertIn("## Capability matrix", markdown)


if __name__ == "__main__":
    unittest.main()
