import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { sendToAgent } from "./notifications.js";
import { appendEvent } from "./events.js";
import type { ShepherdConfig, ReviewAssignment, PREventRecord } from "./types.js";

type RawSearchResult = {
  number: number;
  repository: { name: string; nameWithOwner: string };
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
};

function inboxPath(dataDir: string): string {
  return join(dataDir, "review-inbox.json");
}

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [review-inbox] ${msg}`);
}

export function readInbox(dataDir: string): ReviewAssignment[] {
  const path = inboxPath(dataDir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw) as ReviewAssignment[];
  } catch {
    console.error(`[pr-shepherd] Corrupt review inbox at ${path}, treating as empty`);
    return [];
  }
}

export function writeInbox(dataDir: string, assignments: ReviewAssignment[]): void {
  const path = inboxPath(dataDir);
  ensureDir(path);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(assignments, null, 2) + "\n");
  renameSync(tmp, path);
}

function inboxKey(number: number, repo: string): string {
  return `${repo}#${number}`;
}

export function hasUserReviewed(number: number, repo: string, githubUser: string): boolean {
  try {
    const json = execFileSync(
      "gh",
      ["pr", "view", String(number), "-R", repo, "--json", "reviews"],
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();
    const { reviews } = JSON.parse(json) as {
      reviews: Array<{ author: { login: string }; state: string }>;
    };
    return reviews.some(
      (r) => r.author.login.toLowerCase() === githubUser.toLowerCase(),
    );
  } catch {
    return false;
  }
}

export function fetchReviewRequests(githubUser: string): RawSearchResult[] {
  const json = execFileSync(
    "gh",
    [
      "search",
      "prs",
      `--review-requested=${githubUser}`,
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

export async function pollReviewInbox(config: ShepherdConfig): Promise<void> {
  if (!config.reviewInbox.enabled || !config.reviewInbox.githubUser) return;

  try {
    const results = fetchReviewRequests(config.reviewInbox.githubUser);
    const existing = readInbox(config.dataDir);
    const notifiedKeys = new Set(existing.map((a) => inboxKey(a.number, a.repo)));

    let newAssignments: ReviewAssignment[] = [];

    const maxAgeMs = config.reviewInbox.maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAgeMs;

    for (const pr of results) {
      if (config.reviewInbox.ignoreDrafts && pr.isDraft) continue;
      if (config.reviewInbox.ignoreRepos.includes(pr.repository.nameWithOwner)) continue;
      if (new Date(pr.updatedAt).getTime() < cutoff) continue;

      const key = inboxKey(pr.number, pr.repository.nameWithOwner);
      if (notifiedKeys.has(key)) continue;
      if (hasUserReviewed(pr.number, pr.repository.nameWithOwner, config.reviewInbox.githubUser!)) {
        log(`Skipping PR #${pr.number} (${pr.repository.nameWithOwner}) — already reviewed`);
        continue;
      }

      const assignment: ReviewAssignment = {
        number: pr.number,
        repo: pr.repository.nameWithOwner,
        title: pr.title,
        url: pr.url,
        notifiedAt: new Date().toISOString(),
      };

      newAssignments.push(assignment);
    }

    if (newAssignments.length === 0) {
      log("No new review assignments.");
      return;
    }

    log(`Found ${newAssignments.length} new review assignment(s).`);

    for (const assignment of newAssignments) {
      const message = formatReviewAssignmentMessage(assignment);

      if (!config.dryRun) {
        await notifyReviewAssignment(config, message);
      }

      log(`Notified: PR #${assignment.number} (${assignment.repo}) — ${assignment.title}`);

      const event: PREventRecord = {
        ts: assignment.notifiedAt,
        pr: assignment.number,
        repo: assignment.repo,
        event: "review_requested",
        from: "OPENED",
        to: "OPENED",
        details: {
          type: "review_inbox",
          title: assignment.title,
          url: assignment.url,
          notifyAgent: config.reviewInbox.notifyAgent,
        },
      };
      appendEvent(config.dataDir, event);
    }

    writeInbox(config.dataDir, [...existing, ...newAssignments]);

    pruneClosedAssignments(config);
  } catch (err) {
    log(`Error polling review inbox: ${(err as Error).message}`);
  }
}

async function notifyReviewAssignment(config: ShepherdConfig, message: string): Promise<void> {
  const agent = config.reviewInbox.notifyAgent ?? config.notifications.notifyAgent;
  if (!agent) {
    log("No notify agent configured for review inbox");
    return;
  }
  try {
    await sendToAgent(config, agent, message);
  } catch (err) {
    log(`Failed to notify ${agent}: ${(err as Error).message}`);
  }
}

function formatReviewAssignmentMessage(assignment: ReviewAssignment): string {
  return [
    `[PR Shepherd] Review requested: PR #${assignment.number} (${assignment.repo})`,
    `"${assignment.title}"`,
    assignment.url,
    "",
    "You've been requested as a reviewer. Please dispatch a worker to review this PR and prepare a review report.",
  ].join("\n");
}

function pruneClosedAssignments(config: ShepherdConfig): void {
  const assignments = readInbox(config.dataDir);
  if (assignments.length === 0) return;

  const stillOpen: ReviewAssignment[] = [];
  for (const a of assignments) {
    try {
      const json = execFileSync(
        "gh",
        ["pr", "view", String(a.number), "-R", a.repo, "--json", "state"],
        { encoding: "utf-8", timeout: 15_000 },
      ).trim();
      const { state } = JSON.parse(json) as { state: string };
      if (state === "OPEN") {
        stillOpen.push(a);
      } else {
        log(`Pruned closed/merged PR #${a.number} (${a.repo}) from review inbox.`);
      }
    } catch {
      stillOpen.push(a);
    }
  }

  if (stillOpen.length !== assignments.length) {
    writeInbox(config.dataDir, stillOpen);
  }
}

export { formatReviewAssignmentMessage };
