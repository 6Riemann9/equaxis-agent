# Extension Compatibility

Equaxis uses a versioned contract registry to detect Pi and Extension API drift before a runtime starts.

## Contract Registry

The registry lives at `.pi/extensions/contracts.json`. Each entry declares:

- `id`: stable extension identity.
- `entry`: project-local extension file.
- `contractVersion`: version of the Equaxis capability contract.
- `piRange`: supported Pi versions for this extension.
- `failureMode`: `fatal` for core extensions or `degrade` for optional extensions.
- `requires`: capabilities that must be supplied by another contract.
- `provides`: tools, commands, flags, events, providers, or logical core capabilities.

Events are shareable. Tools, Providers, and logical capabilities are exclusive and cannot be declared by two contracts.

## Checks

`src/extension-compat.mjs` performs four classes of checks:

1. Manifest shape and contract schema version.
2. Installed Pi version and semantic version ranges.
3. Extension entry files and the dependency graph.
4. Actual registrations returned by Pi's `discoverAndLoadExtensions()`.

The runtime entrypoint runs the static checks before spawning Pi. The integration test loads the real extensions and compares their registered tools, commands, flags, events, and Providers against the registry.

Run the operational check with:

```powershell
npm run doctor
```

For machine-readable output:

```powershell
node scripts/equaxis.mjs --doctor --json
```

A successful report includes the installed Pi version and the number of validated contracts. A failed core contract prevents the Equaxis entrypoint from starting. An optional contract is reported as a warning and may be disabled without blocking ordinary Pi work.

## Upgrade Procedure

When upgrading Pi:

1. Update `@earendil-works/pi-coding-agent` and the compatible `pi-tui` version.
2. Run `npm install` so the lockfile and installed package agree.
3. Update `piRange` only after checking the Extension API changelog and migration notes.
4. Run `npm run doctor -- --json` or `node scripts/equaxis.mjs --doctor --json`.
5. Run `npm run check` and `npm test`.
6. Inspect the capability diff if a tool, command, event, or Provider changed.
7. Keep a compatibility shim in the extension, such as `prepareArguments`, when old session data needs to be accepted.
8. Raise `contractVersion` only when the declared capability shape changes, and document the migration.

Do not widen a Pi version range just to silence a failed check. A compatibility range means the extension has been tested against that API range.

## Failure Semantics

| Failure | Result |
|---|---|
| Pi package missing or version unreadable | Startup fails with an install message |
| Core extension missing or incompatible | Startup fails closed |
| Optional extension missing or incompatible | Warning and degraded capability |
| Declared tool/Provider/command missing at load time | Contract check fails according to `failureMode` |
| Extra uncontracted extension (Pi ecosystem) | Informational `note`; loads normally via Pi's own discovery/install |
| Dependency cycle | Contract validation fails before startup |

This layer verifies compatibility and registration. It is not a sandbox and does not replace policy, approval, or runtime error handling. Contracts govern only Equaxis' bundled extensions; third-party Pi extensions are never required to register one (see [Extension Interop](EXTENSION_PACKAGING.md)).
