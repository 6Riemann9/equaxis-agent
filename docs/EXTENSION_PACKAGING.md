# Extension Interop: One Extension System, Two Entry Points

Equaxis does not define a second extension system. Extensions are **Pi extensions** — TypeScript modules exporting a factory `(pi: ExtensionAPI) => void`, loaded by Pi's own loader. Equaxis adds a *version contract registry* that governs only its own bundled extensions, never third-party ones.

```
Pi extension API (single source of truth)
        │
        ├─► Equaxis bundled extensions   (.pi/extensions/*.ts)
        │     └─ governed by contracts.json (piRange / failureMode / provides / requires)
        │
        └─► Pi ecosystem extensions      (auto-discovered, pi install, settings.json packages)
              └─ no contract needed; always loaded; never warned about
```

## Direction 1: Pi extensions install into Equaxis (no changes needed)

Pi's native install/discovery already works inside Equaxis, because the Equaxis runtime is plain Pi with extra `--extension` entries:

| Mechanism | Works in Equaxis |
|---|---|
| Auto-discovery `~/.pi/agent/extensions/` (global) | ✅ |
| Auto-discovery `.pi/extensions/` (project, after trust) | ✅ |
| `pi install npm:...` / `git:...` / local path | ✅ (writes settings.json, read at startup) |
| `settings.json` → `"packages": [...]` | ✅ |
| `pi -e <path>` quick test | ✅ |

A Pi extension without an Equaxis contract is a **first-class citizen**: it loads normally, and the contract check reports it as a `note` (visible only via `--doctor --json` or verbose output), **not** a warning. Only Equaxis' own bundled extensions are strictly checked.

## Direction 2: Equaxis extensions install into plain Pi (one command)

The repository is itself a valid Pi package: `package.json` declares a `pi` manifest pointing at the bundled extensions, so the whole set (reliability harness, memory, skills, subagents, protocol/AST tools, web crawler, ...) can be installed into any Pi environment.

```bash
# From inside the repository — temporary run (no install):
pi -e .

# Or install it (git / local path / npm):
pi install git:github.com/6Riemann9/equaxis-agent
pi install /path/to/equaxis-agent        # local path
pi install npm:@equaxis/agent            # once published

# Or add to a project's settings.json:
{
  "packages": ["git:github.com/6Riemann9/equaxis-agent"]
}
```

Why this works without a rebuild:

- `package.json` → `"pi": { "extensions": ["./.pi/extensions"] }` points Pi at the extension directory.
- The published `files` list already ships `src/`, `bridge/`, `vendor/agent-memory/` next to `.pi/extensions/`, so the extensions' relative imports (`../../src/...`, `../../bridge/memory_bridge.py`) resolve unchanged inside the installed package.
- Runtime dependencies (`@earendil-works/pi-coding-agent`, `typebox`) are regular `dependencies`, installed automatically by `pi install`.
- The Python memory bridge starts lazily on first memory tool use; environments without Python simply get memory tools that report the bridge is unavailable instead of failing the whole runtime.

In plain Pi there is no profile filter, so the full extension set loads — equivalent to Equaxis' `full` profile. Use Pi's [package filtering](https://pi.dev/packages) (object form in settings.json) to load a subset.

## What stays Equaxis-only

Equaxis-specific *concepts* — contracts, profiles, the CLI wrapper (`npm run equaxis`), doctor/preflight checks — remain Equaxis's own engineering layer. They are optional: a plain Pi install of the package gets every extension without any of the Equaxis CLI ceremony.

## Contract check semantics (updated)

| Loaded extension | Report entry | Blocks startup |
|---|---|---|
| Equaxis bundled, contract satisfied | — | no |
| Equaxis bundled, contract violated | `error` / `warning` per `failureMode` | yes (fatal) / no (degrade) |
| Third-party Pi extension (no contract) | `note` only | no |
| Third-party Pi extension failed to load | `note` only | no |

See [Extension Compatibility](EXTENSION_COMPATIBILITY.md) for the upgrade procedure and failure semantics of the contract registry itself.
