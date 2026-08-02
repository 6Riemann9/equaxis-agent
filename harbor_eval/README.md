# Equaxis Harbor Evaluation

This directory integrates Equaxis with [Harbor](https://harborframework.com/)
as a custom installed agent and provides deterministic local evaluation tasks.

Run from the repository root:

```powershell
$env:OPENAI_API_KEY = (Get-Content -Raw .equaxis/credentials/openai.key).Trim()
$env:PYTHONPATH = (Get-Location).Path
harbor run -p harbor_eval/tasks -a harbor_eval.agent:Equaxis -m openai-inprior/gpt-5.5
```

The adapter uploads only runtime source files. It never uploads `.git`, local
memory, traces, `node_modules`, or `.equaxis/credentials` into task containers.
Harbor stores job results under `jobs/`, including Equaxis JSON events and
Harness traces for each trial.

## Paired 20-task benchmark

Generate and validate the deterministic task suite before spending model tokens:

```powershell
node harbor_eval/generate_tasks.mjs
$env:PYTHONPATH = (Get-Location).Path
harbor run -p harbor_eval/benchmark-dataset/tasks -a oracle -n 4 -o harbor_eval/jobs --job-name benchmark-oracle-20 -y
```

Run Equaxis and raw Pi with three requested attempts under a hard 10M-token
budget. The runner uses `input + output` tokens and does not double-count cache
tokens. It reserves 250k tokens per trial before launching each five-task batch,
alternates agent order, is resumable, and stops early if the remaining budget is
not sufficient. Early stopping means the requested three-attempt matrix is not
complete and must be reported as such.

```powershell
$env:OPENAI_API_KEY = (Get-Content -Raw .equaxis/credentials/openai.key).Trim()
$env:PYTHONPATH = (Get-Location).Path
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:RICH_FORCE_TERMINAL = '0'
python harbor_eval/run_budgeted.py --budget 10000000 --attempts 3
```

`PiControl` uses the same Pi version, task images, provider, model, and `xhigh`
thinking level. It loads only the provider extension; Equaxis loads the full
runtime. This isolates the incremental effect of Equaxis as far as practical.

## Capability diagnosis and improvement cycle

The cycle analyzer reads Harbor `result.json`, verifier rewards, exceptions and
Equaxis Harness traces directly. `capabilities.json` is the explicit contract
that maps benchmark tasks to task areas, capability tags and expected success
rates.

Diagnose the existing Equaxis runs:

```powershell
npm run eval:cycle -- diagnose `
  --job harbor_eval/jobs/equaxis `
  --taxonomy harbor_eval/capabilities.json `
  --output-dir harbor_eval/reports/cycle-001 `
  --cycle-id cycle-001
```

The output directory contains:

- `cycle-report.json`: per-task table, capability matrix, failure regions,
  hypotheses, experiments and deterministic deployment decisions.
- `cycle-report.md`: the same evidence in reviewable form.
- `hypotheses.json`: surface, middle and deep hypotheses with target uplift and
  validation method.
- `llm-analysis-prompt.txt`: a bounded evidence package for the next iteration.

Run a baseline/candidate cycle with a manifest:

```json
{
  "cycleId": "cycle-002",
  "taxonomy": "capabilities.json",
  "baseline": {"name": "baseline", "job": "jobs/equaxis"},
  "policy": {
    "experiment_minimum_samples": 20,
    "regression_tolerance": 0.03,
    "max_latency_increase_rate": 0.2,
    "max_token_increase_rate": 0.2
  },
  "experiments": [
    {
      "name": "tool-description-v2",
      "hypothesisId": "H1-surface-tool-selection",
      "job": "jobs/tool-description-v2"
    }
  ],
  "llm": {
    "endpoint": "https://api.openai.com/v1/responses",
    "model": "gpt-5.5",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

Paths are relative to the manifest. Run it with:

```powershell
npm run eval:cycle -- cycle `
  --manifest harbor_eval/cycle-002.json `
  --output-dir harbor_eval/reports/cycle-002
```

Add `--llm` to request a final model-written analysis. The API key is read only
from the configured environment variable and the request uses `store: false`.
The model explains changed failure patterns and suggests follow-up experiments;
it cannot override `deploy`, `scoped`, `reject` or `insufficient_data`, which
are computed deterministically from success, latency, token, cost, safety and
unrelated-capability regression gates.
