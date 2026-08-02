from __future__ import annotations

import unittest

from src.evaluation import DEFAULT_POLICY, build_report
from src.evaluation.decisions import decide
from src.evaluation.diagnose import diagnose
from src.evaluation.experiments import analyze_experiment
from src.evaluation.hypotheses import build_hypotheses
from src.evaluation.reports import render_markdown


def record(task: str, success: bool, tags: list[str], area: str = "navigation") -> dict:
    return {
        "taskId": task,
        "trialId": f"{task}-trial",
        "attempt": 1,
        "variant": "baseline",
        "taskArea": area,
        "capabilityTags": tags,
        "expectedSuccessRate": DEFAULT_POLICY["expected_success_rate"],
        "success": success,
        "score": int(success),
        "failureCode": None if success else "TOOL_SELECTION_FAILED",
        "safetyViolation": False,
        "safetyEvaluated": True,
        "latencyMs": 100,
        "costUsd": 0.01,
        "inputTokens": 80,
        "outputTokens": 20,
        "totalTokens": 100,
        "trace": {},
        "resultPath": "fixture",
    }


class EvaluationCoreImportTests(unittest.TestCase):
    def test_public_modules_share_the_same_cycle_contract(self) -> None:
        baseline = [record(f"search-{index}", index < 4, ["tool-selection"]) for index in range(10)]
        diagnosis = diagnose(baseline)
        hypothesis = build_hypotheses(diagnosis)[0]
        candidate = [record(f"search-{index}", index < 8, ["tool-selection"]) for index in range(10)]
        experiment = analyze_experiment(hypothesis, baseline, candidate, name="prompt-v2")
        decision = decide(experiment, hypothesis)
        report = build_report("cycle-1", baseline)

        self.assertEqual(hypothesis["layer"], "surface")
        self.assertEqual(experiment["primary"]["successRateUplift"], 0.4)
        self.assertEqual(decision["decision"], "deploy")
        self.assertIn("## Capability matrix", render_markdown(report))


if __name__ == "__main__":
    unittest.main()
