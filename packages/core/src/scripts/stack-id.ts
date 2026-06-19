// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

interface BlocksConfig {
  stackId?: string;
  [key: string]: unknown;
}

/**
 * Get the stackId from `.blocks/config.json` in the project root (cwd).
 * This is the stable project identifier used as the base for CloudFormation stack names.
 */
export function getStackId(): string {
  const configPath = join(process.cwd(), '.blocks', 'config.json');
  const content = readFileSync(configPath, 'utf-8');
  const config: BlocksConfig = JSON.parse(content);
  if (!config.stackId) throw new Error('stackId not found in .blocks/config.json');
  return config.stackId;
}

/**
 * Get or create a per-machine sandbox identifier.
 * Stored in `.blocks-sandbox/sandbox-id` (gitignored).
 * Format: `<username(8)>-<random(4)>` — identifies the developer's sandbox.
 */
export function getSandboxId(): string {
  const filePath = join(process.cwd(), '.blocks-sandbox', 'sandbox-id');
  if (existsSync(filePath)) return readFileSync(filePath, 'utf-8').trim();
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const username = getUsername().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const random = Math.random().toString(36).slice(2, 6);
  const id = `${username}-${random}`;
  writeFileSync(filePath, id);
  return id;
}

function getUsername(): string {
  try {
    return execSync('git config user.name', { encoding: 'utf-8' }).trim();
  } catch {
    return process.env.USER || process.env.USERNAME || 'user';
  }
}
