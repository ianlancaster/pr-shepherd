import { describe, it, expect } from "vitest";
import { parseEventMessage } from "../src/shepherd.js";

describe("shepherd", () => {
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
