## What & why

<!-- What does this PR change, and why? Link the issue it closes (if any). -->

Closes #

## Changes

<!-- Bullet list of the actual changes; reference files/functions when useful. -->

-

## Verification

<!-- Check what you actually ran. CI runs the same suites on ubuntu + windows. -->

- [ ] `node --test "tests/*.test.mjs"` passes
- [ ] `python -m pytest tests/ -q` passes (in `vendor/agent-memory`)
- [ ] `npx tsc --noEmit` clean
- [ ] `npm run doctor` stays READY
- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, ...)

## Notes

<!-- Anything reviewers should know: design tradeoffs, follow-up work, behavior changes. -->
