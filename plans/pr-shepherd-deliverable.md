# midgard-cc-assistant | PR Shepherd — Deliverable

## Problem Statement

After an AI coding agent opens a pull request, the remaining PR lifecycle is entirely manual. A human must monitor CI, relay failures, read review feedback, post to chat for reviews, wait, relay back, and enable auto-merge. None of these steps require human judgment — they're dispatching and monitoring — but they require constant human attention and context switching. This makes the human operator the throughput bottleneck for how many PRs can be in flight.

PR Shepherd automates this dispatch loop so humans only need to write code and review code.

## Features and Functionality Built

### Core Components

**1. Polling Daemon (`src/daemon.ts`)**
- Polls GitHub via `gh` CLI for each tracked PR on a configurable interval (default: 3 minutes)
- Detects state transitions: CI pass/fail, new reviews, approvals, changes requested, new commits, merge, close, stale
- Writes events to an append-only JSONL audit log
- Notifies the shepherd agent via `tmux send-keys` on state transitions
- Zero AI tokens consumed — pure script

**2. Shepherd Event Handler (`src/shepherd.ts`)**
- Processes state transition events from the daemon
- On CI failure: summarizes failed checks, sends to worker agent
- On changes requested: relays full review body to worker
- On all approved: enables auto-merge via `gh pr merge --auto`
- On merged: removes PR from tracking, posts to webhook
- On stale: posts review request to webhook
- Error-resilient: all handlers wrapped in try/catch

**3. Registration Protocol (`src/tracking.ts`, CLI)**
- CLI: `pr-shepherd add <github-pr-url> --worker <agent-name>`
- Or direct JSON write for programmatic registration
- Atomic writes (tmp file + rename) prevent corruption
- Corrupt file recovery (returns empty array, logs warning)

### State Machine (`src/state-machine.ts`)
- 11 states: OPENED → CI_PENDING → CI_PASSED → AWAITING_REVIEW → APPROVED → AUTO_MERGE_ENABLED → MERGED (plus CI_FAILED, CHANGES_REQUESTED, STALE, CLOSED)
- Pure function transitions: `(state, event) → newState | null`
- Terminal states: MERGED, CLOSED
- **70 unit tests** covering every valid transition, every invalid transition, every terminal state rejection, and full lifecycle scenarios (happy path, CI failure loop, changes requested loop)

### Configuration (`src/config.ts`)
- Three-layer config cascade: CLI flags → environment variables → config file → defaults
- All secrets in environment variables (webhook URLs, conductor URLs, GitHub tokens)
- All org-specific values in config (repo names, bot usernames, check names, channels)
- Validation with clear error messages
- NaN-safe env var parsing

### CLI (`src/index.ts`)
- `pr-shepherd start` — starts the polling daemon
- `pr-shepherd add <url>` — registers a PR for tracking
- `pr-shepherd list` — shows tracked PRs with current state
- `pr-shepherd remove <number>` — stops tracking a PR
- `pr-shepherd events` — shows the event audit log

### Notification Layer (`src/notifications.ts`)
- tmux send-keys for daemon → agent communication
- Generic webhook POST for chat notifications (Slack, Discord, Teams, any JSON endpoint)
- Conductor MCP integration for agent-to-agent messaging
- Consistent message formatting for all event types

### Test Suite
- **123 tests across 6 test files**, all passing
- State machine: 70 tests (transitions, terminal states, full lifecycles)
- GitHub parsing: 17 tests with realistic fixtures from real `gh` output
- Shepherd: 10 tests (event handling, message parsing)
- Tracking: 11 tests (CRUD, atomic writes, edge cases)
- Events: 5 tests (append, read, filter)
- Config: 10 tests (defaults, merging, env overrides, validation)

### Documentation
- README.md with setup instructions, architecture, configuration reference
- System prompt for the shepherd agent (`config/system-prompt.txt`)
- Example config (`config/shepherd.example.json`)
- Environment variable template (`.env.example`)

## What Is NOT Included

- No Slack/Discord SDK integration — uses generic incoming webhooks
- No graceful shutdown / signal handling (Ctrl+C works, just no cleanup)
- No GitHub App authentication — uses `gh` CLI's existing auth
- No web UI or dashboard — CLI and JSONL event log only
- No concurrent/async polling — PRs are polled sequentially (fine for < 50 PRs)

## Manual Testing Plan

### Prerequisites
- Node.js 22+, `gh` CLI authenticated, tmux running

### Setup
```bash
cd /Users/ianlancaster/Projects/pr-shepherd
npm install
npm run build
```

### Test 1: CLI basics
```bash
# Add a real PR to tracking
npx tsx src/index.ts add https://github.com/MGT-Insurance/midgard/pull/3550 --worker midgard-1

# Verify it's tracked
npx tsx src/index.ts list

# Check events (should be empty)
npx tsx src/index.ts events

# Remove it
npx tsx src/index.ts remove 3550 --repo MGT-Insurance/midgard
```

### Test 2: Dry-run daemon against a real PR
```bash
# Add a PR
npx tsx src/index.ts add https://github.com/MGT-Insurance/midgard/pull/3550 --worker midgard-1

# Start daemon in dry-run mode with short interval
npx tsx src/index.ts start --dry-run --interval 15

# Watch the output — should see state transitions logged
# The PR should move from OPENED → CI_PENDING → CI_PASSED or CI_FAILED
# Ctrl+C to stop

# Check events were recorded
npx tsx src/index.ts events
```

### Test 3: Full daemon with tmux notification
```bash
# Create a tmux pane for the shepherd
tmux split-window -h
# Note the pane ID (e.g., %5)

# In the original pane, set the shepherd pane
export PR_SHEPHERD_TMUX_PANE="%5"

# Add a PR and start daemon
npx tsx src/index.ts add https://github.com/MGT-Insurance/midgard/pull/3550 --worker midgard-1
npx tsx src/index.ts start --interval 15

# Watch the shepherd pane — should see "[PR Shepherd Event]" messages on transitions
```

### Test 4: Webhook integration (if webhook URL available)
```bash
export PR_SHEPHERD_WEBHOOK_URL="https://hooks.slack.com/services/YOUR/WEBHOOK/URL"

npx tsx src/index.ts add https://github.com/MGT-Insurance/midgard/pull/3550 --worker midgard-1
npx tsx src/index.ts start --interval 15

# Watch Slack — should see messages on CI failure, stale PRs, etc.
```

### Test 5: Unit test suite
```bash
npm test
# Expected: 123 tests, 6 files, all passing
```

### Test 6: Type checking
```bash
npx tsc --noEmit
# Expected: clean, no errors
```
