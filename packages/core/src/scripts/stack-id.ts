// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readBlocksConfigFile } from '../blocks-config-file.js';

function randomSuffix(length: number): string {
  return randomBytes(length).toString('hex').slice(0, length);
}

/**
 * Read the `stackId` from `.blocks/config.json` in the project root, or `undefined`
 * when the file is missing or has no non-empty string `stackId`. A UTF-8 BOM is
 * tolerated.
 *
 * @throws When the file exists but can't be parsed or isn't a JSON object — a
 *   caller must not treat that as "no stackId" and fall back to another name.
 */
export function readStackId(projectRoot?: string): string | undefined {
  const configPath = join(projectRoot || process.cwd(), '.blocks', 'config.json');
  const read = readBlocksConfigFile(configPath);
  if (read.status === 'invalid') {
    throw new Error(
      `.blocks/config.json could not be read: ${read.reason}. Fix ${configPath} so it is a JSON object with a "stackId", ` +
      `e.g. { "stackId": "<your-app-name>" }.`
    );
  }
  if (read.status === 'missing') return undefined;
  const { stackId } = read.config;
  return typeof stackId === 'string' && stackId ? stackId : undefined;
}

/**
 * Get the stackId from `.blocks/config.json` in the project root.
 * This is the stable project identifier used as the base for CloudFormation stack names.
 */
export function getStackId(projectRoot?: string): string {
  const stackId = readStackId(projectRoot);
  if (stackId) return stackId;
  const configPath = join(projectRoot || process.cwd(), '.blocks', 'config.json');
  throw new Error(
    `.blocks/config.json not found or missing stackId — it is created by create-blocks-app and should be committed. ` +
    `To fix manually, create ${configPath} with: { "stackId": "<id>" }. ` +
    `For an app that is already deployed, <id>-prod must be the name of its existing production stack ` +
    `(the stack that aws-blocks/index.cdk.ts names); any other id makes the next deploy create a second production stack.`
  );
}

/**
 * Get or create a per-machine sandbox identifier.
 * Stored in `.blocks-sandbox/sandbox-id.txt` (gitignored).
 * Format: `<username(8)>-<random(6)>` — identifies the developer's sandbox.
 *
 * Get-or-create (lazy init): returns the existing id, or generates and persists
 * one on first call. The file is the shared sync point — once written, every
 * later caller and every process reads the same id, so the secret writer
 * (`ensureSecrets`) and synth derive identical names.
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
 * This function reads committed config (`.blocks/config.json`, throws if absent
 * — D-012) and resolves the sandbox id via {@link getSandboxId} (get-or-create):
 * the first caller materializes `.blocks-sandbox/sandbox-id.txt`, every later
 * caller reads the same value. Because that file persists and is shared across
 * processes, the secret writer (`ensureSecrets`) and synth resolve identical
 * names. Production does not use the sandbox id.
 */
export function getStackName(opts: { sandbox: boolean; projectRoot?: string }): string {
  const base = getStackId(opts.projectRoot);
  return opts.sandbox ? `${base}-${getSandboxId(opts.projectRoot)}` : `${base}-prod`;
}

function getUsername(): string {
  try {
    return execSync('git config user.name', { encoding: 'utf-8' }).trim();
  } catch {
    return process.env.USER || process.env.USERNAME || 'user';
  }
}
