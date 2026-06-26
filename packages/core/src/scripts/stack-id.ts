// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

interface BlocksConfig {
  stackId?: string;
  [key: string]: unknown;
}

function randomSuffix(length: number): string {
  return randomBytes(length).toString('hex').slice(0, length);
}

/**
 * Get the stackId from `.blocks/config.json` in the project root.
 * This is the stable project identifier used as the base for CloudFormation stack names.
 */
export function getStackId(projectRoot?: string): string {
  const root = projectRoot || process.cwd();
  const configPath = join(root, '.blocks', 'config.json');
  try {
    const config: BlocksConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (!config.stackId) throw new Error('missing key');
    return config.stackId;
  } catch {
    throw new Error(
      `.blocks/config.json not found or missing stackId — it is created by create-blocks-app and should be committed. ` +
      `To fix manually, create ${configPath} with: { "stackId": "<your-app-name>" }`
    );
  }
}

/**
 * Read the per-machine sandbox identifier without creating it.
 * Returns the id if `.blocks-sandbox/sandbox-id.txt` exists, throws otherwise.
 * Use this in pure name-derivation paths that must not mutate the filesystem.
 */
export function readSandboxId(projectRoot?: string): string {
  const root = projectRoot || process.cwd();
  const filePath = join(root, '.blocks-sandbox', 'sandbox-id.txt');
  if (existsSync(filePath)) return readFileSync(filePath, 'utf-8').trim();
  throw new Error(
    `Sandbox id not found at ${filePath} — run \`npm run sandbox\` to initialize it.`,
  );
}

/**
 * Get or create a per-machine sandbox identifier.
 * Stored in `.blocks-sandbox/sandbox-id.txt` (gitignored).
 * Format: `<username(8)>-<random(6)>` — identifies the developer's sandbox.
 *
 * NOTE: This function WRITES the file if absent (side effect). Use only in the
 * sandbox orchestrator. For pure name derivation, use {@link readSandboxId}.
 */
export function getSandboxId(projectRoot?: string): string {
  const root = projectRoot || process.cwd();
  const filePath = join(root, '.blocks-sandbox', 'sandbox-id.txt');
  if (existsSync(filePath)) return readFileSync(filePath, 'utf-8').trim();
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const username = getUsername().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'dev';
  const random = randomSuffix(6);
  const id = `${username}-${random}`;
  writeFileSync(filePath, id);
  return id;
}

/**
 * The full CloudFormation stack name for a deployment.
 *
 * Single source of truth for the stack-name scheme (D-012): production is
 * `<stackId>-prod`; a sandbox is `<stackId>-<sandboxId>`. The CDK templates name
 * the stack with this function, and the external-DB connection-string parameter
 * name (`dbConnectionParameterName`) is derived from it — so a deployed stack and
 * the parameter holding its database credentials can never use divergent names.
 *
 * This function is **pure / read-only**: it reads from committed config
 * (`.blocks/config.json`) and the sandbox id file (`.blocks-sandbox/sandbox-id.txt`)
 * but never creates or writes files. If the sandbox id file is absent, it throws —
 * the sandbox orchestrator is responsible for creating it via {@link getSandboxId}.
 */
export function getStackName(opts: { sandbox: boolean; projectRoot?: string }): string {
  const base = getStackId(opts.projectRoot);
  return opts.sandbox ? `${base}-${readSandboxId(opts.projectRoot)}` : `${base}-prod`;
}

function getUsername(): string {
  try {
    return execSync('git config user.name', { encoding: 'utf-8' }).trim();
  } catch {
    return process.env.USER || process.env.USERNAME || 'user';
  }
}
