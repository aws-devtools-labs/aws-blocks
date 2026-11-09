// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { closeSync, constants, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { Scope } from '../common/index.js';
import { isTelemetryEnabled } from './consent.js';

/**
 * Framework resolves in the CDK synth subprocess (where `Hosting` is built), but
 * telemetry is emitted in the parent orchestrator. The parent sets this env var
 * to a file path; the synth child writes the resolved framework there; the parent
 * reads it back before building the event. A plain static cannot cross that boundary.
 */
export const FRAMEWORK_SINK_ENV = 'AWS_BLOCKS_FRAMEWORK_SINK';

/**
 * Sinks this process created, so cleanup only ever removes a directory we own. Each maps
 * to its exit hook, which registerFrameworkFromSink detaches once it has cleaned up, so a
 * long-running process does not accumulate one listener per deploy.
 */
const ownedSinks = new Map<string, () => void>();

/**
 * Parent side: a sink path inside a fresh private (0700) directory, or undefined when
 * the user opted out or the directory cannot be created. The per-run directory keeps
 * the path unguessable: in a shared tmpdir a predictable name can be pre-created as a
 * symlink, redirecting the child's write. Best-effort; never throws.
 */
export function createFrameworkSink(): string | undefined {
  if (!isTelemetryEnabled()) return undefined;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'blocks-framework-'));
    const sink = resolve(dir, 'framework');
    // Not a signal listener: one here would suppress the default termination the deploy
    // path relies on. 'exit' covers a throw and the sandbox handler's process.exit; an
    // uncaught signal or SIGKILL is left to the OS.
    const onExit = () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Cleanup is best-effort; never block the exit path.
      }
    };
    ownedSinks.set(sink, onExit);
    process.once('exit', onExit);
    return sink;
  } catch {
    return undefined;
  }
}

/**
 * Child side: write the framework if the parent set a sink. The value is whatever
 * `Hosting` resolved, including a customAdapter name, and is deliberately not validated
 * here: `buildEvent` gates it against REPORTED_FRAMEWORKS. The first construct to
 * synthesise wins. Best-effort; never throws.
 */
export function writeFrameworkSink(framework: string): void {
  const sink = process.env[FRAMEWORK_SINK_ENV];
  // Re-checked here: a directly-set sink path must not bypass the opt-out.
  if (!sink || !isTelemetryEnabled()) return;
  try {
    // O_CREAT | O_EXCL: atomic create — rejects an existing path, so a pre-created symlink
    // cannot redirect this write.
    const fd = openSync(sink, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    try {
      writeSync(fd, framework);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Telemetry must never break a deploy.
  }
}

/** Parent side: the framework the synth child recorded, or undefined. Best-effort; never throws. */
export function readFrameworkSink(sinkPath: string): string | undefined {
  try {
    const value = readFileSync(sinkPath, 'utf-8').trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parent side: read the framework the synth child recorded, hand it to the telemetry
 * registry, and remove the sink directory. Call on both the success and failure paths:
 * synth runs before either outcome, so a failed deploy still reports its framework.
 * Does nothing when no sink was created. Best-effort; never throws.
 */
export function registerFrameworkFromSink(sinkPath: string | undefined): void {
  if (!sinkPath) return;
  const detected = readFrameworkSink(sinkPath);
  if (detected) Scope._setFrameworkForTelemetry(detected);
  // The remove is recursive, so only ever touch a directory createFrameworkSink made:
  // a caller-supplied path would otherwise take out whatever directory contains it.
  const onExit = ownedSinks.get(resolve(sinkPath));
  if (!onExit) return;
  ownedSinks.delete(resolve(sinkPath));
  process.removeListener('exit', onExit);
  try {
    rmSync(dirname(sinkPath), { recursive: true, force: true });
  } catch {
    // Cleanup is best-effort; a leftover directory is harmless.
  }
}
