import type { ShepherdConfig } from "./types.js";

export async function sendToAgent(
  config: ShepherdConfig,
  targetAgent: string,
  message: string,
): Promise<void> {
  if (!config.agent.conductorUrl) {
    console.log(`[pr-shepherd] No conductor URL — would send to ${targetAgent}:\n${message}`);
    return;
  }

  const url = `${config.agent.conductorUrl}/mcp/pr-shepherd`;
  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: {
      name: "send_to_agent",
      arguments: { codename: targetAgent, message },
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `Conductor send to ${targetAgent} failed: ${response.status} ${response.statusText}`,
    );
  }
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

export function formatCIFailureMessage(
  prNumber: number,
  repo: string,
  failedChecks: string[],
): string {
  return [
    `[PR Shepherd] PR #${prNumber} (${repo}) — CI Failed`,
    "",
    "The following checks failed:",
    "",
    ...failedChecks.map((c) => `- ${c}`),
    "",
    "Please investigate and push a fix. I'll monitor CI on the next push.",
  ].join("\n");
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
  return [
    `[PR Shepherd] PR #${prNumber} (${repo}) — ${action}`,
    "",
    `Reviewer: ${reviewer}`,
    "",
    body,
    "",
    state === "CHANGES_REQUESTED"
      ? "Please address the feedback and push a fix."
      : "FYI — review comment posted.",
  ].join("\n");
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
  return `[PR Shepherd] PR #${prNumber} (${repo}) has been awaiting review for ${hoursStale}h. Please follow up on reviews.`;
}

export function formatApprovalMessage(
  prNumber: number,
  repo: string,
  approvals: number,
): string {
  return `[PR Shepherd] PR #${prNumber} (${repo}) — Approved (${approvals} approval${approvals !== 1 ? "s" : ""}). Enabling auto-merge.`;
}
