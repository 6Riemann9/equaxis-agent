# Contributing to Equaxis

Thanks for considering a contribution. Equaxis is a governed agent runtime on top of
[Pi](https://pi.dev/) — the governance, memory, subagent and evaluation extensions in this
repository are the product, so keep the guardrails honest: changes must never weaken the
deterministic policy layer, the audit trail, or the no-replay boundaries.

## Getting started

```powershell
git clone https://github.com/6Riemann9/equaxis-agent.git
cd equaxis-agent
npm install
npm run setup          # toolchain check + python memory core + doctor
```

## Project layout

| Path | What lives there |
|---|---|
| `src/` | Runtime modules (policy, config, memory core, subagent runtime, …) — plain Node ESM (`.mjs`) |
| `.pi/extensions/` | Pi extensions in TypeScript (`.ts`), registered in `.pi/extensions/contracts.json` |
| `scripts/` | CLI entry (`equaxis.mjs`), setup, wake probe |
| `tests/` | Node test suite (`tests/*.test.mjs`) |
| `vendor/agent-memory/` | Python memory backend (pytest suite) |
| `docs/` | Architecture, policy, memory, evaluation docs |

## Development loop

Every change must pass the three verification suites before it is pushed:

```powershell
# 1. Node suite (glob required — directory arguments don't work)
node --test "tests/*.test.mjs"

# 2. Python memory core (from vendor/agent-memory)
python -m pytest tests/ -q

# 3. TypeScript extensions
npx tsc --noEmit

# plus: doctor should stay READY
npm run doctor
```

`npm run verify:full` runs the same check + test + memory + eval suites.

Notes for contributors:

- New extensions **must** be registered in `.pi/extensions/contracts.json` or they never load.
- New config sections must be added to all six places: `DEFAULT_EQUAXIS_CONFIG`, `SECTIONS`,
  `SUB_SECTIONS`, `mergeConfig`, `validateEquaxisConfig`, and `.pi/equaxis.schema.json`.
- Platform portability: no Windows-only paths in tests, no `path.join` with absolute inputs,
  no ordering that depends on same-millisecond timestamps (see `docs/EQUAXIS_OPTIMIZATION_PLAN.md`).
- Subagents run with a no-replay retry policy: never retry an attempt whose side effects may
  already have applied.

## Commit conventions

This repository follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>
```

- `feat:` new capability · `fix:` bug fix · `docs:` documentation · `test:` tests ·
  `refactor:` behavior-preserving restructure · `perf:` · `ci:` workflow changes · `chore:`
- Breaking changes: `feat!:` / `BREAKING CHANGE:` footer (maps to the next MAJOR)
- Keep commits small and focused; one logical change per commit, with a body that says *why*
  when the title alone cannot.
- PR titles follow the same convention — CI enforces them.

## Pull requests

1. Branch from `main`, keep the PR small and focused. For large or controversial changes,
   open an issue first to discuss before building.
2. Use a **draft pull request** for work in progress — it still runs CI but does not request
   review until you mark it ready.
3. Fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md): what & why, the change list,
   and the verification you actually ran.
4. CI (verify + PR title checks) must pass before merge.
5. Merges use squash: the PR title becomes the commit message, so make it a good
   conventional-commits title.

Review expectations: every change gets at least one other set of eyes; reviewers may request
changes, and authors are expected to follow up promptly to avoid merge debt.

## Reporting issues

- Bugs: use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) — include the
  exact reproduction, environment, and the trace lines if available.
- Security vulnerabilities: **do not open a public issue** — see [SECURITY.md](SECURITY.md).
- Questions: see [SUPPORT.md](SUPPORT.md).
