// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptions,
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
  const result = spawn.sync(command, args, { stdio: 'inherit', ...options });

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
 * {@link runSync} for a command whose stderr the caller reads: stdin and stdout
 * are inherited as in `runSync`, and each chunk of stderr goes to `onStderr` as
 * it arrives (UTF-8, never split inside a character). Resolves once the command
 * has exited and its stderr has ended; rejects with the same errors as `runSync`.
 * The command runs in this process's process group, as with `runSync`, so a
 * Ctrl-C in the terminal reaches it the same way.
 */
export function runPipingStderr(
  command: string,
  args: string[],
  options: Omit<SpawnOptions, 'stdio'>,
  onStderr: (chunk: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['inherit', 'inherit', 'pipe'] });
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', onStderr);
    child.once('error', reject);
    // 'close' follows the exit and the end of stderr, so every chunk has been handled.
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`${command} was terminated by signal ${signal}`));
      else if (typeof code === 'number' && code !== 0) reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      else resolve();
    });
  });
}

/** Spawn a long-running command and return the `ChildProcess` (e.g. `cdk watch`). */
export function spawnCommand(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(command, args, options);
}
