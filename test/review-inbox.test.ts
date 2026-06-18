import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readInbox,
  writeInbox,
  formatReviewAssignmentMessage,
} from "../src/review-inbox.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewAssignment } from "../src/types.js";

const TMP = join(import.meta.dirname, "__tmp_review_inbox");

function makeAssignment(overrides?: Partial<ReviewAssignment>): ReviewAssignment {
  return {
    number: 42,
    repo: "acme/widgets",
    title: "feat: add widget sorting",
    url: "https://github.com/acme/widgets/pull/42",
    detectedAt: "2026-01-01T00:00:00Z",
    notifiedAt: "2026-01-01T00:00:00Z",
    completedAt: null,
    status: "dispatched",
    ...overrides,
  };
}

describe("review-inbox", () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  describe("readInbox / writeInbox", () => {
    it("returns empty array when no file exists", () => {
      expect(readInbox(TMP)).toEqual([]);
    });

    it("round-trips assignments", () => {
      const assignments = [makeAssignment(), makeAssignment({ number: 43 })];
      writeInbox(TMP, assignments);
      expect(readInbox(TMP)).toEqual(assignments);
    });

    it("recovers from corrupt file", () => {
      writeFileSync(join(TMP, "review-inbox.json"), "{{corrupt");
      expect(readInbox(TMP)).toEqual([]);
    });
  });

  describe("formatReviewAssignmentMessage", () => {
    it("formats a review assignment notification", () => {
      const assignment = makeAssignment();
      const msg = formatReviewAssignmentMessage(assignment);

      expect(msg).toContain("[PR Shepherd] Review requested");
      expect(msg).toContain("PR #42");
      expect(msg).toContain("acme/widgets");
      expect(msg).toContain("feat: add widget sorting");
      expect(msg).toContain("https://github.com/acme/widgets/pull/42");
      expect(msg).toContain("dispatch a worker");
    });
  });

  describe("status tracking", () => {
    it("tracks pending_bot_review status", () => {
      const a = makeAssignment({ status: "pending_bot_review", notifiedAt: null });
      writeInbox(TMP, [a]);
      const inbox = readInbox(TMP);
      expect(inbox[0].status).toBe("pending_bot_review");
      expect(inbox[0].notifiedAt).toBeNull();
    });

    it("tracks dispatched status with notifiedAt", () => {
      const a = makeAssignment({ status: "dispatched", notifiedAt: "2026-01-01T00:05:00Z" });
      writeInbox(TMP, [a]);
      const inbox = readInbox(TMP);
      expect(inbox[0].status).toBe("dispatched");
      expect(inbox[0].notifiedAt).toBe("2026-01-01T00:05:00Z");
    });

    it("tracks terminal statuses with completedAt", () => {
      const a = makeAssignment({
        status: "merged_before_review",
        completedAt: "2026-01-01T01:00:00Z",
      });
      writeInbox(TMP, [a]);
      const inbox = readInbox(TMP);
      expect(inbox[0].status).toBe("merged_before_review");
      expect(inbox[0].completedAt).toBe("2026-01-01T01:00:00Z");
    });
  });

  describe("deduplication", () => {
    it("does not re-add existing assignments", () => {
      const existing = [makeAssignment({ number: 42 })];
      writeInbox(TMP, existing);

      const inbox = readInbox(TMP);
      const keys = new Set(inbox.map((a) => `${a.repo}#${a.number}`));
      expect(keys.has("acme/widgets#42")).toBe(true);
      expect(keys.has("acme/widgets#99")).toBe(false);
    });
  });
});
