#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig } from "./config.js";
import { startDaemon } from "./daemon.js";
import { addPR, readTracking, removePR } from "./tracking.js";
import { readEvents, readEventsForPR } from "./events.js";
import { readInbox } from "./review-inbox.js";
import type { TrackedPR } from "./types.js";

const program = new Command();

program
  .name("pr-shepherd")
  .description("Automated PR lifecycle management for AI coding agents")
  .version("0.1.0");

program
  .command("start")
  .description("Start the polling daemon")
  .option("-c, --config <path>", "Path to shepherd.config.json")
  .option("--dry-run", "Log actions without executing them")
  .option("--interval <seconds>", "Poll interval in seconds", parseInt)
  .action((opts) => {
    const overrides: Record<string, unknown> = {};
    if (opts.dryRun) overrides.dryRun = true;
    if (opts.interval) overrides.pollIntervalSeconds = opts.interval;

    const config = loadConfig(opts.config, overrides);
    startDaemon(config);
  });

program
  .command("add <url>")
  .description("Track a PR by URL (e.g. https://github.com/owner/repo/pull/123)")
  .option("-w, --worker <name>", "Worker agent codename or tmux pane name")
  .option("-c, --config <path>", "Path to shepherd.config.json")
  .option("--channel <channel>", "Chat channel for notifications")
  .action((url: string, opts) => {
    const config = loadConfig(opts.config);
    const parsed = parsePRUrl(url);
    if (!parsed) {
      console.error(
        "Invalid PR URL. Expected format: https://github.com/owner/repo/pull/123",
      );
      process.exit(1);
    }

    const pr: TrackedPR = {
      number: parsed.number,
      repo: parsed.repo,
      worker: opts.worker ?? "default",
      channel: opts.channel ?? config.notifications.channel ?? null,
      state: "OPENED",
      headSha: null,
      addedAt: new Date().toISOString(),
      lastCheckedAt: null,
      lastEventAt: null,
    };

    addPR(config.dataDir, pr);
    console.log(`Tracking PR #${pr.number} in ${pr.repo} (worker: ${pr.worker})`);
  });

program
  .command("list")
  .description("List tracked PRs")
  .option("-c, --config <path>", "Path to shepherd.config.json")
  .action((opts) => {
    const config = loadConfig(opts.config);
    const prs = readTracking(config.dataDir);

    if (prs.length === 0) {
      console.log("No tracked PRs.");
      return;
    }

    console.log(`\n${"PR".padEnd(8)} ${"Repo".padEnd(30)} ${"State".padEnd(22)} ${"Worker".padEnd(15)} Added`);
    console.log("-".repeat(95));
    for (const pr of prs) {
      console.log(
        `#${String(pr.number).padEnd(7)} ${pr.repo.padEnd(30)} ${pr.state.padEnd(22)} ${pr.worker.padEnd(15)} ${pr.addedAt.slice(0, 10)}`,
      );
    }
    console.log();
  });

program
  .command("remove <number>")
  .description("Stop tracking a PR")
  .option("-r, --repo <repo>", "Repository (owner/repo)")
  .option("-c, --config <path>", "Path to shepherd.config.json")
  .action((number: string, opts) => {
    const config = loadConfig(opts.config);
    const prNumber = parseInt(number, 10);

    const repo =
      opts.repo ?? config.github.defaultRepo;
    if (!repo) {
      console.error(
        "Repository required. Use --repo or set github.defaultRepo in config.",
      );
      process.exit(1);
    }

    const removed = removePR(config.dataDir, prNumber, repo);
    if (removed) {
      console.log(`Removed PR #${prNumber} from ${repo} (was: ${removed.state})`);
    } else {
      console.log(`PR #${prNumber} in ${repo} is not tracked.`);
    }
  });

program
  .command("events")
  .description("Show event log")
  .option("--pr <number>", "Filter by PR number", parseInt)
  .option("--repo <repo>", "Filter by repository")
  .option("-n, --last <count>", "Show last N events", parseInt)
  .option("-c, --config <path>", "Path to shepherd.config.json")
  .action((opts) => {
    const config = loadConfig(opts.config);
    let events = opts.pr
      ? readEventsForPR(config.dataDir, opts.pr, opts.repo)
      : readEvents(config.dataDir);

    if (opts.last) {
      events = events.slice(-opts.last);
    }

    if (events.length === 0) {
      console.log("No events recorded.");
      return;
    }

    console.log(
      `\n${"Time".padEnd(22)} ${"PR".padEnd(8)} ${"Event".padEnd(22)} ${"From".padEnd(22)} → To`,
    );
    console.log("-".repeat(100));
    for (const e of events) {
      console.log(
        `${e.ts.slice(0, 19).padEnd(22)} #${String(e.pr).padEnd(7)} ${e.event.padEnd(22)} ${e.from.padEnd(22)} → ${e.to}`,
      );
    }
    console.log();
  });

program
  .command("inbox")
  .description("Show pending review assignments")
  .option("-c, --config <path>", "Path to shepherd.config.json")
  .action((opts) => {
    const config = loadConfig(opts.config);
    const assignments = readInbox(config.dataDir);

    if (assignments.length === 0) {
      console.log("No pending review assignments.");
      return;
    }

    console.log(
      `\n${"PR".padEnd(8)} ${"Repo".padEnd(30)} ${"Title".padEnd(50)} Notified`,
    );
    console.log("-".repeat(108));
    for (const a of assignments) {
      const title = a.title.length > 48 ? a.title.slice(0, 47) + "…" : a.title;
      console.log(
        `#${String(a.number).padEnd(7)} ${a.repo.padEnd(30)} ${title.padEnd(50)} ${a.notifiedAt.slice(0, 10)}`,
      );
    }
    console.log();
  });

function parsePRUrl(url: string): { repo: string; number: number } | null {
  const match = url.match(
    /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/,
  );
  if (!match) return null;
  return { repo: match[1], number: parseInt(match[2], 10) };
}

program.parse();
