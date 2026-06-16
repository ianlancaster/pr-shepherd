import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendEvent, readEvents, readEventsForPR } from "../src/events.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PREventRecord } from "../src/types.js";

const TMP = join(import.meta.dirname, "__tmp_events");

function makeEvent(overrides?: Partial<PREventRecord>): PREventRecord {
  return {
    ts: "2026-01-01T00:00:00Z",
    pr: 42,
    repo: "acme/widgets",
    event: "ci_passed",
    from: "CI_PENDING",
    to: "CI_PASSED",
    details: {},
    ...overrides,
  };
}

describe("events", () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("returns empty array when no event file exists", () => {
    expect(readEvents(TMP)).toEqual([]);
  });

  it("appends and reads events", () => {
    appendEvent(TMP, makeEvent());
    appendEvent(TMP, makeEvent({ event: "ci_failed", to: "CI_FAILED" }));
    const events = readEvents(TMP);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("ci_passed");
    expect(events[1].event).toBe("ci_failed");
  });

  it("readEventsForPR filters by PR number", () => {
    appendEvent(TMP, makeEvent({ pr: 42 }));
    appendEvent(TMP, makeEvent({ pr: 43 }));
    appendEvent(TMP, makeEvent({ pr: 42, event: "ci_failed" }));
    const events = readEventsForPR(TMP, 42);
    expect(events).toHaveLength(2);
  });

  it("readEventsForPR filters by PR number and repo", () => {
    appendEvent(TMP, makeEvent({ pr: 42, repo: "acme/widgets" }));
    appendEvent(TMP, makeEvent({ pr: 42, repo: "acme/other" }));
    const events = readEventsForPR(TMP, 42, "acme/widgets");
    expect(events).toHaveLength(1);
    expect(events[0].repo).toBe("acme/widgets");
  });

  it("handles event details", () => {
    appendEvent(
      TMP,
      makeEvent({
        details: { failedChecks: ["lint", "test-suite (1)"] },
      }),
    );
    const events = readEvents(TMP);
    expect(events[0].details).toEqual({
      failedChecks: ["lint", "test-suite (1)"],
    });
  });
});
