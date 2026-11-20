// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LEGACY_BLOCKS_DIR } from '../common/constants.js';

const FIRST_RUN_NOTICE = `
AWS CDK Blocks collects usage data to improve the product. Each event can include:
  random installation and project IDs, and an event ID and timestamp;
  the command, its outcome, duration and error category (never the error message);
  your OS, Node.js version and package manager user agent; whether it ran in CI or under a coding agent;
  the CDK Blocks and CDK versions, the framework, and the template name and version;
  the names and versions of the official Building Blocks the app uses, how many Building Blocks it uses,
  and how many of them are custom (custom Building Block names are never sent).
Events never include names, email addresses, AWS account IDs, ARNs, file paths, file contents or source code.
The collection endpoint also receives your IP address, as with any HTTPS request.
It is not stored, except in logs of requests that the endpoint's firewall blocks.
Events are kept for up to 1 year, and logs of all requests, blocked or not, for up to 10 years.
Telemetry follows your CDK CLI telemetry setting, and CDK Blocks has no separate opt-out.
To opt out of both, run cdk cli-telemetry --disable, or export CDK_DISABLE_CLI_TELEMETRY=1.
CDK documents those settings at
https://docs.aws.amazon.com/cdk/v2/guide/cli-telemetry.html#telemetry-opt-out
`;

interface BlocksConfig {
  telemetry?: { enabled?: boolean; projectId?: string };
  [key: string]: unknown;
}

/**
 * Get or create a persistent installation ID.
 * Stored at `~/.cdk-blocks/telemetry/installation-id`.
 * Generated as UUID v4 on first use.
 *
 * On first creation, prints a one-time notice to stderr informing
 * the user about telemetry collection.
 */
export function getInstallationId(): string {
  const filePath = join(homedir(), '.cdk-blocks', 'telemetry', 'installation-id');

  try {
    const existing = readFileSync(filePath, 'utf-8').trim();
    if (existing) return existing;
  } catch {
    // File doesn't exist yet
  }

  const id = randomUUID();
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, id, 'utf-8');
  } catch {
    // If we can't persist, still return the generated ID for this session
  }
  process.stderr.write(FIRST_RUN_NOTICE + '\n');
  return id;
}

/**
 * Get or create a persistent project ID. Stored in `.cdk-blocks/config.json` under
 * `telemetry.projectId` in the project root (cwd). Generated as UUID v4 on first use.
 */
export function getProjectId(): string {
  const configPath = join(process.cwd(), '.cdk-blocks', 'config.json');
  const legacyPath = join(process.cwd(), LEGACY_BLOCKS_DIR, 'config.json');

  const read = (path: string): BlocksConfig | undefined => {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as BlocksConfig;
    } catch {
      // File doesn't exist or invalid JSON
      return undefined;
    }
  };

  // The pre-rename file is read too, or every upgraded app that has not renamed
  // its folder yet mints a fresh id and is counted as a second project.
  const existing = read(configPath)?.telemetry?.projectId ?? read(legacyPath)?.telemetry?.projectId;
  if (existing) return existing;

  const id = randomUUID();
  // Write to the file the project is already using. Creating
  // `.cdk-blocks/config.json` for a project whose `stackId` still lives in
  // `.blocks/config.json` is what shadowed that key before, and it also makes
  // `git mv .blocks .cdk-blocks` nest the folder instead of renaming it.
  const target = existsSync(configPath) || !existsSync(legacyPath) ? configPath : legacyPath;
  try {
    const dir = dirname(target);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Preserve existing config if present
    const config: BlocksConfig = read(target) ?? {};
    config.telemetry = { ...config.telemetry, projectId: id };
    writeFileSync(target, JSON.stringify(config, null, 2), 'utf-8');
  } catch {
    // If we can't persist, still return the generated ID for this session
  }
  return id;
}

/**
 * Generate a fresh UUID v4 event ID.
 */
export function generateEventId(): string {
  return randomUUID();
}
