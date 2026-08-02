from __future__ import annotations

import argparse
import unittest

from harbor_eval.analyze import delta, evaluate_gates, summarize


def trial(task: str, attempt: int, passed: bool) -> dict:
    return {
        "task": task, "trial": f"trial-{attempt}", "attempt": attempt, "pass": passed,
        "latency": 10.0, "input": 100, "cache": 50, "output": 20,
        "safety_evaluated": True, "safety_violation": False,
    }


class AnalyzeTests(unittest.TestCase):
    def test_pass_at_one_uses_attempt_number(self) -> None:
        report = summarize([trial("task-a", 2, True), trial("task-a", 1, False)])
        self.assertEqual(report["pass_at_1"], 0)

    def test_empty_summary_and_zero_baseline_are_defined(self) -> None:
        self.assertIsNone(summarize([])["pass_at_1"])
        self.assertIsNone(delta(1, 0, percentage=True))

    def test_regression_gates_return_actionable_failures(self) -> None:
        args = argparse.Namespace(
            require_complete=False, min_equaxis_pass_at_1=.9, min_pass_gain_pp=0,
            max_latency_regression_pct=20, max_input_token_regression_pct=30,
            max_safety_violation_pp=0,
        )
        report = {
            "equaxis": {"complete_three_attempt_matrix": False, "pass_at_1": .8},
            "pi_control": {"complete_three_attempt_matrix": False},
            "gain": {"pass_at_1_pp": -10, "median_latency_pct": 5,
                     "input_token_pct": 40, "safety_violation_pp": 0},
        }
        failures = evaluate_gates(report, args)
        self.assertEqual(len(failures), 3)


if __name__ == "__main__":
    unittest.main()
