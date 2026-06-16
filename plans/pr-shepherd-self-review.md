# midgard-cc-assistant | PR Shepherd — Self-Review Report

## Review Summary

Reviewed all 10 source files in `src/` and 6 test files in `test/`. 123 tests passing, clean typecheck.

## Findings (FIX — all resolved)

### 1. Double-transition bug in polling loop
**File:** `src/daemon.ts:133-163`
**Issue:** When a PR was in `CI_PASSED` and the first review was an approval or change request, `review_posted` fired before the actual review evaluation, causing two state transitions in a single poll cycle (spurious intermediate `AWAITING_REVIEW` state in the event log).
**Fix:** Reordered evaluation: `changes_requested` and `all_approved` are checked first, `review_posted` only fires when reviews exist but no decision has been reached.

### 2. NaN from parseInt on non-numeric env vars
**File:** `src/config.ts:85-93`
**Issue:** `parseInt("abc", 10)` returns `NaN`, which bypassed validation (`NaN < 10` is `false`) and caused `setInterval(fn, NaN * 1000)` to fire with zero delay, potentially hammering GitHub's API.
**Fix:** Added `isNaN` guards after each `parseInt` call on environment variable overrides.

### 3. Uncaught SyntaxError on corrupt tracking/events files
**File:** `src/tracking.ts:14-19`, `src/events.ts:20-26`
**Issue:** `JSON.parse` on a corrupt tracking file threw an uncaught `SyntaxError` that killed the daemon's polling loop permanently. Corrupt JSONL lines in the event log had the same effect on `readEvents`.
**Fix:** Wrapped `JSON.parse` in try/catch in both files. `readTracking` returns empty array on corrupt data. `readEvents` skips corrupt lines with `flatMap`.

### 4. `handleAllApproved` missing PR existence guard
**File:** `src/shepherd.ts:93-120`
**Issue:** Unlike other handlers, `handleAllApproved` did not check if the PR was still tracked before calling `enableAutoMerge`, potentially acting on stale events for manually removed PRs.
**Fix:** Added `findTrackedPR` guard consistent with other handlers.

### 5. Unhandled promise rejections from webhook/notification failures
**File:** `src/shepherd.ts:173-199`
**Issue:** If a webhook URL was unreachable or tmux was unavailable, errors from `postWebhook`/`sendToWorker` propagated as unhandled rejections.
**Fix:** Wrapped the entire `handleEvent` switch body in try/catch, logging errors rather than propagating.

### 6. URL regex accepted malformed hostnames
**File:** `src/index.ts:147-153`
**Issue:** `parsePRUrl` regex had no protocol anchor, so `evil.github.com/owner/repo/pull/123` would match.
**Fix:** Anchored with `^https?:\/\/github\.com\/`.

## Architecture Notes (INFO — no action needed)

- **File I/O amplification:** `updatePRState` does a full read-modify-write on every call. Multiple calls per poll cycle means multiple file reads/writes. Acceptable for the typical workload (< 20 tracked PRs) but would need optimization for scale.
- **`requiredApprovals: 0` behavior:** With zero required approvals, PRs skip `AWAITING_REVIEW` entirely and go `CI_PASSED → APPROVED`. This is by design but worth documenting.
- **No graceful shutdown:** `startDaemon` stores no interval handle and registers no signal handlers. Acceptable for a tmux-background daemon (Ctrl+C or tmux kill works) but could be improved.
- **`execFileSync` used throughout GitHub wrapper:** No shell injection risk (args passed as array, not interpolated), but synchronous execution means the daemon blocks during each `gh` call. For single-digit PR counts this is fine.
