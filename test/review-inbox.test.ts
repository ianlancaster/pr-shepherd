import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readInbox,
  writeInbox,
  formatReviewAssignmentMessage,
} from "../src/review-inbox.js";
import { readEvents } from "../src/events.js";
import { DEFAULTS } from "../src/config.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShepherdConfig, ReviewAssignment } from "../src/types.js";

const TMP = join(import.meta.dirname, "__tmp_review_inbox");

function makeConfig(overrides?: Partial<ShepherdConfig>): ShepherdConfig {
  return {
    ...JSON.parse(JSON.stringify(DEFAULTS)),
    dataDir: TMP,
    dryRun: true,
    ...overrides,
  };
}

function makeAssignment(overrides?: Partial<ReviewAssignment>): ReviewAssignment {
  return {
    number: 42,
    repo: "acme/widgets",
    title: "feat: add widget sorting",
    url: "https://github.com/acme/widgets/pull/42",
    notifiedAt: "2026-01-01T00:00:00Z",
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

    it("includes the full title in quotes", () => {
      const assignment = makeAssignment({
        title: 'fix(auth): handle edge case in "OAuth flow"',
      });
      const msg = formatReviewAssignmentMessage(assignment);
      expect(msg).toContain('"fix(auth): handle edge case in "OAuth flow""');
    });
  });

  describe("deduplication", () => {
    it("does not re-notify for existing assignments", () => {
      const existing = [makeAssignment({ number: 42 })];
      writeInbox(TMP, existing);

      const inbox = readInbox(TMP);
      const keys = new Set(inbox.map((a) => `${a.repo}#${a.number}`));
      expect(keys.has("acme/widgets#42")).toBe(true);
      expect(keys.has("acme/widgets#99")).toBe(false);
    });
  });
});
