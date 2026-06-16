import {
  enableAutoMerge,
  fetchChecks,
  parseChecks,
  evaluateChecks,
} from "./github.js";
import { removePR, readTracking } from "./tracking.js";
import { appendEvent } from "./events.js";
import {
  sendToWorker,
  postWebhook,
  formatCIFailureMessage,
  formatReviewMessage,
  formatMergeMessage,
  formatStaleMessage,
  formatApprovalMessage,
} from "./notifications.js";
import type { ShepherdConfig, PREvent, PRState, PREventRecord, TrackedPR } from "./types.js";

type IncomingEvent = {
  pr: number;
  repo: string;
  event: PREvent;
  from: PRState;
  to: PRState;
  details: Record<string, unknown>;
};

function log(msg: string): void {
  console.log(`[shepherd] ${msg}`);
}

function findTrackedPR(
  config: ShepherdConfig,
  prNumber: number,
  repo: string,
): TrackedPR | null {
  const prs = readTracking(config.dataDir);
  return prs.find((p) => p.number === prNumber && p.repo === repo) ?? null;
}

async function handleCIFailed(
  config: ShepherdConfig,
  event: IncomingEvent,
): Promise<void> {
  const pr = findTrackedPR(config, event.pr, event.repo);
  if (!pr) return;

  const failedChecks = (event.details.failedChecks as string[]) ?? [];
  const message = formatCIFailureMessage(event.pr, event.repo, failedChecks);

  log(`CI failed on PR #${event.pr}: ${failedChecks.join(", ")}`);

  if (!config.dryRun) {
    await sendToWorker(pr.worker, message, config);
  }

  if (config.notifications.onCIFailure && config.notifications.webhookUrl) {
    if (!config.dryRun) {
      await postWebhook(
        config.notifications.webhookUrl,
        message,
        config.notifications.channel,
      );
    }
  }
}

async function handleChangesRequested(
  config: ShepherdConfig,
  event: IncomingEvent,
): Promise<void> {
  const pr = findTrackedPR(config, event.pr, event.repo);
  if (!pr) return;

  const reviewer = (event.details.reviewer as string) ?? "unknown";
  const body = (event.details.body as string) ?? "";
  const message = formatReviewMessage(
    event.pr,
    event.repo,
    reviewer,
    "CHANGES_REQUESTED",
    body,
  );

  log(`Changes requested on PR #${event.pr} by ${reviewer}`);

  if (!config.dryRun) {
    await sendToWorker(pr.worker, message, config);
  }
}

async function handleAllApproved(
  config: ShepherdConfig,
  event: IncomingEvent,
): Promise<void> {
  const pr = findTrackedPR(config, event.pr, event.repo);
  if (!pr) return;

  const approvals = (event.details.approvals as number) ?? 0;
  const message = formatApprovalMessage(event.pr, event.repo, approvals);

  log(`PR #${event.pr} approved with ${approvals} approval(s). Enabling auto-merge.`);

  if (!config.dryRun) {
    try {
      enableAutoMerge(event.pr, event.repo, config.mergeStrategy);
      log(`Auto-merge enabled for PR #${event.pr}`);
    } catch (err) {
      log(`Failed to enable auto-merge: ${(err as Error).message}`);
    }
  }

  if (config.notifications.onApproval && config.notifications.webhookUrl) {
    if (!config.dryRun) {
      await postWebhook(
        config.notifications.webhookUrl,
        message,
        config.notifications.channel,
      );
    }
  }
}

async function handleMerged(
  config: ShepherdConfig,
  event: IncomingEvent,
): Promise<void> {
  const message = formatMergeMessage(event.pr, event.repo);
  log(`PR #${event.pr} merged.`);

  removePR(config.dataDir, event.pr, event.repo);

  if (config.notifications.onMerge && config.notifications.webhookUrl) {
    if (!config.dryRun) {
      await postWebhook(
        config.notifications.webhookUrl,
        message,
        config.notifications.channel,
      );
    }
  }
}

async function handleClosed(
  config: ShepherdConfig,
  event: IncomingEvent,
): Promise<void> {
  log(`PR #${event.pr} closed without merge.`);
  removePR(config.dataDir, event.pr, event.repo);
}

async function handleStale(
  config: ShepherdConfig,
  event: IncomingEvent,
): Promise<void> {
  const hoursStale = (event.details.hoursStale as number) ?? 0;
  const message = formatStaleMessage(event.pr, event.repo, hoursStale);

  log(`PR #${event.pr} is stale (${hoursStale}h). Requesting reviews.`);

  if (config.notifications.onStale && config.notifications.webhookUrl) {
    if (!config.dryRun) {
      await postWebhook(
        config.notifications.webhookUrl,
        message,
        config.notifications.channel,
      );
    }
  }
}

export async function handleEvent(
  config: ShepherdConfig,
  event: IncomingEvent,
): Promise<void> {
  try {
    switch (event.to) {
      case "CI_FAILED":
        await handleCIFailed(config, event);
        break;
      case "CHANGES_REQUESTED":
        await handleChangesRequested(config, event);
        break;
      case "APPROVED":
        await handleAllApproved(config, event);
        break;
      case "MERGED":
        await handleMerged(config, event);
        break;
      case "CLOSED":
        await handleClosed(config, event);
        break;
      case "STALE":
        await handleStale(config, event);
        break;
      default:
        log(`No handler for transition to ${event.to}`);
    }
  } catch (err) {
    log(`Error handling event ${event.event} for PR #${event.pr}: ${(err as Error).message}`);
  }
}

export function parseEventMessage(raw: string): IncomingEvent | null {
  const prefix = "[PR Shepherd Event] ";
  if (!raw.startsWith(prefix)) return null;
  try {
    const json = raw.slice(prefix.length);
    return JSON.parse(json) as IncomingEvent;
  } catch {
    return null;
  }
}
