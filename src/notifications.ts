import { execFileSync } from "node:child_process";
import type { ShepherdConfig } from "./types.js";

export function notifyShepherdPane(
  pane: string,
  message: string,
): void {
  execFileSync("tmux", ["send-keys", "-t", pane, message, "Enter"], {
    timeout: 5_000,
  });
}

export async function postWebhook(
  url: string,
  text: string,
  channel?: string | null,
): Promise<void> {
  const payload: Record<string, string> = { text };
  if (channel) payload.channel = channel;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(
      `Webhook POST failed: ${response.status} ${response.statusText}`,
    );
  }
}

export async function sendToWorker(
  worker: string,
  message: string,
  config: ShepherdConfig,
): Promise<void> {
  if (config.agent.conductorUrl) {
    await sendViaConductor(config.agent.conductorUrl, worker, message);
    return;
  }
  notifyShepherdPane(worker, message);
}

async function sendViaConductor(
  conductorUrl: string,
  targetAgent: string,
  message: string,
): Promise<void> {
  const url = `${conductorUrl}/mcp/pr-shepherd`;
  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: {
      name: "send_to_agent",
      arguments: {
        codename: targetAgent,
        message,
      },
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `Conductor send failed: ${response.status} ${response.statusText}`,
    );
  }
}

export function formatCIFailureMessage(
  prNumber: number,
  repo: string,
  failedChecks: string[],
): string {
  const lines = [
    `[PR Shepherd] PR #${prNumber} (${repo}) — CI Failed`,
    "",
    "The following checks failed:",
    "",
    ...failedChecks.map((c) => `- ${c}`),
    "",
    "Please investigate and push a fix. I'll monitor CI on the next push.",
  ];
  return lines.join("\n");
}

export function formatReviewMessage(
  prNumber: number,
  repo: string,
  reviewer: string,
  state: string,
  body: string,
): string {
  const action =
    state === "CHANGES_REQUESTED" ? "Changes Requested" : "Review Comment";
  const lines = [
    `[PR Shepherd] PR #${prNumber} (${repo}) — ${action}`,
    "",
    `Reviewer: ${reviewer}`,
    "",
    body,
    "",
    state === "CHANGES_REQUESTED"
      ? "Please address the feedback and push a fix."
      : "FYI — review comment posted.",
  ];
  return lines.join("\n");
}

export function formatMergeMessage(
  prNumber: number,
  repo: string,
): string {
  return `[PR Shepherd] PR #${prNumber} (${repo}) — Merged successfully.`;
}

export function formatStaleMessage(
  prNumber: number,
  repo: string,
  hoursStale: number,
): string {
  return `PR #${prNumber} in ${repo} has been awaiting review for ${hoursStale}h. Requesting reviews.`;
}

export function formatApprovalMessage(
  prNumber: number,
  repo: string,
  approvals: number,
): string {
  return `[PR Shepherd] PR #${prNumber} (${repo}) — Approved (${approvals} approval${approvals !== 1 ? "s" : ""}). Enabling auto-merge.`;
}
