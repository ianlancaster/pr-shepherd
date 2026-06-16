import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PREventRecord } from "./types.js";

function eventsPath(dataDir: string): string {
  return join(dataDir, "pr-events.jsonl");
}

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function appendEvent(dataDir: string, event: PREventRecord): void {
  const path = eventsPath(dataDir);
  ensureDir(path);
  appendFileSync(path, JSON.stringify(event) + "\n");
}

export function readEvents(dataDir: string): PREventRecord[] {
  const path = eventsPath(dataDir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as PREventRecord];
    } catch {
      return [];
    }
  });
}

export function readEventsForPR(
  dataDir: string,
  prNumber: number,
  repo?: string,
): PREventRecord[] {
  return readEvents(dataDir).filter(
    (e) => e.pr === prNumber && (!repo || e.repo === repo),
  );
}
