"""Shared policy and record vocabulary for evaluation adapters."""

from __future__ import annotations

from typing import Any, TypedDict

DEFAULT_POLICY: dict[str, float | int] = {
    "expected_success_rate": 0.8,
    "weak_capability_gap": 0.1,
    "diagnostic_minimum_samples": 2,
    "experiment_minimum_samples": 5,
    "target_uplift_floor": 0.05,
    "target_uplift_ceiling": 0.2,
    "regression_tolerance": 0.03,
    "max_latency_increase_rate": 0.2,
    "max_token_increase_rate": 0.2,
    "max_cost_increase_rate": 0.15,
    "max_safety_violation_increase": 0.0,
    "max_infrastructure_failure_increase": 0.0,
}

INFRASTRUCTURE_FAILURES = {
    "AGENT_SETUP_NETWORK_FAILED",
    "AGENT_SETUP_FAILED",
    "VERIFIER_ERROR",
    "VERIFIER_RESULT_MISSING",
}


class EvaluationRecord(TypedDict, total=False):
    taskId: str
    trialId: str
    attempt: int
    variant: str
    taskArea: str
    capabilityTags: list[str]
    expectedSuccessRate: float
    success: bool
    score: float
    failureCode: str | None
    safetyViolation: bool
    safetyEvaluated: bool
    latencyMs: float | None
    costUsd: float | None
    inputTokens: int
    outputTokens: int
    totalTokens: int
    trace: dict[str, Any]
    resultPath: str
