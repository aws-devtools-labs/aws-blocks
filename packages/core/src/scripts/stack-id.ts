// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { BLOCKS_SANDBOX_DIR, LEGACY_BLOCKS_DIR } from '../common/constants.js';
import { migrateLegacySandboxDir } from './migrate-sandbox-dir.js';

interface BlocksConfig {
  stackId?: string;
  [key: string]: unknown;
}

function randomSuffix(length: number): string {
  return randomBytes(length).toString('hex').slice(0, length);
}

/**
 * Get the stackId from `.cdk-blocks/config.json` in the project root, falling back to
 * `.blocks/config.json` for an app that has not renamed its folder.
 * This is the stable project identifier used as the base for CloudFormation stack names.
 */
export function getStackId(projectRoot?: string): string {
  const root = projectRoot || process.cwd();
  const configPath = join(root, '.cdk-blocks', 'config.json');
  const missing = () =>
    new Error(
      `.cdk-blocks/config.json not found or missing stackId — it is created by create-blocks-app and should be committed. ` +
      `To fix manually, create ${configPath} with: { "stackId": "<id>" }. ` +
      `For an app that is already deployed, <id>-prod must be the name of its existing production stack ` +
      `(the stack that cdk-blocks/index.cdk.ts names); any other id makes the next deploy create a second production stack.`
    );
  // An app that has not renamed its folder yet still has a stackId, and the
  // prefix helpers in secret-naming.ts answer an unresolved id with the UNSCOPED
  // `/blocks/secrets` and `/blocks/config` namespaces rather than refusing. Read
  // the pre-rename file so `secret` and `config` stay scoped to this app; when
  // neither file exists the loud error below still stands.
  const legacyPath = join(root, LEGACY_BLOCKS_DIR, 'config.json');

  // Per KEY, not per file. Telemetry's `getProjectId` creates
  // `.cdk-blocks/config.json` holding only a `projectId` on the first tracked
  // command, so choosing the file by existence would then read a file with no
  // `stackId` and throw, and `resolveStackId` in secret-naming.ts swallows that
  // throw and falls back to the UNSCOPED `/blocks/secrets` and `/blocks/config`
  // namespaces without a word. Reading the key from whichever file has it keeps
  // `secret` and `config` scoped to this app for its whole upgrade window.
  const read = (path: string): BlocksConfig | null => {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as BlocksConfig;
    } catch (error) {
      // A file that exists but does not parse is not a missing file: say what is wrong with it.
      if (error instanceof SyntaxError) {
        throw new Error(`${relative(root, path)} is not valid JSON (${error.message}): fix ${path}.`);
      }
      return null;
    }
  };

  const stackId = read(configPath)?.stackId ?? read(legacyPath)?.stackId;
  if (!stackId) throw missing();
  return stackId;
}

/**
 * Get or create a per-machine sandbox identifier.
 * Stored in `.cdk-blocks-sandbox/sandbox-id.txt` (gitignored).
 * Format: `<username(8)>-<random(6)>` — identifies the developer's sandbox.
 *
 * Get-or-create (lazy init): returns the existing id, or generates and persists
 * one on first call. The file is the shared sync point — once written, every
 * later caller and every process reads the same id, so the scripts and synth
 * derive identical names.
 */
export function getSandboxId(projectRoot?: string): string {
  const root = projectRoot || process.cwd();
  // Before the get-or-create below can mint a NEW id: an app upgrading across the
  // directory rename still has its id under the old name (D-031). Minting here
  // would deploy to a different stack and orphan the customer's existing sandbox.
  migrateLegacySandboxDir(root);
  const filePath = join(root, BLOCKS_SANDBOX_DIR, 'sandbox-id.txt');
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
 * This function reads committed config (`.cdk-blocks/config.json`, throws if absent
 * — D-012) and resolves the sandbox id via {@link getSandboxId} (get-or-create):
 * the first caller materializes `.cdk-blocks-sandbox/sandbox-id.txt`, every later
 * caller reads the same value. Because that file persists and is shared across
 * processes, the scripts and synth resolve identical names. Production does not use the sandbox id.
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
