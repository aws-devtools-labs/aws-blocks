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
 * Read this machine's sandbox identifier **without creating one**, or
 * `undefined` when no sandbox command has ever run in this project.
 *
 * The read-only half of {@link getSandboxId}. A caller that merely wants to
 * *name* an existing sandbox stack — rather than deploy one — must not mint an
 * id: doing so both writes to the project and produces a name for a stack that
 * cannot exist, since a machine with no sandbox id has never deployed a sandbox.
 * `undefined` is the honest answer to "what is this machine's sandbox called",
 * and lets the caller report that nothing is deployed instead.
 */
export function readSandboxId(projectRoot?: string): string | undefined {
	const root = projectRoot || process.cwd();
	const filePath = join(root, '.blocks-sandbox', 'sandbox-id.txt');
	if (!existsSync(filePath)) return undefined;
	return readFileSync(filePath, 'utf-8').trim();
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
 *
 * Pass `sandboxId` to supply an id already in hand. That is how a READ-ONLY
 * caller — one naming an existing stack rather than deploying one — reaches this
 * naming scheme without the get-or-create write: it resolves the id with
 * {@link readSandboxId} first and decides for itself what an absent one means.
 */
export function getStackName(opts: { sandbox: boolean; projectRoot?: string; sandboxId?: string }): string {
  const base = getStackId(opts.projectRoot);
  if (!opts.sandbox) return `${base}-prod`;
  return `${base}-${opts.sandboxId ?? getSandboxId(opts.projectRoot)}`;
}

function getUsername(): string {
  try {
    return execSync('git config user.name', { encoding: 'utf-8' }).trim();
  } catch {
    return process.env.USER || process.env.USERNAME || 'user';
  }
}
