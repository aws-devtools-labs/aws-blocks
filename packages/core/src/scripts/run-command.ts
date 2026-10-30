// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptions,
  SpawnSyncReturns,
} from 'node:child_process';
import spawn from 'cross-spawn';

// `npm`/`npx`/`cdk`/`tsx` are `.cmd` shims on Windows, which Node's
// execFileSync/spawn can't resolve (spawnSync ENOENT) and won't run without a
// shell. cross-spawn resolves the shim and quotes args safely (array form, no
// shell injection), so these wrappers work on Windows too.

/**
 * Run a command to completion (stdio inherited) and throw on failure — a
 * cross-platform drop-in for `execFileSync` where only success/failure matters.
 */
export function runSync(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): void {
  checkSyncResult(command, args, spawn.sync(command, args, { stdio: 'inherit', ...options }));
}

/**
 * {@link runSync} with stdout and stderr captured instead of printed. On
 * failure the captured output goes to `onFailure` before the error is thrown,
 * so a hidden step stays diagnosable. stdin stays inherited. Output is not
 * size-capped (spawnSync's default 1 MiB `maxBuffer` would fail a chatty but
 * successful run).
 */
export function runSyncRetained(
  command: string,
  args: string[],
  options: Omit<SpawnSyncOptions, 'stdio' | 'encoding' | 'maxBuffer'>,
  onFailure: (stdout: string, stderr: string) => void,
): void {
  const result = spawn.sync(command, args, {
    ...options,
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf-8',
    maxBuffer: Infinity,
  });
  try {
    checkSyncResult(command, args, result);
  } catch (error) {
    onFailure(String(result.stdout ?? ''), String(result.stderr ?? ''));
    throw error;
  }
}

function checkSyncResult(command: string, args: string[], result: SpawnSyncReturns<string | Buffer>): void {
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`${command} was terminated by signal ${result.signal}`);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
  }
}

/** Spawn a long-running command and return the `ChildProcess` (e.g. `cdk watch`). */
export function spawnCommand(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(command, args, options);
}
