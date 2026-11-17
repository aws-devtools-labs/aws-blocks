// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared adapter warnings for app features the hosting architecture cannot
 * fulfil. These are **warnings, never errors** — neither feature is widely
 * supported on serverless SSR, and a hard build failure is heavier than
 * warranted when the rest of the app deploys and serves correctly. Each
 * adapter detects the feature its own way (framework config flag,
 * `vercel.json`, etc.) and routes to these helpers for a consistent message.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * Warn that server-side WebSockets won't work on this architecture.
 * CloudFront → API Gateway REST → a request/response Lambda cannot complete a
 * WebSocket upgrade (no persistent socket; the connection silently returns
 * HTTP 200 instead of 101). `detail` names the framework signal that tripped
 * it (e.g. "Nitro `features.websocket: true`").
 *
 * Client-only WebSocket usage (a browser connecting out to a third-party or a
 * dedicated API Gateway WebSocket API) is unaffected — only an SSR app that
 * expects to *serve* the upgrade is.
 */
export const warnUnsupportedWebSocket = (detail: string): void => {
  process.stderr.write(
    `⚠️  ${detail} — WebSocket upgrades are not supported on this hosting architecture: ` +
      `CloudFront → API Gateway REST + a request/response Lambda cannot complete ` +
      `the upgrade (connections silently return HTTP 200, not 101). For realtime, ` +
      `provision an API Gateway WebSocket API separately. Client-only WebSocket ` +
      `usage is unaffected.\n`,
  );
};

/**
 * Warn that scheduled jobs / crons won't fire. The construct wires no general
 * scheduler (EventBridge is used only for the opt-in `compute.warmup`
 * keep-warm ping), so a declared cron silently never runs. `detail` names the
 * source (e.g. "vercel.json declares 2 cron job(s)", "Nitro `scheduledTasks`").
 */
export const warnUnschedulableCron = (detail: string): void => {
  process.stderr.write(
    `⚠️  ${detail}, but the hosting construct wires no scheduler — these will NEVER ` +
      `fire. Provision the schedule separately via AWS EventBridge (or a ` +
      `scheduled CloudWatch rule invoking your endpoint).\n`,
  );
};

/**
 * Warn when `vercel.json` declares crons. Used by frameworks that lack a
 * native cron concept and rely on the Vercel platform scheduler (Next.js,
 * Astro). Best-effort: silent when there's no `vercel.json` or it has no
 * crons; an unparseable file is not our error to surface here.
 */
export const warnIfVercelCron = (projectDir: string): void => {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(projectDir, 'vercel.json'), 'utf-8');
  } catch {
    return; // No vercel.json — nothing to warn about.
  }
  try {
    const parsed = JSON.parse(raw) as { crons?: unknown };
    const crons = parsed.crons;
    if (Array.isArray(crons) && crons.length > 0) {
      warnUnschedulableCron(`vercel.json declares ${crons.length} cron job(s)`);
    }
    
  } catch {
    // Unparseable vercel.json — not our error to surface here.
  }
};
