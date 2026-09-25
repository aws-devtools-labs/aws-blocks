// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptions,
} from 'node:child_process';
import spawn from 'cross-spawn';
import { getLogLevel, LogLevel } from '../logger.js';
import { keepAtNormalLine } from './stream-filter.js';

// `npm`/`npx`/`cdk`/`tsx` are `.cmd` shims on Windows, which Node's
// execFileSync/spawn can't resolve (spawnSync ENOENT) and won't run without a
// shell. cross-spawn resolves the shim and quotes args safely (array form, no
// shell injection), so these wrappers work on Windows too.

/**
 * Run a command to completion and throw on failure — a cross-platform drop-in
 * for `execFileSync` where only success/failure matters.
 *
 * Output is verbosity-aware: when the caller asks for inherited stdio (the
 * default) and the CLI is at Normal/Quiet level, the child's output is captured
 * and only signal-bearing lines (CloudFormation events, warnings, errors) are
 * relayed — the raw npm/cdk/tsx chatter is dropped. At Verbose (or above), or
 * when the caller passes an explicit non-'inherit' stdio, behaviour is
 * unchanged (true inherit / caller's choice). This gives every command that
 * shells out (destroy, sandbox npm-install, external migrations, sandbox
 * destroy) the same quiet-by-default, --verbose-for-raw experience.
 */
export function runSync(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): void {
  const wantsInherit = options.stdio === undefined || options.stdio === 'inherit';
  const filter = wantsInherit && getLogLevel() < LogLevel.Verbose;

  const spawnOptions: SpawnSyncOptions = filter
    ? { ...options, stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf-8' }
    : { stdio: 'inherit', ...options };

  const result = spawn.sync(command, args, spawnOptions);

  if (filter) {
    // Relay only the signal-bearing lines from the captured streams. stderr is
    // always shown (it carries errors) but still line-filtered so a noisy tool
    // that logs progress to stderr does not defeat the quiet default; error
    // lines match the keep-rules and pass.
    relayFiltered(result.stdout, process.stdout);
    relayFiltered(result.stderr, process.stderr);
  }

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

/** Write only the keep-worthy lines of a captured buffer to a stream. */
function relayFiltered(
  buffer: string | Buffer | null | undefined,
  sink: NodeJS.WritableStream,
): void {
  if (!buffer) return;
  const text = typeof buffer === 'string' ? buffer : buffer.toString('utf-8');
  for (const line of text.split('\n')) {
    if (line.trim() !== '' && keepAtNormalLine(line)) {
      sink.write(`${line}\n`);
    }
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
