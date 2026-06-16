import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleEvent, parseEventMessage } from "../src/shepherd.js";
import { addPR, readTracking } from "../src/tracking.js";
import { readEvents } from "../src/events.js";
import { DEFAULTS } from "../src/config.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ShepherdConfig, TrackedPR, PREvent, PRState } from "../src/types.js";

const TMP = join(import.meta.dirname, "__tmp_shepherd");

function makeConfig(overrides?: Partial<ShepherdConfig>): ShepherdConfig {
  return {
    ...JSON.parse(JSON.stringify(DEFAULTS)),
    dataDir: TMP,
    dryRun: true,
    ...overrides,
  };
}

function makePR(overrides?: Partial<TrackedPR>): TrackedPR {
  return {
    number: 42,
    repo: "acme/widgets",
    worker: "worker-1",
    channel: null,
    state: "CI_PENDING",
    headSha: "abc123",
    addedAt: "2026-01-01T00:00:00Z",
    lastCheckedAt: null,
    lastEventAt: null,
    ...overrides,
  };
}

function makeEvent(
  event: PREvent,
  from: PRState,
  to: PRState,
  details: Record<string, unknown> = {},
) {
  return { pr: 42, repo: "acme/widgets", event, from, to, details };
}

describe("shepherd", () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  describe("handleEvent", () => {
    it("handles CI failure — does not throw in dry-run", async () => {
      const config = makeConfig();
      addPR(TMP, makePR());

      await expect(
        handleEvent(
          config,
          makeEvent("ci_failed", "CI_PENDING", "CI_FAILED", {
            failedChecks: ["lint", "test-suite (1)"],
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it("handles changes_requested — does not throw in dry-run", async () => {
      const config = makeConfig();
      addPR(TMP, makePR({ state: "AWAITING_REVIEW" }));

      await expect(
        handleEvent(
          config,
          makeEvent("changes_requested", "AWAITING_REVIEW", "CHANGES_REQUESTED", {
            reviewer: "bob",
            body: "Fix the bug",
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it("handles all_approved — does not throw in dry-run", async () => {
      const config = makeConfig();
      addPR(TMP, makePR({ state: "AWAITING_REVIEW" }));

      await expect(
        handleEvent(
          config,
          makeEvent("all_approved", "AWAITING_REVIEW", "APPROVED", {
            approvals: 2,
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it("handles merged — removes PR from tracking", async () => {
      const config = makeConfig();
      addPR(TMP, makePR({ state: "AUTO_MERGE_ENABLED" }));

      await handleEvent(
        config,
        makeEvent("merged", "AUTO_MERGE_ENABLED", "MERGED"),
      );

      const tracked = readTracking(TMP);
      expect(tracked).toHaveLength(0);
    });

    it("handles closed — removes PR from tracking", async () => {
      const config = makeConfig();
      addPR(TMP, makePR({ state: "CI_PENDING" }));

      await handleEvent(
        config,
        makeEvent("closed", "CI_PENDING", "CLOSED"),
      );

      const tracked = readTracking(TMP);
      expect(tracked).toHaveLength(0);
    });

    it("handles stale — does not throw in dry-run", async () => {
      const config = makeConfig();

      await expect(
        handleEvent(
          config,
          makeEvent("stale_detected", "AWAITING_REVIEW", "STALE", {
            hoursStale: 8,
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it("no-ops for unhandled transitions", async () => {
      const config = makeConfig();

      await expect(
        handleEvent(
          config,
          makeEvent("ci_passed", "CI_PENDING", "CI_PASSED"),
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("parseEventMessage", () => {
    it("parses a valid event message", () => {
      const msg =
        '[PR Shepherd Event] {"pr":42,"repo":"acme/widgets","event":"ci_failed","from":"CI_PENDING","to":"CI_FAILED","details":{"failedChecks":["lint"]}}';
      const parsed = parseEventMessage(msg);
      expect(parsed).not.toBeNull();
      expect(parsed!.pr).toBe(42);
      expect(parsed!.event).toBe("ci_failed");
      expect(parsed!.details).toEqual({ failedChecks: ["lint"] });
    });

    it("returns null for non-event messages", () => {
      expect(parseEventMessage("hello world")).toBeNull();
    });

    it("returns null for malformed JSON", () => {
      expect(parseEventMessage("[PR Shepherd Event] {bad json}")).toBeNull();
    });
  });
});
