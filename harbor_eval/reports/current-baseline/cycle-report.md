# Equaxis Harbor Evaluation: current-baseline

Generated: 2026-08-01T00:03:05.340108+08:00

## Baseline diagnosis

- Attempts: 15
- Observed success rate: 0.8667
- Task-quality success rate: 0.9286
- Excluded infrastructure failures: 1
- Average latency: 142328.55 ms
- Average total tokens: 99742.47

## Per-task results

| Task | Area | Capabilities | Attempts | Success | Expected | Gap | Failure codes |
|---|---|---|---:|---:|---:|---:|---|
| mask-email | input-validation | input-validation, string-transformation | 1 | 0.0 | 0.85 | 0.85 | TOOL_EXECUTION_FAILURE |
| atomic-write | filesystem-runtime | atomicity, filesystem-safety | 1 | 1.0 | 0.85 | -0.15 |  |
| env-boolean | input-validation | boolean-parsing, input-validation | 1 | 1.0 | 0.85 | -0.15 |  |
| normalize-path | filesystem-runtime | boundary-handling, path-reasoning | 1 | 1.0 | 0.85 | -0.15 |  |
| bounded-concurrency | async-and-concurrency | async-control, bounded-concurrency | 1 | 1.0 | 0.8 | -0.2 |  |
| csv-quotes | parsing-and-ordering | state-machine-reasoning, string-parsing | 1 | 1.0 | 0.8 | -0.2 |  |
| dedupe-stable | data-transformation | collection-transform, order-preservation | 1 | 1.0 | 0.8 | -0.2 |  |
| deep-freeze | data-transformation | immutability, recursive-reasoning | 1 | 1.0 | 0.8 | -0.2 |  |
| dependency-order | algorithmic-reasoning | cycle-detection, dependency-reasoning | 1 | 1.0 | 0.8 | -0.2 |  |
| flatten-record | data-transformation | object-traversal, structured-data-navigation | 1 | 1.0 | 0.8 | -0.2 |  |
| group-counts | data-transformation | aggregation, collection-transform | 1 | 1.0 | 0.8 | -0.2 |  |
| json-pointer | parsing-and-ordering | protocol-parsing, structured-data-navigation | 1 | 1.0 | 0.8 | -0.2 |  |
| merge-intervals | algorithmic-reasoning | interval-reasoning, numeric-reasoning | 1 | 1.0 | 0.8 | -0.2 |  |
| parse-duration | input-validation | input-validation, unit-conversion | 1 | 1.0 | 0.8 | -0.2 |  |
| paginate | input-validation | boundary-handling, pagination | 0 | None | 0.85 | None | AGENT_SETUP_NETWORK_FAILED |

## Capability matrix

| Capability | Attempts | Success | Expected | Gap | Area success rates |
|---|---:|---:|---:|---:|---|
| aggregation | 1 | 1.0 | 0.8 | -0.2 | data-transformation: 1.0 |
| async-control | 1 | 1.0 | 0.8 | -0.2 | async-and-concurrency: 1.0 |
| atomicity | 1 | 1.0 | 0.85 | -0.15 | filesystem-runtime: 1.0 |
| boolean-parsing | 1 | 1.0 | 0.85 | -0.15 | input-validation: 1.0 |
| boundary-handling | 1 | 1.0 | 0.85 | -0.15 | filesystem-runtime: 1.0 |
| bounded-concurrency | 1 | 1.0 | 0.8 | -0.2 | async-and-concurrency: 1.0 |
| collection-transform | 2 | 1.0 | 0.8 | -0.2 | data-transformation: 1.0 |
| cycle-detection | 1 | 1.0 | 0.8 | -0.2 | algorithmic-reasoning: 1.0 |
| dependency-reasoning | 1 | 1.0 | 0.8 | -0.2 | algorithmic-reasoning: 1.0 |
| filesystem-safety | 1 | 1.0 | 0.85 | -0.15 | filesystem-runtime: 1.0 |
| immutability | 1 | 1.0 | 0.8 | -0.2 | data-transformation: 1.0 |
| input-validation | 3 | 0.6667 | 0.8333 | 0.1666 | input-validation: 0.6667 |
| interval-reasoning | 1 | 1.0 | 0.8 | -0.2 | algorithmic-reasoning: 1.0 |
| numeric-reasoning | 1 | 1.0 | 0.8 | -0.2 | algorithmic-reasoning: 1.0 |
| object-traversal | 1 | 1.0 | 0.8 | -0.2 | data-transformation: 1.0 |
| order-preservation | 1 | 1.0 | 0.8 | -0.2 | data-transformation: 1.0 |
| path-reasoning | 1 | 1.0 | 0.85 | -0.15 | filesystem-runtime: 1.0 |
| protocol-parsing | 1 | 1.0 | 0.8 | -0.2 | parsing-and-ordering: 1.0 |
| recursive-reasoning | 1 | 1.0 | 0.8 | -0.2 | data-transformation: 1.0 |
| state-machine-reasoning | 1 | 1.0 | 0.8 | -0.2 | parsing-and-ordering: 1.0 |
| string-parsing | 1 | 1.0 | 0.8 | -0.2 | parsing-and-ordering: 1.0 |
| string-transformation | 1 | 0.0 | 0.85 | 0.85 | input-validation: 0.0 |
| structured-data-navigation | 2 | 1.0 | 0.8 | -0.2 | data-transformation: 1.0; parsing-and-ordering: 1.0 |
| unit-conversion | 1 | 1.0 | 0.8 | -0.2 | input-validation: 1.0 |

## Failure regions

| Area | Failures | Share | Leading codes |
|---|---:|---:|---|
| input-validation | 1 | 1.0 | TOOL_EXECUTION_FAILURE |

## Improvement hypotheses

| ID | Layer | Phase | Capability | Target uplift | Validation |
|---|---|---:|---|---:|---|
| H1-middle-input-validation | middle | 2 | input-validation | 0.0833 | Tagged A/B run measuring target uplift plus latency, token, cost and unrelated-tag regressions. |

## Deployment decisions

| Hypothesis | Decision | Uplift | Cost-benefit | Reason |
|---|---|---:|---:|---|
