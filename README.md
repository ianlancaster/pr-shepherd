# PR Shepherd

Automated PR lifecycle management for AI coding agents. Monitors pull requests, relays CI failures and review feedback to worker agents, requests peer reviews, and enables auto-merge — so humans only need to write code and review code. Also watches for incoming review assignments and automatically notifies your AI assistant to dispatch review workers.

## How It Works

Four components:

1. **Polling daemon** — runs in a background tmux pane, polls GitHub every 3 minutes via `gh` CLI, detects state transitions, and notifies the shepherd agent. Zero AI tokens consumed.

2. **Shepherd agent** — a Claude Code (or any AI) instance that handles the intelligent work. Activated only on state transitions: summarizes CI failures, relays review feedback, enables auto-merge, posts to chat for review requests.

3. **Registration protocol** — workers register PRs via CLI or by writing to `pr-tracking.json`. The daemon picks them up. PRs are removed on merge or close.

4. **Review inbox** — watches for PRs where you've been requested as a reviewer (by bots or humans). When a new non-draft assignment is detected, automatically notifies your AI assistant to dispatch a worker for review. You read the review report and decide what to post.

## Quick Start

```bash
git clone <repo-url> pr-shepherd
cd pr-shepherd
npm install
npm run build

# Add a PR to track
pr-shepherd add https://github.com/your-org/your-repo/pull/123 --worker my-agent

# Start the daemon
pr-shepherd start

# Check status
pr-shepherd list
pr-shepherd events
```

## Prerequisites

- **Node.js 22+**
- **GitHub CLI (`gh`)** — authenticated (`gh auth login`)
- **tmux** — for daemon ↔ agent communication

## Configuration

PR Shepherd is configured through three layers (in priority order):

1. **CLI flags** — `--dry-run`, `--interval`, etc.
2. **Environment variables** — `PR_SHEPHERD_*`
3. **Config file** — `shepherd.config.json` in the working directory

### Environment Variables

```bash
# Where tracking + event files live (default: ./data)
PR_SHEPHERD_DATA_DIR=./data

# GitHub token — only needed if not using gh CLI auth
GITHUB_TOKEN=

# Chat notifications — Slack/Discord/Teams incoming webhook URL
PR_SHEPHERD_WEBHOOK_URL=https://hooks.slack.com/services/...

# Conductor MCP server URL for agent-to-agent messaging
PR_SHEPHERD_CONDUCTOR_URL=http://localhost:3456

# Tmux target pane for the shepherd agent
PR_SHEPHERD_TMUX_PANE=shepherd

# Convenience overrides
PR_SHEPHERD_POLL_INTERVAL=180
PR_SHEPHERD_STALE_HOURS=4
PR_SHEPHERD_REQUIRED_APPROVALS=1
PR_SHEPHERD_DRY_RUN=false
PR_SHEPHERD_DEFAULT_REPO=your-org/your-repo

# Review inbox — auto-detect incoming review assignments
PR_SHEPHERD_REVIEW_INBOX_ENABLED=true
PR_SHEPHERD_REVIEW_INBOX_USER=your-github-username
PR_SHEPHERD_REVIEW_INBOX_AGENT=your-assistant-agent
PR_SHEPHERD_REVIEW_INBOX_PANE=
```

### Config File

Copy `config/shepherd.example.json` to `shepherd.config.json` and edit:

```json
{
  "pollIntervalSeconds": 180,
  "staleThresholdHours": 4,
  "requiredApprovals": 1,
  "mergeStrategy": "squash",

  "github": {
    "defaultRepo": "your-org/your-repo"
  },

  "reviews": {
    "ignoreUsers": ["dependabot[bot]"],
    "botUsers": ["your-review-bot[bot]"]
  },

  "checks": {
    "requiredChecks": [],
    "ignoreChecks": ["optional-deploy-preview"]
  },

  "notifications": {
    "channel": "pr-reviews",
    "onMerge": true,
    "onCIFailure": true,
    "onStale": true,
    "onApproval": true
  },

  "reviewInbox": {
    "enabled": true,
    "githubUser": "your-github-username",
    "notifyAgent": "your-assistant-agent",
    "ignoreRepos": [],
    "ignoreDrafts": true
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `pollIntervalSeconds` | 180 | How often to poll GitHub (minimum 10) |
| `staleThresholdHours` | 4 | Hours before a PR is considered stale |
| `requiredApprovals` | 1 | Number of approvals needed before auto-merge |
| `mergeStrategy` | "squash" | Merge method: squash, merge, or rebase |
| `dryRun` | false | Log actions without executing them |
| `reviews.ignoreUsers` | [] | GitHub usernames whose reviews are ignored |
| `reviews.botUsers` | [] | GitHub usernames that are bots (for logging only — bot reviews are processed identically to human reviews) |
| `checks.requiredChecks` | [] | If set, only these checks must pass. If empty, all non-skipped checks must pass |
| `checks.ignoreChecks` | [] | Check names to ignore when evaluating CI |
| `notifications.webhookUrl` | null | Incoming webhook URL for chat notifications |
| `reviewInbox.enabled` | false | Enable review assignment detection |
| `reviewInbox.githubUser` | null | GitHub username to watch for review requests |
| `reviewInbox.notifyAgent` | null | Conductor agent codename to notify on new assignments |
| `reviewInbox.notifyPane` | null | Tmux pane to notify (alternative to conductor) |
| `reviewInbox.ignoreRepos` | [] | Repos to exclude from review inbox |
| `reviewInbox.ignoreDrafts` | true | Skip draft PRs |

## CLI Commands

```bash
pr-shepherd start [options]       # Start the polling daemon
  --dry-run                       # Log without executing
  --interval <seconds>            # Override poll interval
  -c, --config <path>             # Config file path

