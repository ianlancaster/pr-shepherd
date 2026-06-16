import {
  fetchPRView,
  fetchChecks,
  fetchReviews,
  parseChecks,
  parseReviews,
  evaluateChecks,
  evaluateReviews,
} from "./github.js";
import { readTracking, updatePRState } from "./tracking.js";
import { appendEvent } from "./events.js";
import { transition, isTerminal } from "./state-machine.js";
import { notifyShepherdPane } from "./notifications.js";
import { pollReviewInbox } from "./review-inbox.js";
import type { ShepherdConfig, TrackedPR, PREvent, PRState, PREventRecord } from "./types.js";

function now(): string {
  return new Date().toISOString();
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function emitEvent(
  config: ShepherdConfig,
  pr: TrackedPR,
  event: PREvent,
  toState: PRState,
  details: Record<string, unknown> = {},
): void {
  const record: PREventRecord = {
    ts: now(),
    pr: pr.number,
    repo: pr.repo,
    event,
    from: pr.state,
    to: toState,
    details,
  };

  appendEvent(config.dataDir, record);
  log(`PR #${pr.number} (${pr.repo}): ${pr.state} → ${toState} [${event}]`);

  if (config.agent.shepherdPane && !config.dryRun) {
    const msg = `[PR Shepherd Event] ${JSON.stringify({ pr: pr.number, repo: pr.repo, event, from: pr.state, to: toState, details })}`;
    try {
      notifyShepherdPane(config.agent.shepherdPane, msg);
    } catch (err) {
      log(`Failed to notify shepherd pane: ${(err as Error).message}`);
    }
  }
}

function tryTransition(
  config: ShepherdConfig,
  pr: TrackedPR,
  event: PREvent,
  details: Record<string, unknown> = {},
): PRState | null {
  const next = transition(pr.state, event);
  if (!next) return null;

  emitEvent(config, pr, event, next, details);
  updatePRState(config.dataDir, pr.number, pr.repo, {
    state: next,
    lastEventAt: now(),
    lastCheckedAt: now(),
  });
  pr.state = next;
  return next;
}

export function pollPR(config: ShepherdConfig, pr: TrackedPR): void {
  if (isTerminal(pr.state)) return;

  try {
    const prView = fetchPRView(pr.number, pr.repo);
    const rawChecks = fetchChecks(pr.number, pr.repo);
    const rawReviews = fetchReviews(pr.number, pr.repo);

    const checks = parseChecks(rawChecks, config);
    const reviews = parseReviews(rawReviews, config);

    if (prView.state === "MERGED") {
      tryTransition(config, pr, "merged");
      return;
    }

    if (prView.state === "CLOSED") {
      tryTransition(config, pr, "closed");
      return;
    }

    if (pr.headSha && prView.headRefOid !== pr.headSha) {
      updatePRState(config.dataDir, pr.number, pr.repo, {
        headSha: prView.headRefOid,
      });
      pr.headSha = prView.headRefOid;
      tryTransition(config, pr, "new_commit");
    }

    if (pr.state === "OPENED") {
      tryTransition(config, pr, "poll_started");
    }

    if (!pr.headSha) {
      updatePRState(config.dataDir, pr.number, pr.repo, {
        headSha: prView.headRefOid,
      });
      pr.headSha = prView.headRefOid;
    }

    if (pr.state === "CI_PENDING") {
      const checkResult = evaluateChecks(checks, config);
      if (checkResult.status === "pass") {
        tryTransition(config, pr, "ci_passed");
      } else if (checkResult.status === "fail") {
        tryTransition(config, pr, "ci_failed", {
          failedChecks: checkResult.failed,
        });
      }
    }

    if (pr.state === "AUTO_MERGE_ENABLED") {
      const checkResult = evaluateChecks(checks, config);
      if (checkResult.status === "fail") {
        tryTransition(config, pr, "ci_failed", {
          failedChecks: checkResult.failed,
        });
      }
    }

    if (
      pr.state === "CI_PASSED" ||
      pr.state === "AWAITING_REVIEW" ||
      pr.state === "STALE"
    ) {
      const reviewResult = evaluateReviews(reviews, config);

      if (reviewResult.status === "changes_requested") {
        const reviewer = reviewResult.changesRequested[0];
        tryTransition(config, pr, "changes_requested", {
          reviewer: reviewer.author,
          body: reviewer.body,
        });
      } else if (reviewResult.status === "approved") {
        tryTransition(config, pr, "all_approved", {
          approvals: reviewResult.approvals,
        });
      } else if (pr.state === "CI_PASSED" && reviews.length > 0) {
        tryTransition(config, pr, "review_posted");
      } else if (pr.state === "AWAITING_REVIEW") {
        const staleHours =
          (Date.now() - new Date(pr.lastEventAt ?? pr.addedAt).getTime()) /
          (1000 * 60 * 60);
        if (staleHours >= config.staleThresholdHours) {
          tryTransition(config, pr, "stale_detected", {
            hoursStale: Math.round(staleHours),
          });
        }
      }
    }

    updatePRState(config.dataDir, pr.number, pr.repo, {
      lastCheckedAt: now(),
    });
  } catch (err) {
    log(`Error polling PR #${pr.number} (${pr.repo}): ${(err as Error).message}`);
  }
}

export function pollAll(config: ShepherdConfig): void {
  const prs = readTracking(config.dataDir);
  const active = prs.filter((pr) => !isTerminal(pr.state));

  if (active.length === 0) {
    log("No active PRs to poll.");
    return;
  }

  log(`Polling ${active.length} active PR(s)...`);
  for (const pr of active) {
    pollPR(config, pr);
  }
}

export function startDaemon(config: ShepherdConfig): void {
  log(
    `PR Shepherd daemon starting. Poll interval: ${config.pollIntervalSeconds}s, dry-run: ${config.dryRun}`,
  );
  log(
    `Tracking file: ${config.dataDir}/pr-tracking.json`,
  );
  if (config.reviewInbox.enabled) {
    log(
      `Review inbox enabled for @${config.reviewInbox.githubUser}`,
    );
  }

  pollAll(config);
  pollReviewInbox(config);

  setInterval(() => {
    pollAll(config);
    pollReviewInbox(config);
  }, config.pollIntervalSeconds * 1000);
}
