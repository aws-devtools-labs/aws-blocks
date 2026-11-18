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

/**
 * Run a command to completion and return its stdout — a cross-platform drop-in
 * for `execFileSync(command, args, { encoding: 'utf-8' })`. On failure it
 * throws with the captured stderr on `error.stderr`, as `execFileSync` does.
 */
export function runCapture(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): string {
  const result = spawn.sync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options, encoding: 'utf-8' });

  if (result.error) {
    throw result.error;
  }
  if (result.signal || (typeof result.status === 'number' && result.status !== 0)) {
    const reason = result.signal ? `was terminated by signal ${result.signal}` : `exited with code ${result.status}`;
    const error: Error & { stderr?: string } = new Error(`${command} ${args.join(' ')} ${reason}`);
    error.stderr = String(result.stderr ?? '');
    throw error;
  }
  return String(result.stdout ?? '');
}

/** Spawn a long-running command and return the `ChildProcess` (e.g. `cdk watch`). */
export function spawnCommand(
  command: string,
  args: string[],
  options: Omit<SpawnOptions, 'shell'>,
): ChildProcess {
  // Never a shell: the args reach the command as separate argv entries. A
  // command line that needs a shell goes through spawnShellCommand instead.
  return spawn(command, args, { ...options, shell: false });
}

/**
 * Spawn a user-configured command line (e.g. the sandbox's dev-server command)
 * under `shell: true` and return the `ChildProcess`. The whole line goes to the
 * shell as one string with no separate args: Node 24 emits DEP0190 whenever a
 * non-empty args array is combined with `shell: true`.
 *
 * Only pass a command line the app itself configured (never request input):
 * the line is interpreted by the shell as-is.
 */
export function spawnShellCommand(
  commandLine: string,
  options: Omit<SpawnOptions, 'shell'>,
): ChildProcess {
  return spawn(commandLine, [], { ...options, shell: true });
}