pr-shepherd add <url> [options]   # Track a PR
  -w, --worker <name>             # Worker agent name
  --channel <channel>             # Chat channel override
  -c, --config <path>

pr-shepherd list [options]        # Show tracked PRs
  -c, --config <path>

pr-shepherd remove <number>       # Stop tracking a PR
  -r, --repo <repo>               # Repository (owner/repo)
  -c, --config <path>

pr-shepherd events [options]      # Show event log
  --pr <number>                   # Filter by PR
  --repo <repo>                   # Filter by repo
  -n, --last <count>              # Last N events
  -c, --config <path>

pr-shepherd inbox [options]      # Show pending review assignments
  -c, --config <path>
```

## Architecture

### State Machine

Each tracked PR moves through these states:

```
OPENED → CI_PENDING → CI_PASSED → AWAITING_REVIEW → APPROVED → AUTO_MERGE_ENABLED → MERGED
                    → CI_FAILED → (worker fixes) → CI_PENDING (loop)
                                                  → CHANGES_REQUESTED → (worker fixes) → CI_PENDING (loop)
                                                  → STALE → (re-request reviews) → AWAITING_REVIEW
```

Terminal states: `MERGED`, `CLOSED` (reachable from any non-terminal state).

### Event Log

All state transitions are recorded in `data/pr-events.jsonl` (one JSON object per line):

```json
{"ts":"2026-06-15T12:03:00Z","pr":123,"repo":"org/repo","event":"ci_failed","from":"CI_PENDING","to":"CI_FAILED","details":{"failedChecks":["lint"]}}
```

### Project Structure

```
pr-shepherd/
├── src/
│   ├── index.ts            CLI entry point
│   ├── daemon.ts            Polling daemon
│   ├── shepherd.ts          Event handler
│   ├── state-machine.ts     State transitions
│   ├── github.ts            GitHub CLI wrapper
│   ├── notifications.ts     tmux + webhook notifications
│   ├── review-inbox.ts      Review assignment detection
│   ├── tracking.ts          PR tracking file I/O
│   ├── events.ts            Event log I/O
│   ├── config.ts            Configuration loader
│   └── types.ts             Type definitions
├── test/                    Vitest test suite
├── config/
│   ├── shepherd.example.json
│   └── system-prompt.txt    Shepherd agent prompt
└── data/                    Runtime state (gitignored)
```

## Integration with Agent Orchestrators

PR Shepherd integrates with agent orchestration systems (like [Agent Conductor](https://github.com/your-org/agent-conductor)) via two mechanisms:

1. **Conductor MCP** — set `PR_SHEPHERD_CONDUCTOR_URL` to the conductor's MCP server URL. The shepherd uses `send_to_agent` to message worker agents by codename.

2. **tmux direct** — without a conductor, the shepherd types messages directly into worker agents' tmux panes.

### Worker Registration

When a worker agent opens a PR, it registers it:

```bash
pr-shepherd add https://github.com/org/repo/pull/123 --worker worker-1
```

Or programmatically by appending to `data/pr-tracking.json`:

```json
{
  "number": 123,
  "repo": "org/repo",
  "worker": "worker-1",
  "channel": null,
  "state": "OPENED",
  "headSha": null,
  "addedAt": "2026-06-15T12:00:00Z",
  "lastCheckedAt": null,
  "lastEventAt": null
}
```

## Development

```bash
npm install
npm test              # Run test suite
npm run typecheck     # TypeScript checking
npm run dev -- start  # Run daemon via tsx (no build needed)
```

## License

MIT
