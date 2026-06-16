import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, DEFAULTS } from "../src/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TMP = join(import.meta.dirname, "__tmp_config");

function writeJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function clearShepherdEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PR_SHEPHERD_")) delete process.env[key];
  }
}

describe("config", () => {
  beforeEach(() => {
    clearShepherdEnv();
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    clearShepherdEnv();
    rmSync(TMP, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", () => {
    const config = loadConfig(join(TMP, "nonexistent.json"));
    expect(config.pollIntervalSeconds).toBe(180);
    expect(config.mergeStrategy).toBe("squash");
    expect(config.requiredApprovals).toBe(1);
    expect(config.dryRun).toBe(false);
    expect(config.github.defaultRepo).toBeNull();
    expect(config.notifications.webhookUrl).toBeNull();
  });

  it("merges file config over defaults", () => {
    const path = join(TMP, "test.json");
    writeJson(path, {
      pollIntervalSeconds: 60,
      github: { defaultRepo: "acme/widgets" },
    });
    const config = loadConfig(path);
    expect(config.pollIntervalSeconds).toBe(60);
    expect(config.github.defaultRepo).toBe("acme/widgets");
    expect(config.mergeStrategy).toBe("squash");
  });

  it("applies env overrides over file config", () => {
    const path = join(TMP, "test.json");
    writeJson(path, { pollIntervalSeconds: 60 });
    process.env.PR_SHEPHERD_POLL_INTERVAL = "30";
    process.env.PR_SHEPHERD_WEBHOOK_URL = "https://hooks.example.com/test";
    const config = loadConfig(path);
    expect(config.pollIntervalSeconds).toBe(30);
    expect(config.notifications.webhookUrl).toBe(
      "https://hooks.example.com/test",
    );
  });

  it("applies CLI overrides last", () => {
    const path = join(TMP, "test.json");
    writeJson(path, { pollIntervalSeconds: 60 });
    process.env.PR_SHEPHERD_POLL_INTERVAL = "30";
    const config = loadConfig(path, { pollIntervalSeconds: 15 });
    expect(config.pollIntervalSeconds).toBe(15);
  });

  it("validates pollIntervalSeconds >= 10", () => {
    expect(() =>
      loadConfig(undefined, { pollIntervalSeconds: 5 }),
    ).toThrowError("pollIntervalSeconds must be >= 10");
  });

  it("validates mergeStrategy", () => {
    expect(() =>
      loadConfig(undefined, { mergeStrategy: "yolo" as never }),
    ).toThrowError("mergeStrategy must be one of");
  });

  it("validates requiredApprovals >= 0", () => {
    expect(() =>
      loadConfig(undefined, { requiredApprovals: -1 }),
    ).toThrowError("requiredApprovals must be >= 0");
  });

  it("handles PR_SHEPHERD_DRY_RUN env var", () => {
    process.env.PR_SHEPHERD_DRY_RUN = "true";
    const config = loadConfig(join(TMP, "nonexistent.json"));
    expect(config.dryRun).toBe(true);
  });

  it("handles PR_SHEPHERD_DEFAULT_REPO env var", () => {
    process.env.PR_SHEPHERD_DEFAULT_REPO = "org/repo";
    const config = loadConfig(join(TMP, "nonexistent.json"));
    expect(config.github.defaultRepo).toBe("org/repo");
  });

  it("deep merges nested objects without clobbering sibling keys", () => {
    const path = join(TMP, "test.json");
    writeJson(path, {
      notifications: { onMerge: false },
    });
    const config = loadConfig(path);
    expect(config.notifications.onMerge).toBe(false);
    expect(config.notifications.onCIFailure).toBe(true);
    expect(config.notifications.webhookUrl).toBeNull();
  });

  it("validates reviewInbox requires githubUser when enabled", () => {
    expect(() =>
      loadConfig(undefined, {
        reviewInbox: {
          enabled: true,
          githubUser: null,
          notifyAgent: "my-assistant",
          notifyPane: null,
          ignoreRepos: [],
          ignoreDrafts: true,
        },
      }),
    ).toThrowError("reviewInbox.githubUser is required");
  });

  it("validates reviewInbox requires notifyAgent or notifyPane", () => {
    expect(() =>
      loadConfig(undefined, {
        reviewInbox: {
          enabled: true,
          githubUser: "testuser",
          notifyAgent: null,
          notifyPane: null,
          ignoreRepos: [],
          ignoreDrafts: true,
        },
      }),
    ).toThrowError("notifyAgent or notifyPane");
  });

  it("allows reviewInbox when properly configured", () => {
    const config = loadConfig(undefined, {
      reviewInbox: {
        enabled: true,
        githubUser: "testuser",
        notifyAgent: "my-assistant",
        notifyPane: null,
        ignoreRepos: [],
        ignoreDrafts: true,
      },
    });
    expect(config.reviewInbox.enabled).toBe(true);
    expect(config.reviewInbox.githubUser).toBe("testuser");
  });

  it("handles review inbox env vars", () => {
    process.env.PR_SHEPHERD_REVIEW_INBOX_ENABLED = "true";
    process.env.PR_SHEPHERD_REVIEW_INBOX_USER = "testuser";
    process.env.PR_SHEPHERD_REVIEW_INBOX_AGENT = "my-assistant";
    const config = loadConfig(join(TMP, "nonexistent.json"));
    expect(config.reviewInbox.enabled).toBe(true);
    expect(config.reviewInbox.githubUser).toBe("testuser");
    expect(config.reviewInbox.notifyAgent).toBe("my-assistant");
  });
});
