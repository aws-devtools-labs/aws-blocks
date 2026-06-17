// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptions,
} from 'node:child_process';
import spawn from 'cross-spawn';

/**
 * Cross-platform process spawning for the deploy/sandbox lifecycle.
 *
 * Commands like `npm`, `npx`, `cdk`, and `tsx` are real executables on
 * macOS/Linux but `.cmd` shims on Windows. Node's `execFileSync`/`spawn` do a
 * direct exec that doesn't apply Windows `PATHEXT` resolution, so they look for
 * a file literally named `npx` and fail with `spawnSync npx ENOENT`. Node also
 * refuses to spawn `.cmd`/`.bat` files without a shell since the CVE-2024-27980
 * fix. `cross-spawn` resolves the shim and handles Windows argument quoting
 * (including paths with spaces) while keeping the safe array-arg form — no shell
 * string interpolation, so no injection surface.
 */

/**
 * Run a command to completion, inheriting stdio by default, and throw on
 * failure. Drop-in replacement for `execFileSync(command, args, options)` for
 * the cases that only care about success/failure (not captured output).
 *
 * Throws if the process cannot be spawned, is killed by a signal, or exits
 * with a non-zero status — matching `execFileSync`'s throw-on-failure contract
 * that the deploy/destroy/migrate call sites rely on.
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
 * Spawn a long-running command and return the `ChildProcess` so the caller can
 * stream stdout/stderr and kill it later (e.g. `cdk watch`). Cross-platform
 * equivalent of `spawn(command, args, options)`.
 */
export function spawnCommand(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(command, args, options);
}
