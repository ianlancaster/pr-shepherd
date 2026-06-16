import { execFileSync } from "node:child_process";
import {
  fetchPRView,
  fetchChecks,
  fetchReviews,
  parseChecks,
  parseReviews,
  evaluateChecks,
  evaluateReviews,
  enableAutoMerge,
} from "./github.js";
import { readCache, upsertCachedPR, removeCachedPR, getCachedPR } from "./state-cache.js";
import { appendEvent } from "./events.js";
import { transition, isTerminal } from "./state-machine.js";
import { sendToAgent } from "./notifications.js";
import { pollReviewInbox } from "./review-inbox.js";
import {
  formatCIFailureMessage,
  formatReviewMessage,
  formatApprovalMessage,
  formatMergeMessage,
  formatStaleMessage,
} from "./notifications.js";
import type { ShepherdConfig, WatchedPR, PREvent, PRState, PREventRecord } from "./types.js";

type RawSearchResult = {
  number: number;
  repository: { name: string; nameWithOwner: string };
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
};

function now(): string {
  return new Date().toISOString();
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function emitEvent(
  config: ShepherdConfig,
  pr: WatchedPR,
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
}

function tryTransition(
  config: ShepherdConfig,
  pr: WatchedPR,
  event: PREvent,
  details: Record<string, unknown> = {},
): PRState | null {
  const next = transition(pr.state, event);
  if (!next) return null;

  emitEvent(config, pr, event, next, details);
  pr.state = next;
  pr.lastEventAt = now();
  pr.lastCheckedAt = now();
  upsertCachedPR(config.dataDir, pr);
  return next;
}

export function discoverAuthoredPRs(username: string): RawSearchResult[] {
  const json = execFileSync(
    "gh",
    [
      "search",
      "prs",
      `--author=${username}`,
      "--state=open",
      "--json",
      "number,repository,title,url,isDraft,updatedAt",
      "--limit",
      "50",
    ],
    { encoding: "utf-8", timeout: 30_000 },
  ).trim();
  return JSON.parse(json) as RawSearchResult[];
}

async function handleTransition(
  config: ShepherdConfig,
  pr: WatchedPR,
  toState: PRState,
  details: Record<string, unknown>,
): Promise<void> {
  const agent = config.notifications.notifyAgent!;

  try {
    switch (toState) {
      case "CI_FAILED": {
        const failedChecks = (details.failedChecks as string[]) ?? [];
        const msg = formatCIFailureMessage(pr.number, pr.repo, failedChecks);
        if (!config.dryRun) await sendToAgent(config, agent, msg);
        break;
      }
      case "CHANGES_REQUESTED": {
        const reviewer = (details.reviewer as string) ?? "unknown";
        const body = (details.body as string) ?? "";
        const msg = formatReviewMessage(pr.number, pr.repo, reviewer, "CHANGES_REQUESTED", body);
        if (!config.dryRun) await sendToAgent(config, agent, msg);
        break;
      }
      case "APPROVED": {
        const approvals = (details.approvals as number) ?? 0;
        const msg = formatApprovalMessage(pr.number, pr.repo, approvals);
        log(`Enabling auto-merge for PR #${pr.number}`);
        if (!config.dryRun) {
          try {
            enableAutoMerge(pr.number, pr.repo, config.mergeStrategy);
          } catch (err) {
            log(`Failed to enable auto-merge: ${(err as Error).message}`);
          }
          await sendToAgent(config, agent, msg);
        }
        break;
      }
      case "MERGED": {
        const msg = formatMergeMessage(pr.number, pr.repo);
        removeCachedPR(config.dataDir, pr.number, pr.repo);
        if (!config.dryRun) await sendToAgent(config, agent, msg);
        break;
      }
      case "CLOSED": {
        removeCachedPR(config.dataDir, pr.number, pr.repo);
        break;
      }
      case "STALE": {
        const hoursStale = (details.hoursStale as number) ?? 0;
        const msg = formatStaleMessage(pr.number, pr.repo, hoursStale);
        if (!config.dryRun) await sendToAgent(config, agent, msg);
        break;
      }
    }
  } catch (err) {
    log(`Error handling ${toState} for PR #${pr.number}: ${(err as Error).message}`);
  }
}

export async function pollPR(config: ShepherdConfig, pr: WatchedPR): Promise<void> {
  if (isTerminal(pr.state)) return;

  try {
    const prView = fetchPRView(pr.number, pr.repo);
    const rawChecks = fetchChecks(pr.number, pr.repo);
    const rawReviews = fetchReviews(pr.number, pr.repo);

    const checks = parseChecks(rawChecks, config);
    const reviews = parseReviews(rawReviews, config);

    if (prView.state === "MERGED") {
      const prev = pr.state;
      tryTransition(config, pr, "merged");
      await handleTransition(config, pr, "MERGED", {});
      return;
    }

    if (prView.state === "CLOSED") {
      tryTransition(config, pr, "closed");
      await handleTransition(config, pr, "CLOSED", {});
      return;
    }

    if (pr.headSha && prView.headRefOid !== pr.headSha) {
      pr.headSha = prView.headRefOid;
      upsertCachedPR(config.dataDir, pr);
      tryTransition(config, pr, "new_commit");
    }

    if (pr.state === "OPENED") {
      tryTransition(config, pr, "poll_started");
    }

    if (!pr.headSha) {
      pr.headSha = prView.headRefOid;
      upsertCachedPR(config.dataDir, pr);
    }

    if (pr.state === "CI_PENDING") {
      const checkResult = evaluateChecks(checks, config);
      if (checkResult.status === "pass") {
        tryTransition(config, pr, "ci_passed");
      } else if (checkResult.status === "fail") {
        const details = { failedChecks: checkResult.failed };
        tryTransition(config, pr, "ci_failed", details);
        await handleTransition(config, pr, "CI_FAILED", details);
      }
    }

    if (pr.state === "AUTO_MERGE_ENABLED") {
      const checkResult = evaluateChecks(checks, config);
      if (checkResult.status === "fail") {
        const details = { failedChecks: checkResult.failed };
        tryTransition(config, pr, "ci_failed", details);
        await handleTransition(config, pr, "CI_FAILED", details);
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
        const details = { reviewer: reviewer.author, body: reviewer.body };
        tryTransition(config, pr, "changes_requested", details);
        await handleTransition(config, pr, "CHANGES_REQUESTED", details);
      } else if (reviewResult.status === "approved") {
        const details = { approvals: reviewResult.approvals };
        tryTransition(config, pr, "all_approved", details);
        await handleTransition(config, pr, "APPROVED", details);
      } else if (pr.state === "CI_PASSED" && reviews.length > 0) {
        tryTransition(config, pr, "review_posted");
      } else if (pr.state === "AWAITING_REVIEW") {
        const staleHours =
          (Date.now() - new Date(pr.lastEventAt ?? now()).getTime()) /
          (1000 * 60 * 60);
        if (staleHours >= config.staleThresholdHours) {
          const details = { hoursStale: Math.round(staleHours) };
          tryTransition(config, pr, "stale_detected", details);
          await handleTransition(config, pr, "STALE", details);
        }
      }
    }

    pr.lastCheckedAt = now();
    upsertCachedPR(config.dataDir, pr);
  } catch (err) {
    log(`Error polling PR #${pr.number} (${pr.repo}): ${(err as Error).message}`);
  }
}

export async function pollAll(config: ShepherdConfig): Promise<void> {
  const username = config.github.authorUsername!;
  log(`Discovering open PRs by @${username}...`);

  let discovered: RawSearchResult[];
  try {
    discovered = discoverAuthoredPRs(username);
  } catch (err) {
    log(`Error discovering PRs: ${(err as Error).message}`);
    return;
  }

  const openPRs = discovered.filter((pr) => !pr.isDraft);
  log(`Found ${openPRs.length} open non-draft PR(s).`);

  for (const raw of openPRs) {
    const cached = getCachedPR(config.dataDir, raw.number, raw.repository.nameWithOwner);
    const pr: WatchedPR = cached ?? {
      number: raw.number,
      repo: raw.repository.nameWithOwner,
      title: raw.title,
      url: raw.url,
      state: "OPENED",
      headSha: null,
      lastCheckedAt: null,
      lastEventAt: null,
    };

    await pollPR(config, pr);
  }

  // Clean up cached PRs that are no longer in the open set
  const openKeys = new Set(openPRs.map((p) => `${p.repository.nameWithOwner}#${p.number}`));
  const cached = readCache(config.dataDir);
  for (const pr of cached) {
    const key = `${pr.repo}#${pr.number}`;
    if (!openKeys.has(key) && !isTerminal(pr.state)) {
      log(`PR #${pr.number} (${pr.repo}) no longer open — removing from cache.`);
      removeCachedPR(config.dataDir, pr.number, pr.repo);
    }
  }
}

export async function startDaemon(config: ShepherdConfig): Promise<void> {
  log(
    `PR Shepherd daemon starting. Poll interval: ${config.pollIntervalSeconds}s, dry-run: ${config.dryRun}`,
  );
  log(`Watching PRs by @${config.github.authorUsername}`);
  log(`Routing issues to agent: ${config.notifications.notifyAgent}`);
  if (config.reviewInbox.enabled) {
    log(`Review inbox enabled for @${config.reviewInbox.githubUser}`);
  }

  await pollAll(config);
  await pollReviewInbox(config);

  setInterval(async () => {
    await pollAll(config);
    await pollReviewInbox(config);
  }, config.pollIntervalSeconds * 1000);
}
