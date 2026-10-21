# Companion — persistent AI teammates

Companion is Equaxis' Grok-Bot-style product track: named AI **teammates** that
outlive any single session, each with its own **workspace**, its own **HOME**,
a shared **task queue**, an **inbox**, scheduled **routines**, and a
notification feed. The session you chat in is a *client*; the work happens in
a headless worker that runs each task as an isolated Pi subprocess.

```
you ──task/message/routine──▶ CompanionStore (.pi/companion/)
                                   │ FIFO queue + inboxes + routines
                                   ▼
                     companion worker / serve (headless)
                                   │ one Pi JSON subprocess per task
                                   ▼
        .pi/companion/workspaces/<name>/   (teammate's files, writable)
        .pi/companion/home/<name>/         (teammate's HOME, writable)
                                   │
                                   ▼
        feed.jsonl + Telegram + ntfy + notify-send  (best-effort)
```

## CLI (`npm run companion`)

```bash
companion create researcher --persona "a meticulous researcher" --model sonnet
companion list
companion task researcher "survey how config is loaded"    # queue a task
companion message researcher "prioritize the config issue" # inbox message
companion routine add researcher --every 30m "check for regressions"
companion status [--all] | feed [n] | logs <task-id> [--lines 100]
companion reset <name>                # forget the teammate's conversation
companion worker [--once] [--poll 2000] [--concurrency 2] [--context per-teammate|per-task]
                [--sandbox auto|directory|bwrap|container|off]
                [--sandbox-ceiling bwrap|container] [--image node:22-slim] [--home isolated|shared]
companion backends [--microvm-kernel k --microvm-rootfs i]
                                     # which tiers this host supports, and what auto picks
companion export <name>... [--all] [--out team.json]   # portable teammate template (no secrets)
companion import team.json [--rename name] [--overwrite] [--dry-run]
companion serve [--port 7890] [--listen 0.0.0.0] [--allow-host mybox.local:7890] [--no-pwa]
                                    # webhook ingress + worker + mobile dashboard
```

Inside a Pi session the companion extension exposes the same capabilities as
tools — `companion_create_teammate`, `companion_list_teammates`,
`companion_submit_task`, `companion_send_message`, `companion_task_status`,
`companion_logs`, `companion_artifacts`, `companion_routines`,
`companion_credentials`, `companion_approvals`, `companion_backends`,
`companion_template` — plus a `/companion` command:

```
/companion list | show <name> | status | feed [n]
/companion logs <task> [lines]        # stream log, works while running
/companion files <task> [path]        # what changed, or a file's diff
/companion routines [add <name> <30m> <instr> | remove <id>]
/companion creds [issue <name> [ttl] | rotate <id> [ttl] | revoke <id>]
/companion approvals [approve|deny <id>]
/companion backends
/companion export [names]
/companion reset <name>
```

The tools reuse the same modules as the CLI (`companion-store`,
`companion-templates`, `companion-backends`, `companion-artifacts`,
`approval-queue`), so queueing, rotation and approval semantics cannot drift
between the two surfaces; a test pins the tool list and the subcommands so a
new capability cannot land in the CLI while staying invisible in a session.

## Collaboration protocol

A teammate's reply may carry single-line directives, parsed by the worker
after each turn:

```
DELEGATE @builder: implement the config loader test
MESSAGE @builder: the config lives in equaxis-config.mjs
```

- `DELEGATE` queues a task for the named teammate (`runSource: delegated:<name>`).
- `MESSAGE` lands in the named teammate's inbox and is drained into their
  next task's prompt exactly once.
- Directives to unknown teammates are rejected without failing the task.

## Sandbox model (`--sandbox bwrap`, the `auto` default)

With bubblewrap available, every teammate subprocess runs under bwrap:

| Path | Mode |
|---|---|
| `/usr`, `/lib*`, `/bin`, `/sbin`, ssl/hosts/resolv | read-only |
| project root | read-only |
| `.pi/companion/workspaces/<name>` | **writable** (the teammate's files) |
| `.pi/companion/home/<name>` | **writable** (private HOME, `--home isolated`) |
| `~/.pi/agent/{auth,models,settings}.json` | read-only seed into the private HOME |
| `/tmp` | private tmpfs |

- `--home isolated` (default when sandboxed): the real HOME is **invisible**;
  the teammate gets a fresh HOME seeded with only the three credential/config
  files, re-bound read-only. Sessions and settings are per-teammate.
- `--home shared`: real HOME read-only except `~/.pi` (Pi's own lock files
  and session storage — required for provider auth to load at all).
- Bind order matters and is unit-tested: project root ro → private HOME rw →
  workspace rw (later binds shadow earlier ones).

## Execution backends (`--sandbox`)

Teammate subprocesses run through one of four tiers, weakest to strongest.
`companion backends` prints what this host actually supports and which tier
`auto` would pick:

```bash
companion backends
# ✓ directory  Directory sandbox   isolation: none
# ✓ bwrap      Bubblewrap sandbox  isolation: namespace (mount/pid/ipc)
# ✓ container  Container           isolation: container (rootfs + caps)
# ✗ microvm    MicroVM             isolation: hardware VM
#   no hypervisor binary found (looked for cloud-hypervisor, firecracker, qemu-system-x86_64)
```

| Tier | Isolation | Notes |
|---|---|---|
| `directory` | none | plain subprocess in the workspace; the pre-sandbox behavior |
| `bwrap` | mount/pid/ipc namespaces | system + project read-only, private HOME, private tmpfs `/tmp` |
| `container` | container | `docker`/`podman`, read-only rootfs, `--cap-drop ALL`, `no-new-privileges`, only workspace + private HOME writable |
| `microvm` | hardware VM | runner implemented (`qemu` 9p or `cloud-hypervisor` virtiofs); **availability requires** a hypervisor binary, `/dev/kvm`, and a bootable kernel + rootfs image pair — otherwise it reports exactly what is missing |

Selection rules:

- `--sandbox <tier>` — an explicit request that is unavailable is an
  **error** with the reason; nothing degrades silently.
- `--sandbox auto` (default) — picks the strongest available tier at or
  below `--sandbox-ceiling` (default `bwrap`, so auto never starts a
  container on its own), and logs why it stopped there.
- `--sandbox off` — no wrapping at all (tests, debugging).
- `--home isolated` requires a sandbox tier.

Verify for real, not just by argv shape:

```bash
npm run companion:backends                     # every available tier
npm run companion:backends -- bwrap directory  # pick tiers
npm run companion:backends -- container        # needs the image locally
```

Each probe runs `node -e` through the backend and checks that the child
starts, that its cwd is the teammate workspace, that a write *inside* the
workspace succeeds, and that a write into the read-only project root is
refused (`EROFS` under bwrap). The `directory` tier is expected to allow
that write — it is reported as documented behavior, not a pass.

## Running teammates

The worker claims tasks from the queue and runs each as an isolated Pi
subprocess in that teammate's workspace. What the MVP guarantees:

| Concern | Behaviour |
|---|---|
| **Parallelism** | `--concurrency N` (default 2). Each task gets its own slot; a teammate never runs two tasks at once, because its workspace and HOME are shared state. `--once` still means exactly one task, and `--maxTasks` caps a batch — both are counted over *claimed* work, so a wide pool cannot overshoot. |
| **Continuity** | `--context per-teammate` (default) passes a stable `--session-id`, so a task resumes the teammate's own conversation — ask it to remember a codeword and the next task still knows it. The session lives in the teammate's private HOME, so teammates never share a thread. `--context per-task` gives every task a cold start; `companion reset <name>` forgets the conversation on demand. Context grows with use: Pi's compaction settings apply, and `per-task` is the escape hatch. |
| **Model** | A teammate's `model` is passed to the subprocess as `--provider/--model`; it is validated against the catalog at creation time and again before a run. A bare ambiguous id is refused instead of guessed. |
| **Live logs** | Every task writes its JSON-mode stream to `.pi/companion/logs/<task-id>.log` as it arrives: `companion logs <id>` locally, or the "log" button in the dashboard / `GET /log/<id>?lines=n`. |
| **Cancel** | Cancelling a *pending* task finalizes immediately. Cancelling a *running* one records `cancelling`; the worker aborts the process tree and then finalizes `cancelled` with `cancelled while running`. The route never claims a subprocess is dead while it is alive. |
| **Cost** | Provider-reported usage (`turn_end.message.usage`) is summed per task — turns, tokens, cache reads/writes and `cost.total` — recorded even when the task is cancelled or fails, and rolled into `@teammate` totals shown in `companion status` and the dashboard. |

Both counters and usage survive a restart: `sanitizeTeammate`/`sanitizeTask`
rebuild records field by field, so every persisted field must be listed
explicitly (a missing entry silently resets it — that class of bug is now
covered by tests).

## Webhook ingress (`companion serve`)

```bash
npm run companion -- serve --port 7890
CRED=$(cat .pi/companion/webhook-token)   # 0600, issued on first start

curl -X POST http://127.0.0.1:7890/task/researcher \
  -H "authorization: Bearer $CRED" \
  -H "content-type: application/json" \
  -d '{"instruction": "check the release notes"}'

curl -H "authorization: Bearer $CRED" http://127.0.0.1:7890/status
curl -H "authorization: Bearer $CRED" "http://127.0.0.1:7890/feed?n=20"
```

Routes: `GET /` serves the mobile dashboard (below); `POST /task/<name>`
enqueues (`runSource: webhook`, `dashboard` for same-origin requests, or
`credential:<name>` for a scoped credential); `POST /cancel/<taskId>` cancels
a pending task (409 otherwise); `POST /routine` creates a schedule and
`POST /routine/<id>/remove` deletes one; `GET /status` returns queue counts,
`teammateDetails` (with `pendingTasks`, `spend`) and `routineDetails` (with a
computed `nextRunAt`); `GET /thread/<teammate>?n=` returns recent turns with
their results and usage; `GET /approvals` lists parked high-risk requests and
`POST /approval/<requestId>` decides one; `GET /artifacts/<taskId>` returns the
workspace change manifest and `GET /artifact/<taskId>/{diff,raw}?path=` serves
one file; `GET /log/<taskId>?lines=` tails a task's stream
log; `GET /feed?n=` returns recent feed entries (1–200);
`GET /healthz` is the only unauthenticated route.

Discipline (mirrors the automation server): loopback by default; bearer
credential on every data route; a request carrying an `Origin` header is
accepted only when it is same-origin (the dashboard itself) — any foreign
web page is refused before auth; Host headers outside the allowlist
(loopback + explicitly declared hosts) are refused the same way (DNS
rebinding); bodies capped at 32 KB and must be JSON.

## Web app (`companion serve`)

`companion serve` serves a chat application on the same port — zero build
step, three strings in `src/companion-pwa.mjs`, no asset directory:

```bash
npm run companion -- serve --port 7890                     # http://localhost:7890/
npm run companion -- serve --port 7890 --listen 0.0.0.0   # reachable from a phone
```

Layout:

- **sidebar** — every teammate with a live status dot, spend and the current
  or last activity; footer buttons for approvals (with a pending badge),
  routines and connection settings;
- **chat pane** — the selected teammate's conversation as bubbles. A running
  task shows what it is doing *while it runs*: `GET /progress/<taskId>` is
  derived from the teammate's own stream log, so the bubble shows the live
  text, the reasoning summary and the tool calls it is making, refreshed every
  1.2 s. Pending turns get a cancel button, running ones a stop button;
- **files** — a turn that changed files shows a chip; opening it lists each
  path with a per-file diff and a download link;
- **panels** — approvals (approve/deny), routines (create/remove), connection
  (the bearer token, kept in localStorage after being pasted once) and the raw
  task log.

On a phone the sidebar is the entry view and opening a teammate takes over
the screen with a back button. The service worker caches only the shell —
every API route is network-only, because a cached reply would be a lie.

The app is admin-side: it uses the global webhook credential, and no static
asset ever contains a secret.

## Per-teammate credentials

The global webhook credential is an *admin* key: it can queue tasks for any
teammate, read state, and cancel. For integrations that should only be able
to hand work to **one** teammate (a phone shortcut, a chat bot, a CI job),
mint a scoped credential instead:

```bash
companion credentials issue researcher --label "phone"
# credential 9ba2ec91 for @researcher (phone)
#   bearer: eqc1_…            <- shown once; only a SHA-256 digest is stored
#   shown once — store it now; it may only queue tasks for this teammate

companion credentials issue researcher --ttl 30d   # optional expiry
companion credentials rotate 9ba2ec91 [--ttl 30d]  # revoke + reissue, new value once
companion credentials list               # id, teammate, last used / revoked / expiry
companion credentials revoke 9ba2ec91    # prefix match, must be unambiguous
```

| Presented value | May do |
|---|---|
| global webhook credential | everything (`/status`, `/feed`, `/cancel`, any `/task/<name>`) |
| teammate credential | `POST /task/<own-name>` only — `/status`, `/feed`, `/cancel` are 403 |
| anything else / revoked | 401 |

Scoped tasks are labeled `runSource: credential:<name>` so the audit trail
shows which key queued them. Revocation is observed by a running
`companion serve` on the next request (the store revalidates its cache
against the credentials file's mtime+size), so no restart is needed.
Deleting the teammate also kills its credentials. Scoped credentials are
still subject to the Origin/Host guards.

**Rotation and expiry.** `--ttl` gives a credential a bounded lifetime;
expiry is enforced on use (an expired value is a 401, even if nobody ran the
CLI). `credentials rotate` revokes the old value and mints a replacement
that keeps the teammate, label and lifetime policy — an explicit `--ttl`
overrides the inherited one, and rotating an already-revoked credential is
refused with guidance instead of silently working. `credentials list` shows
expiry and warns about anything expired or expiring within 7 days.

## Teammate templates

A template is a portable, secret-free description of how a teammate works —
safe to commit, diff and share. It never contains ids, stats, queue entries,
inbox messages or credentials, so importing one can never resurrect old
authority.

```bash
companion export researcher --out team.json   # or --all, or several names
companion import team.json                    # create; existing names are skipped
companion import team.json --rename scout-2   # stamp a copy under a new name
companion import team.json --overwrite        # update profiles in place
companion import team.json --dry-run          # show the plan, write nothing
```

```json
{
  "equaxisCompanionTemplate": 1,
  "teammates": [
    { "name": "researcher", "persona": "a meticulous researcher", "workspace": "researcher", "model": "sonnet" }
  ]
}
```

A bare JSON array of teammate objects is accepted too (what people actually
type by hand). Refusals are deliberate: an unknown template version, an
unknown field (usually a typo meant to do something), a non-kebab-case name
and an empty `teammates` array are all errors rather than silent drops.
`--rename` requires a single-teammate template and gives the copy its own
workspace, so two variants never write over each other's files.

## Artifacts (what a task actually changed)

A result is text; the deliverable is usually a file. Every task captures a
before/after view of the teammate's workspace, so a finished task can show
what changed instead of just claiming it:

```bash
curl -H "authorization: Bearer $CRED" http://127.0.0.1:7890/artifacts/<taskId>
# { counts: {added, modified, deleted}, added: [...], modified: [...], deleted: [...] }

curl -H "authorization: Bearer $CRED" \
  "http://127.0.0.1:7890/artifact/<taskId>/diff?path=report.md"    # line hunks
curl -OJ -H "authorization: Bearer $CRED" \
  "http://127.0.0.1:7890/artifact/<taskId>/raw?path=report.md"     # the file
```

In the dashboard, a turn that changed files gets a **files: 1 added, 2
modified** button; opening it lists each path with a per-file diff and a
download link.

How it works and what it refuses:

- the worker snapshots the workspace before the run and copies small text
  files (`<= 64 KB`) into `.pi/companion/artifacts/<taskId>/before/`, then
  writes `manifest.json` afterwards — so diffs are real, not reconstructed;
- `.git`, `node_modules`, `dist`, `build`, `__pycache__`, `.venv` are ignored;
  snapshots cap at 2000 files and lists at 200 entries (`truncated: true`);
- binaries and files over 256 KB are **listed but not diffed** (an honest
  "not diffable" instead of a fake diff), and downloads are capped at 4 MB;
- reads are confined to the manifest's recorded workspace and to the files it
  lists: `../`, absolute paths and unlisted names are 404 — a symlink or a
  stale config cannot turn the dashboard into a file server;
- a failed or cancelled task still captures artifacts (flagged `partial`), so
  a half-finished change is visible rather than invisible.

## Approvals (high-risk actions)

A headless teammate cannot ask a human anything, so the Reliability Harness
parks every high-risk tool call in a file-backed queue and polls it for a
bounded window (`.pi/runtime/approvals/`, `approval.webQueue.timeoutMs`,
default 60s). `companion serve` is the other end of that conversation:

```bash
curl -H "authorization: Bearer $CRED" http://127.0.0.1:7890/approvals
# { projectRoot, pending: [{requestId, toolName, reason, summary, ageMs}], history: [...] }

curl -X POST http://127.0.0.1:7890/approval/<requestId> \
  -H "authorization: Bearer $CRED" -H "content-type: application/json" \
  -d '{"decision": "approve"}'
```

In the dashboard, pending requests appear above the teammates with the tool
name, the policy reason, the command summary, and **Approve / Deny**
buttons; the section is hidden when there is nothing to decide.

- Admin credential only. A scoped teammate credential gets 403 — a teammate
  must never be able to approve its own high-risk action.
- Deciding an id that the harness never parked is 404 (a decision for an
  unknown request would be an invisible no-op), and a decision other than
  `approve`/`deny` is 400.
- Unknown origin/Host rules apply as everywhere else.
- Nothing is approved by default: if no human answers within the window, the
  call is denied and the task continues without it.

## Notifications

Every task completion/failure appends to `.pi/companion/feed.jsonl` (always),
then tries, in order, whichever is configured: Telegram
(`COMPANION_TELEGRAM_TOKEN` + `COMPANION_TELEGRAM_CHAT_ID`), ntfy
(`COMPANION_NTFY_URL`), desktop (`notify-send`). A channel failure never
fails a task.

## Crash safety

- All state files are written atomically (tmp + rename).
- On open, tasks left `running` by a crashed worker are requeued; after 3
  attempts they fail with the reason recorded.
- Routine runs stamp `lastRunAt` when *enqueued*, so a crashed worker cannot
  re-enqueue a storm of duplicate routine tasks.

## Running as a service (systemd)

```ini
# ~/.config/systemd/user/openbot-companion.service  (companion.service)
[Unit]
Description=Equaxis companion teammates (worker + webhook)
After=network-online.target

[Service]
WorkingDirectory=%h/equaxis-dev/src
ExecStart=/usr/bin/node scripts/companion.mjs serve --port 7890
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now companion.service
journalctl --user -u companion.service -f
```

## State layout (all gitignored)

```
.pi/companion/
  teammates.json   profiles: persona, workspace, model, stats
  queue.json       FIFO task queue (pending/running/done/failed/cancelled)
  messages.json    inbox messages (drain-on-read)
  routines.json    interval-scheduled recurring tasks
  feed.jsonl       append-only notification feed
  webhook-token    admin bearer credential for the ingress (0600)
  credentials.json scoped per-teammate credentials (sha256 digests only)
  workspaces/<name>/   the teammate's files
  home/<name>/         the teammate's private HOME
```
