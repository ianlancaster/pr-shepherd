# midgard-cc-assistant | PR Shepherd — Implementation Plan

## Problem Statement

Coding agents (Claude Code, Copilot Workspace, Devin, etc.) can open pull requests autonomously. But once the PR is open, the entire remaining lifecycle is manual. A human must: monitor CI, relay CI failures back to the agent, read bot and human review feedback and relay it, post to chat requesting peer reviews, wait for reviews, relay review feedback to the agent, confirm the agent addressed it, re-notify peers, enable auto-merge, and monitor until merge.

Every one of these steps requires human attention and context switching. None of them requires human *judgment* — it's dispatching and monitoring. This creates a throughput bottleneck: the human operator becomes the rate limiter on how many PRs can be in flight simultaneously. A single distraction can stall multiple PRs for hours.

PR Shepherd eliminates this bottleneck by automating the dispatch loop. Humans still write code and review code. Everything in between — the polling, the relaying, the nudging, the auto-merge — is handled by a lightweight daemon and an AI agent working together.

The tool is designed to be **organization-agnostic**. It works with any GitHub repository, any CI system that reports via GitHub checks, any review bots that post as GitHub comments or reviews, and any chat system that accepts webhooks. All organization-specific details (repo names, bot usernames, chat channels, CI check names) live in configuration — not in code.

## Scope Check

### What was requested

A three-component system:

1. **Polling daemon** — a background script that polls GitHub via `gh` CLI on an interval for each tracked PR, detects state transitions (CI passed/failed, new reviews, bot comments, merges), writes events to an event log, and notifies the shepherd agent via `tmux send-keys`. Zero AI tokens consumed.

2. **Shepherd agent** — an AI agent (Claude Code instance) activated on state transitions. Reads failure details, review feedback, or bot findings and relays actionable information to worker agents. Enables auto-merge when all approvals + CI green. Posts to chat for review requests and merge confirmations. Removes merged/closed PRs from tracking.

3. **Registration protocol** — how PRs get tracked. Workers write entries to a tracking file when they open PRs. The poll daemon picks them up. The shepherd removes them on merge/close.

Plus: a configurable state machine, event logging, and a config file for all tunable parameters (poll interval, stale threshold, required approvals, merge strategy, chat channels, bot usernames).

### What I'm proposing

Everything listed above, plus:

### Additions beyond spec

1. **`pr-shepherd` CLI entry point** — a `bin` command for `pr-shepherd start`, `pr-shepherd add <pr-url>`, `pr-shepherd list`, `pr-shepherd remove <pr-number>`, `pr-shepherd events [pr-number]`. Makes the tool usable without manually editing JSON.
2. **`CLOSED` terminal state** — PRs can be closed without merging. The state machine handles this gracefully rather than leaving them tracked forever.
3. **Dry-run mode** — `--dry-run` flag on the daemon that logs what it *would* do without sending messages or enabling auto-merge. Useful for testing against real PRs.
4. **Pluggable notification system** — chat notifications use a webhook interface, so any system (Slack, Discord, Teams, etc.) works via configuration. No vendor-specific code.

Everything else matches the spec exactly.

### Explicitly NOT doing

- No Canary-specific state or handling. Bot reviewers (Canary, Copilot, CodeRabbit, etc.) post GitHub reviews or comments — the daemon detects these exactly like human reviews. If the review requests changes, the shepherd relays it. The tool doesn't need to know or care whether the reviewer is a bot or a human. Bot usernames are optionally tracked in config for logging purposes only.

## Architecture

### Project Structure

```
pr-shepherd/
├── src/
│   ├── index.ts                  CLI entry point
│   ├── daemon.ts                 Polling daemon main loop
│   ├── shepherd.ts               Event handler (the "brain")
│   ├── config.ts                 Configuration loader + validation
│   ├── types.ts                  All type definitions
│   ├── state-machine.ts          PR state machine + transition logic
│   ├── github.ts                 GitHub API via gh CLI wrapper
│   ├── notifications.ts          tmux + webhook notification layer
│   ├── tracking.ts               PR tracking file read/write
│   └── events.ts                 Event log (JSONL) append/read
├── test/
│   ├── state-machine.test.ts     State machine unit tests
│   ├── github.test.ts            GitHub response parsing tests
│   ├── shepherd.test.ts          Event handler logic tests
│   ├── tracking.test.ts          Tracking file operations
│   ├── events.test.ts            Event log operations
│   ├── config.test.ts            Config loading + defaults
│   └── fixtures/                 Realistic gh CLI output fixtures
│       ├── checks-pending.json
│       ├── checks-passed.json
│       ├── checks-failed.json
│       ├── pr-view-open.json
│       ├── pr-view-merged.json
│       ├── reviews-approved.json
│       ├── reviews-changes-requested.json
│       └── comments-with-bot.json
├── config/
│   ├── shepherd.example.json     Example config (committed, documented)
│   └── system-prompt.txt         Shepherd agent system prompt
├── data/                         Runtime state (gitignored)
│   ├── pr-tracking.json          Active PR tracking
│   └── pr-events.jsonl           Event audit log
├── plans/                        Planning documents
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
├── .env.example                  Environment variable template
└── README.md
```

