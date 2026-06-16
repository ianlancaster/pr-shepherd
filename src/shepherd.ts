import type { PREvent, PRState } from "./types.js";

export type IncomingEvent = {
  pr: number;
  repo: string;
  event: PREvent;
  from: PRState;
  to: PRState;
  details: Record<string, unknown>;
};

export function parseEventMessage(raw: string): IncomingEvent | null {
  const prefix = "[PR Shepherd Event] ";
  if (!raw.startsWith(prefix)) return null;
  try {
    const json = raw.slice(prefix.length);
    return JSON.parse(json) as IncomingEvent;
  } catch {
    return null;
  }
}
