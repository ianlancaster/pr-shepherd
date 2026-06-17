import { execFileSync } from "node:child_process";
import type { CheckStatus, ReviewData, PRSnapshot, ShepherdConfig } from "./types.js";

type RawCheck = {
  name: string;
  state: string;
  bucket: string;
  workflow: string;
};

type RawReview = {
  author: { login: string };
  state: string;
  body: string;
  submittedAt: string;
};

type RawPRView = {
  number: number;
  state: string;
  reviewDecision: string | null;
  mergeStateStatus: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  autoMergeRequest: { mergeMethod: string } | null;
  mergedAt: string | null;
  closedAt: string | null;
  headRefOid: string;
};

function gh(args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    timeout: 30_000,
  }).trim();
}

export function fetchPRView(number: number, repo: string): RawPRView {
  const json = gh([
    "pr",
    "view",
    String(number),
    "-R",
    repo,
    "--json",
    "number,state,reviewDecision,mergeStateStatus,mergeable,autoMergeRequest,mergedAt,closedAt,headRefOid",
  ]);
  return JSON.parse(json) as RawPRView;
}

export function fetchChecks(number: number, repo: string): RawCheck[] {
  const json = gh([
    "pr",
    "checks",
    String(number),
    "-R",
    repo,
    "--json",
    "name,state,bucket,workflow",
  ]);
  return JSON.parse(json) as RawCheck[];
}

export function fetchReviews(number: number, repo: string): RawReview[] {
  const json = gh([
    "pr",
    "view",
    String(number),
    "-R",
    repo,
    "--json",
    "reviews",
  ]);
  const data = JSON.parse(json) as { reviews: RawReview[] };
  return data.reviews;
}

export function enableAutoMerge(
  number: number,
  repo: string,
  strategy: string,
): void {
  const flag = `--${strategy}`;
  gh(["pr", "merge", String(number), "-R", repo, "--auto", flag]);
}

export function updateBranch(number: number, repo: string): void {
  gh(["pr", "update-branch", String(number), "-R", repo]);
}

export function parseChecks(
  rawChecks: RawCheck[],
  config: ShepherdConfig,
): CheckStatus[] {
  return rawChecks
    .filter((c) => !config.checks.ignoreChecks.includes(c.name))
    .map((c) => ({
      name: c.name,
      state: c.state,
      bucket: c.bucket as CheckStatus["bucket"],
      workflow: c.workflow,
    }));
}

export function parseReviews(
  rawReviews: RawReview[],
  config: ShepherdConfig,
): ReviewData[] {
  return rawReviews
    .filter((r) => !config.reviews.ignoreUsers.includes(r.author.login))
    .map((r) => ({
      author: r.author.login,
      state: r.state as ReviewData["state"],
      body: r.body,
      submittedAt: r.submittedAt,
    }));
}

export function evaluateChecks(checks: CheckStatus[], config: ShepherdConfig): {
  status: "pass" | "fail" | "pending";
  failed: string[];
  pending: string[];
} {
  const relevant =
    config.checks.requiredChecks.length > 0
      ? checks.filter((c) => config.checks.requiredChecks.includes(c.name))
      : checks.filter((c) => c.bucket !== "skipping");

  const failed = relevant
    .filter((c) => c.bucket === "fail" || c.bucket === "cancel")
    .map((c) => c.name);
  const pending = relevant
    .filter((c) => c.bucket === "pending")
    .map((c) => c.name);

  if (failed.length > 0) return { status: "fail", failed, pending };
  if (pending.length > 0) return { status: "pending", failed, pending };
  return { status: "pass", failed, pending };
}

export function evaluateReviews(reviews: ReviewData[], config: ShepherdConfig): {
  status: "approved" | "changes_requested" | "pending";
  approvals: number;
  changesRequested: ReviewData[];
} {
  const latestByAuthor = new Map<string, ReviewData>();
  for (const review of reviews) {
    const existing = latestByAuthor.get(review.author);
    if (!existing || review.submittedAt > existing.submittedAt) {
      latestByAuthor.set(review.author, review);
    }
  }

  const latest = [...latestByAuthor.values()];
  const approvals = latest.filter((r) => r.state === "APPROVED").length;
  const changesRequested = latest.filter(
    (r) => r.state === "CHANGES_REQUESTED",
  );

  if (changesRequested.length > 0) {
    return { status: "changes_requested", approvals, changesRequested };
  }
  if (approvals >= config.requiredApprovals) {
    return { status: "approved", approvals, changesRequested: [] };
  }
  return { status: "pending", approvals, changesRequested: [] };
}

export function buildSnapshot(
  prView: RawPRView,
  checks: CheckStatus[],
  reviews: ReviewData[],
): PRSnapshot {
  return {
    number: prView.number,
    state: prView.state as PRSnapshot["state"],
    reviewDecision: prView.reviewDecision,
    mergeStateStatus: prView.mergeStateStatus,
    autoMergeRequest: prView.autoMergeRequest,
    mergedAt: prView.mergedAt,
    closedAt: prView.closedAt,
    headSha: prView.headRefOid,
    checks,
    reviews,
  };
}