### Environment Variables

All secrets and instance-specific values come from environment variables. The `.env.example` file documents every variable:

```bash
# Required
PR_SHEPHERD_DATA_DIR=./data                    # Where tracking + event files live

# GitHub (optional — defaults to gh CLI's authenticated user/repo)
GITHUB_TOKEN=                                  # Only needed if not using gh CLI auth

# Chat notifications (optional — omit to disable)
PR_SHEPHERD_WEBHOOK_URL=                       # Slack/Discord/Teams incoming webhook URL

# Agent communication (optional — omit to disable conductor integration)
PR_SHEPHERD_CONDUCTOR_URL=                     # Conductor MCP server URL (e.g. http://localhost:3456)

# Tmux (optional — defaults)
PR_SHEPHERD_TMUX_PANE=                         # Tmux target pane for shepherd agent
```

No secrets in config files. No organization names in source code.

### Configuration Schema

`shepherd.config.json` — all optional, all overridable:

```json
{
  "pollIntervalSeconds": 180,
  "staleThresholdHours": 4,
  "requiredApprovals": 1,
  "mergeStrategy": "squash",
  "dryRun": false,

  "github": {
    "defaultRepo": null
  },

  "reviews": {
    "ignoreUsers": [],
    "botUsers": []
  },

  "checks": {
    "requiredChecks": [],
    "ignoreChecks": []
  },

  "notifications": {
    "webhookUrl": null,
    "channel": null,
    "onMerge": true,
    "onCIFailure": true,
    "onStale": true,
    "onApproval": true
  },

  "agent": {
    "conductorUrl": null,
    "shepherdPane": null
  }
}
```

**Key design decisions:**

