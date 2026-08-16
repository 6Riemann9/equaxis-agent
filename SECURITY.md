# Security Policy

Equaxis is an engineering harness around Pi — it is **not** an OS-level sandbox. High-risk
actions are governed by deterministic policy and human approval, but the harness runs with
the host's permissions.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Report privately so the issue can be
fixed before it is disclosed.

- Preferred: GitHub **private vulnerability reporting** — *Security → Report a vulnerability*
  on the repository (https://github.com/6Riemann9/equaxis-agent/security/advisories).
- Alternative: open a draft issue titled `[SECURITY]` (visible only to maintainers until
  published).

Please include:

- The affected version and environment (OS, Node/Python versions, config).
- A minimal reproduction — commands, config snippets, and (if relevant) trace lines.
- Impact assessment and, if you have one, a suggested fix.

## What is in scope

- Governance bypasses: policy classification gaps (e.g. commands that slip past the
  allowlist / risk tiers), approval-queue tampering, audit-trail forgery.
- Protect-path escapes: writes or reads that reach `.env`, key files, or paths outside the
  workspace that the policy should have blocked.
- Secret handling: credentials leaking into memory, traces, or checkpoints.
- Subagent isolation escapes: env scrubbing gaps, worktree sandbox escapes, artifact path
  traversal.

## What is out of scope

- Vulnerabilities inside the pinned Pi kernel (`@earendil-works/pi-coding-agent`), the
  vendored Python memory core, or pi-web — report them upstream.
- The absence of OS-level sandboxing itself (documented in the README).

## Process

1. Maintainers triage within 7 days and confirm receipt.
2. A fix is prepared, tested against the three verification suites, and released.
3. The advisory is published after the fix lands; disclosure timing is coordinated with the
   reporter.
