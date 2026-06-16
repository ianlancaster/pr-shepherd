import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TrackedPR, PRState } from "./types.js";

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function trackingPath(dataDir: string): string {
  return join(dataDir, "pr-tracking.json");
}

export function readTracking(dataDir: string): TrackedPR[] {
  const path = trackingPath(dataDir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw) as TrackedPR[];
  } catch {
    console.error(`[pr-shepherd] Corrupt tracking file at ${path}, treating as empty`);
    return [];
  }
}

export function writeTracking(dataDir: string, prs: TrackedPR[]): void {
  const path = trackingPath(dataDir);
  ensureDir(path);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(prs, null, 2) + "\n");
  renameSync(tmp, path);
}

export function addPR(dataDir: string, pr: TrackedPR): void {
  const prs = readTracking(dataDir);
  const existing = prs.find(
    (p) => p.number === pr.number && p.repo === pr.repo,
  );
  if (existing) {
    throw new Error(
      `PR #${pr.number} in ${pr.repo} is already tracked (state: ${existing.state})`,
    );
  }
  prs.push(pr);
  writeTracking(dataDir, prs);
}

export function removePR(
  dataDir: string,
  number: number,
  repo: string,
): TrackedPR | null {
  const prs = readTracking(dataDir);
  const idx = prs.findIndex((p) => p.number === number && p.repo === repo);
  if (idx === -1) return null;
  const [removed] = prs.splice(idx, 1);
  writeTracking(dataDir, prs);
  return removed;
}

export function updatePRState(
  dataDir: string,
  number: number,
  repo: string,
  updates: Partial<Pick<TrackedPR, "state" | "headSha" | "lastCheckedAt" | "lastEventAt">>,
): TrackedPR | null {
  const prs = readTracking(dataDir);
  const pr = prs.find((p) => p.number === number && p.repo === repo);
  if (!pr) return null;
  Object.assign(pr, updates);
  writeTracking(dataDir, prs);
  return pr;
}

export function findPR(
  dataDir: string,
  number: number,
  repo: string,
): TrackedPR | null {
  const prs = readTracking(dataDir);
  return prs.find((p) => p.number === number && p.repo === repo) ?? null;
}
