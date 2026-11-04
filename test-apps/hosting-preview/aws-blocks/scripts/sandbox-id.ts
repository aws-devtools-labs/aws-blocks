// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

function getUsername(): string {
  try {
    return execSync('git config user.name', { encoding: 'utf-8' }).trim();
  } catch {
    return process.env.USER || process.env.USERNAME || 'user';
  }
}

function generateRandomId(): string {
  return Math.random().toString(36).substring(2, 8);
}

export function getSandboxId(projectRoot: string): string {
  const sandboxIdPath = join(projectRoot, '.blocks-sandbox', 'sandbox-id.txt');
  
  if (existsSync(sandboxIdPath)) {
    return readFileSync(sandboxIdPath, 'utf-8').trim();
  }
  
  const username = getUsername().toLowerCase().replace(/[^a-z0-9]/g, '');
  const randomId = generateRandomId();
  const sandboxId = `${username}-${randomId}`;
  
  const dir = join(projectRoot, '.blocks-sandbox');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  writeFileSync(sandboxIdPath, sandboxId);
  
  return sandboxId;
}
