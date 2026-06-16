import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readTracking, writeTracking, addPR, removePR, updatePRState, findPR } from "../src/tracking.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TrackedPR } from "../src/types.js";

const TMP = join(import.meta.dirname, "__tmp_tracking");

function makePR(overrides?: Partial<TrackedPR>): TrackedPR {
  return {
    number: 42,
    repo: "acme/widgets",
    worker: "worker-1",
    channel: null,
    state: "OPENED",
    headSha: null,
    addedAt: "2026-01-01T00:00:00Z",
    lastCheckedAt: null,
    lastEventAt: null,
    ...overrides,
  };
}

describe("tracking", () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("returns empty array when no tracking file exists", () => {
    expect(readTracking(TMP)).toEqual([]);
  });

  it("round-trips tracked PRs through write/read", () => {
    const prs = [makePR(), makePR({ number: 43 })];
    writeTracking(TMP, prs);
    expect(readTracking(TMP)).toEqual(prs);
  });

  it("addPR appends a new PR", () => {
    addPR(TMP, makePR());
    const prs = readTracking(TMP);
    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(42);
  });

  it("addPR throws on duplicate PR in same repo", () => {
    addPR(TMP, makePR());
    expect(() => addPR(TMP, makePR())).toThrowError("already tracked");
  });

  it("addPR allows same number in different repos", () => {
    addPR(TMP, makePR());
    addPR(TMP, makePR({ repo: "acme/other" }));
    expect(readTracking(TMP)).toHaveLength(2);
  });

  it("removePR removes and returns the PR", () => {
    addPR(TMP, makePR());
    addPR(TMP, makePR({ number: 43 }));
    const removed = removePR(TMP, 42, "acme/widgets");
    expect(removed?.number).toBe(42);
    expect(readTracking(TMP)).toHaveLength(1);
  });

  it("removePR returns null for unknown PR", () => {
    expect(removePR(TMP, 999, "acme/widgets")).toBeNull();
  });

  it("updatePRState updates fields and returns updated PR", () => {
    addPR(TMP, makePR());
    const updated = updatePRState(TMP, 42, "acme/widgets", {
      state: "CI_PENDING",
      headSha: "abc123",
      lastCheckedAt: "2026-01-01T00:05:00Z",
    });
    expect(updated?.state).toBe("CI_PENDING");
    expect(updated?.headSha).toBe("abc123");

    const fromDisk = readTracking(TMP);
    expect(fromDisk[0].state).toBe("CI_PENDING");
  });

  it("updatePRState returns null for unknown PR", () => {
    expect(
      updatePRState(TMP, 999, "acme/widgets", { state: "CI_PENDING" }),
    ).toBeNull();
  });

  it("findPR finds a tracked PR", () => {
    addPR(TMP, makePR());
    expect(findPR(TMP, 42, "acme/widgets")?.number).toBe(42);
  });

  it("findPR returns null for unknown PR", () => {
    expect(findPR(TMP, 999, "acme/widgets")).toBeNull();
  });
});