- `reviews.botUsers` — optional list of GitHub usernames that are bots (e.g. `["my-review-bot[bot]", "copilot[bot]"]`). Used for logging context only ("bot review" vs "human review" in event log). Bot reviews are processed identically to human reviews — no special handling.
- `reviews.ignoreUsers` — usernames whose reviews/comments should be completely ignored (e.g. CI bots that post status comments but aren't reviews).
- `checks.requiredChecks` — if non-empty, only these check names must pass. If empty, all non-skipped checks must pass.
- `checks.ignoreChecks` — check names to ignore when evaluating CI status (e.g. optional deploy previews).
- `github.defaultRepo` — used when a PR is registered without an explicit repo. Format: `owner/repo`.
- `notifications.webhookUrl` — generic incoming webhook URL. Works with Slack, Discord, Teams, or any service that accepts JSON POST with a `text` or `content` field. The notification layer auto-detects the format.

Config is loaded from (in priority order):
1. CLI flags
2. Environment variables (`PR_SHEPHERD_*`)
3. `shepherd.config.json` in the working directory
4. Built-in defaults

### Polling Daemon Design

The daemon is the cheap, dumb component. It runs in a background tmux pane and consumes zero AI tokens.

**Main loop:**

```
every POLL_INTERVAL (default 3 minutes):
  for each PR in pr-tracking.json:
    1. gh pr view <number> --repo <repo> --json ... → PR state snapshot
    2. gh pr checks <number> --repo <repo> --json ... → CI check statuses
    3. gh pr view <number> --repo <repo> --json reviews → review list
    4. Compare snapshot to last-known state
    5. On state transition:
       a. Write event to pr-events.jsonl
       b. Update pr-tracking.json with new state + snapshot
       c. Notify shepherd agent via tmux send-keys
```

**What the daemon polls per PR:**

| Data | Command | Key fields |
|------|---------|------------|
| PR state, merge status | `gh pr view <n> -R <r> --json state,reviewDecision,mergeStateStatus,autoMergeRequest,mergedAt,closedAt,headRefOid` | — |
| CI checks | `gh pr checks <n> -R <r> --json name,state,bucket` | — |
| Reviews | `gh pr view <n> -R <r> --json reviews,latestReviews` | author.login, state, body, submittedAt |

`headRefOid` is polled to detect new commits (worker pushed a fix) — if it changes between polls, that's a `new_commit` event.

**Notification to shepherd:**

```bash
tmux send-keys -t "$SHEPHERD_PANE" \
  "[PR Shepherd Event] {\"pr\":123,\"repo\":\"owner/repo\",\"event\":\"ci_failed\",\"ts\":\"...\"}" Enter
```

The shepherd receives this as a user message and acts on it.

### Shepherd Agent Protocol

The shepherd is an AI agent (Claude Code instance) with a system prompt that defines its behavior. It is idle most of the time, only activated when the daemon types an event into its pane.

**Event handling matrix:**

| Event | Shepherd Action |
|-------|----------------|
| `ci_failed` | Run `gh pr checks`, identify failed checks, summarize. Send to worker with instructions to fix. |
| `ci_passed` | Log. If reviews are pending, no action (wait for reviews). If all approvals present, enable auto-merge. |
| `review_posted` | Read review body and state. If `CHANGES_REQUESTED` or `COMMENTED` with substantive body, relay to worker. If `APPROVED`, check if all required approvals met → enable auto-merge. |
| `all_approved` | Enable auto-merge via `gh pr merge --auto --squash` (strategy from config). |
| `merged` | Remove PR from tracking. Post merge confirmation to webhook. |
| `closed` | Remove PR from tracking. Log closure. |
| `stale` | PR has been awaiting review longer than threshold. Post to webhook requesting reviews. |
| `new_commit` | Worker pushed. Reset state to CI_PENDING, monitor again. |

**Worker communication:**

Messages sent to workers via conductor MCP (`send_to_agent`) or typed directly into their tmux pane (`tmux send-keys`). The method is per-PR: if a `conductorAgent` is set on the tracked PR, use conductor. Otherwise, if a `workerPane` is set, use tmux. The message format is consistent:

```
[PR Shepherd] PR #123 — CI Failed

The following checks failed:

- lint: FAILURE
- test-suite (shard 1): FAILURE

Please investigate and push a fix. I'll monitor CI on the next push.
```

### Registration Protocol

**Option A — CLI:**
```bash
pr-shepherd add https://github.com/owner/repo/pull/123 \
  --worker my-agent \
  --channel eng-prs
```

**Option B — Direct JSON (for automation/agents):**
Append to `pr-tracking.json`:
```json
{
  "number": 123,
  "repo": "owner/repo",
  "worker": "my-agent",
  "channel": null,
  "state": "OPENED",
  "headSha": null,
  "addedAt": "2026-06-15T12:00:00Z",
  "lastCheckedAt": null,
  "lastEventAt": null
}
```

The `worker` field identifies where to send feedback. It can be a conductor agent codename or a tmux pane name — the notification layer resolves it based on what's available.

**Atomic writes:** write to temp file, `rename()` into place. Prevents corruption from concurrent access.

### State Machine

```
OPENED
  └─→ CI_PENDING (automatic on first poll)
        ├─→ CI_PASSED
        │     └─→ AWAITING_REVIEW
        │           ├─→ CHANGES_REQUESTED (review requests changes → relayed to worker)
        │           │     └─→ CI_PENDING (worker pushed fix)
        │           ├─→ APPROVED (all required approvals met)
        │           │     └─→ AUTO_MERGE_ENABLED
        │           │           └─→ MERGED ■
        │           └─→ STALE (no review activity past threshold)
        │                 └─→ AWAITING_REVIEW (after re-requesting)
        └─→ CI_FAILED (→ relayed to worker)
              └─→ CI_PENDING (worker pushed fix)

CLOSED ■ (can happen from any non-terminal state)
```

**Terminal states:** `MERGED`, `CLOSED`

**States:**

| State | Meaning |
|-------|---------|
| `OPENED` | PR just registered, not yet polled |
| `CI_PENDING` | CI checks are running |
| `CI_PASSED` | All required checks passed |
| `CI_FAILED` | One or more required checks failed |
| `AWAITING_REVIEW` | CI passed, waiting for human/bot reviews |
| `CHANGES_REQUESTED` | A reviewer requested changes, feedback sent to worker |
| `APPROVED` | All required approvals received |
| `AUTO_MERGE_ENABLED` | Auto-merge enabled, waiting for GitHub to merge |
| `STALE` | No review activity past the stale threshold |
| `MERGED` | PR merged (terminal) |
| `CLOSED` | PR closed without merge (terminal) |

**Transition function:**

Each transition is a pure function: `(currentState, event) → newState | null`. Returns `null` if the transition is invalid (e.g., from a terminal state). This makes the state machine trivially testable.

```typescript
type PRState =
  | 'OPENED'
  | 'CI_PENDING'
  | 'CI_PASSED'
  | 'CI_FAILED'
  | 'AWAITING_REVIEW'
  | 'CHANGES_REQUESTED'
  | 'APPROVED'
  | 'AUTO_MERGE_ENABLED'
  | 'STALE'
  | 'MERGED'
  | 'CLOSED';

type PREvent =
  | 'poll_started'
  | 'ci_passed'
  | 'ci_failed'
  | 'ci_pending'
  | 'review_posted'
  | 'changes_requested'
  | 'all_approved'
  | 'auto_merge_enabled'
  | 'merged'
  | 'closed'
  | 'new_commit'
  | 'stale_detected'
  | 'review_requested';
```

### Event Log Format

`pr-events.jsonl` — one JSON object per line, append-only:

```json
{"ts":"2026-06-15T12:03:00Z","pr":123,"repo":"owner/repo","event":"ci_failed","from":"CI_PENDING","to":"CI_FAILED","details":{"failedChecks":["lint","test-suite (1)"]}}
{"ts":"2026-06-15T12:03:05Z","pr":123,"repo":"owner/repo","event":"feedback_sent","from":"CI_FAILED","to":"CI_FAILED","details":{"target":"my-agent","method":"conductor"}}
```

Each event: timestamp, PR number, repo, event type, state transition, and event-specific details. This provides a complete audit trail that can be replayed or analyzed.

## Implementation Sequence

### Step 1: Project scaffolding
- `package.json` with TypeScript, Vitest, commander
- `tsconfig.json` (ESM, Node 22, strict)
- `.gitignore`, `.env.example`, `vitest.config.ts`
- Git init

### Step 2: Types and state machine
- All type definitions in `types.ts`
- State machine transitions in `state-machine.ts`
- Comprehensive state machine tests

### Step 3: Configuration
- Config loader with env vars → config file → defaults cascade in `config.ts`
- Validation (no invalid combinations)
- Config tests

### Step 4: Data layer
- Tracking file read/write with atomic writes in `tracking.ts`
- Event log append/query in `events.ts`
- Tests for both

### Step 5: GitHub integration
- `gh` CLI wrapper in `github.ts`
- Parse checks, reviews, PR state into typed structures
- Tests with fixture data

### Step 6: Notification layer
- tmux send-keys wrapper in `notifications.ts`
- Webhook posting (generic JSON payload, auto-detect Slack/Discord format)
- Conductor integration (optional, when URL configured)

### Step 7: Polling daemon
- Main poll loop in `daemon.ts`
- State comparison + transition detection
- Event dispatch

### Step 8: Shepherd event handler
- Event routing in `shepherd.ts`
- Per-event action functions
- Message formatting for worker agents

### Step 9: CLI
- `pr-shepherd start` — starts the polling daemon
- `pr-shepherd add <url> [--worker <name>] [--channel <ch>]` — registers a PR
- `pr-shepherd list` — shows tracked PRs with current state
- `pr-shepherd remove <number> [--repo <r>]` — removes a PR from tracking
- `pr-shepherd events [--pr <number>]` — shows event log (optionally filtered)

### Step 10: System prompt + agent config
- Shepherd agent system prompt in `config/system-prompt.txt`
- Generic — references config for org-specific behavior
- Instructions for handling each event type

### Step 11: README
- Setup instructions (clone, install, configure, start)
- Architecture overview
- Configuration reference with all env vars and config keys
- Usage examples
- How to integrate with different CI bots, review bots, chat systems

## Open Questions

1. **Webhook format** — I'll default to Slack-compatible JSON (`{"text": "..."}`) and add a `webhookFormat` config option for `slack | discord | teams | custom`. Custom allows specifying a JSON template. For v1, Slack format covers the 80% case and Discord is nearly identical.

2. **Multiple repos** — Each tracked PR carries its own `repo` field. The config's `github.defaultRepo` is just a convenience default. Multi-repo works out of the box.

3. **Shepherd agent lifecycle** — PR Shepherd writes the system prompt and notification protocol. The actual agent session is managed externally (by the conductor, or started manually). PR Shepherd doesn't start/stop the agent — it just sends events to a tmux pane.
