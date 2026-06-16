import { TERMINAL_STATES } from "./types.js";
import type { PRState, PREvent } from "./types.js";

type TransitionTable = Partial<Record<PREvent, PRState>>;

const transitions: Record<PRState, TransitionTable> = {
  OPENED: {
    poll_started: "CI_PENDING",
    ci_pending: "CI_PENDING",
    closed: "CLOSED",
  },
  CI_PENDING: {
    ci_passed: "CI_PASSED",
    ci_failed: "CI_FAILED",
    ci_pending: "CI_PENDING",
    closed: "CLOSED",
  },
  CI_PASSED: {
    review_posted: "AWAITING_REVIEW",
    all_approved: "APPROVED",
    // No reviews required or all already approved before CI finished
    changes_requested: "CHANGES_REQUESTED",
    closed: "CLOSED",
  },
  CI_FAILED: {
    new_commit: "CI_PENDING",
    ci_pending: "CI_PENDING",
    closed: "CLOSED",
  },
  AWAITING_REVIEW: {
    changes_requested: "CHANGES_REQUESTED",
    all_approved: "APPROVED",
    review_posted: "AWAITING_REVIEW",
    stale_detected: "STALE",
    closed: "CLOSED",
  },
  CHANGES_REQUESTED: {
    new_commit: "CI_PENDING",
    ci_pending: "CI_PENDING",
    closed: "CLOSED",
  },
  APPROVED: {
    auto_merge_enabled: "AUTO_MERGE_ENABLED",
    merged: "MERGED",
    new_commit: "CI_PENDING",
    closed: "CLOSED",
  },
  AUTO_MERGE_ENABLED: {
    merged: "MERGED",
    new_commit: "CI_PENDING",
    ci_failed: "CI_FAILED",
    closed: "CLOSED",
  },
  STALE: {
    review_requested: "AWAITING_REVIEW",
    review_posted: "AWAITING_REVIEW",
    changes_requested: "CHANGES_REQUESTED",
    all_approved: "APPROVED",
    new_commit: "CI_PENDING",
    closed: "CLOSED",
  },
  MERGED: {},
  CLOSED: {},
};

export function transition(
  current: PRState,
  event: PREvent,
): PRState | null {
  if (TERMINAL_STATES.has(current)) return null;
  return transitions[current][event] ?? null;
}

export function isTerminal(state: PRState): boolean {
  return TERMINAL_STATES.has(state);
}

export function validEvents(state: PRState): PREvent[] {
  return Object.keys(transitions[state]) as PREvent[];
}
