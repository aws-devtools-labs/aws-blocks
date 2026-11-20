// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandName, CommandState, TrackCommandOptions } from './types.js';
import { isTelemetryEnabled } from './consent.js';
import { buildAndSendEvent } from './client.js';

/**
 * Classify a caught error into a telemetry-safe error code.
 * Only inspects the error message for known patterns — never transmits raw messages.
 */
export function classifyError(error: unknown): { code: string; phase: string } {
  if (!(error instanceof Error)) return { code: 'UNKNOWN', phase: 'unknown' };
  const msg = error.message.toLowerCase();

  if (msg.includes('eaddrinuse') || (msg.includes('port') && msg.includes('in use'))) {
    return { code: 'PORT_IN_USE', phase: 'startup' };
  }
  if (msg.includes('access denied') || msg.includes('not authorized') || msg.includes('forbidden')) {
    return { code: 'PERMISSION_DENIED', phase: 'auth' };
  }
  if (msg.includes('credentials') || msg.includes('no credentials') || msg.includes('security token')) {
    return { code: 'CREDENTIALS_FAILED', phase: 'auth' };
  }
  if (msg.includes('cdk synth') || msg.includes('synthesis')) {
    return { code: 'CDK_SYNTH_FAILED', phase: 'synth' };
  }
  if (msg.includes('cdk deploy') || msg.includes('deployment failed') || (msg.includes('cdk') && msg.includes('deploy') && msg.includes('exited with code'))) {
    return { code: 'CDK_DEPLOY_FAILED', phase: 'deploy' };
  }
  if (msg.includes('cdk destroy') || msg.includes('destroy failed') || (msg.includes('cdk') && msg.includes('destroy') && msg.includes('exited with code'))) {
    return { code: 'CDK_DESTROY_FAILED', phase: 'destroy' };
  }
  if (msg.includes('npm install') || msg.includes('npm err')) {
    return { code: 'NPM_INSTALL_FAILED', phase: 'install' };
  }
  if (msg.includes('codegen') || msg.includes('generate client')) {
    return { code: 'CODEGEN_FAILED', phase: 'codegen' };
  }
  if (msg.includes('vite') || msg.includes('next build') || msg.includes('frontend build')) {
    return { code: 'FRONTEND_BUILD_FAILED', phase: 'build' };
  }
  if (msg.includes('template') && msg.includes('copy')) {
    return { code: 'TEMPLATE_COPY_FAILED', phase: 'init' };
  }
  if (msg.includes('argument') || msg.includes('parse')) {
    return { code: 'ARG_PARSE_FAILED', phase: 'init' };
  }

  return { code: 'UNKNOWN', phase: 'unknown' };
}

/**
 * Wrap a CLI command function with telemetry tracking.
 *
 * Measures wall-clock duration, classifies errors, and sends a single telemetry event
 * after the command completes (success or failure). The telemetry send is fire-and-forget
 * and bounded by a 500ms timeout — it will never delay the command or affect its exit code.
 *
 * When the user has opted out of CDK CLI telemetry, which is the only opt-out
 * ({@link isTelemetryEnabled}), the function is executed directly and nothing is sent.
 *
 * @param commandName - The command being tracked
 * @param fn - The async function to execute
 * @param options - Optional metadata (template, framework, etc.)
 *
 * @example
 * ```ts
 * await trackCommand('sandbox', async () => {
 *   await startSandbox({ backendPath: '...' });
 * });
 * ```
 */
export async function trackCommand(
  commandName: CommandName,
  fn: () => Promise<void>,
  options?: TrackCommandOptions,
): Promise<void> {
  if (!telemetryEnabledSafely(options?.projectRoot)) {
    return fn();
  }

  const startTime = Date.now();
  let state: CommandState = 'SUCCESS';
  let errorInfo: { code: string; phase: string } | undefined;

  try {
    await fn();
  } catch (error: unknown) {
    state = 'FAIL';
    errorInfo = classifyError(error);
    throw error;
  } finally {
    const duration = Date.now() - startTime;
    // buildAndSendEvent catches everything itself; this guard keeps a future
    // change there from replacing the command's result with a telemetry error.
    try {
      buildAndSendEvent({
        command: commandName,
        state,
        duration,
        ...(options?.projectRoot && { projectRoot: options.projectRoot }),
        ...(errorInfo && { error: errorInfo }),
        ...(options && {
          product: {
            ...(options.cdkVersion && { cdkVersion: options.cdkVersion }),
            ...(options.framework && { framework: options.framework }),
            ...(options.template && { template: options.template }),
            ...(options.templateVersion && { templateVersion: options.templateVersion }),
          },
        }),
        ...(options?.blocksCount !== undefined && {
          counters: { blocksCount: options.blocksCount },
        }),
      });
    } catch {
      // Telemetry must never affect the user's command.
    }
  }
}

/**
 * The consent check, which must never fail the command it guards: an error
 * reading the consent sources (for example a deleted working directory) counts
 * as "telemetry off".
 */
function telemetryEnabledSafely(projectRoot?: string): boolean {
  try {
    return isTelemetryEnabled(projectRoot);
  } catch {
    return false;
  }
}

/**
 * The telemetry state for a CLI exit code: 0 is `SUCCESS`, an interruption
 * (SIGINT 130, SIGTERM 143) is `ABORTED`, and any other code is `FAIL`.
 */
export function stateForExitCode(code: number): CommandState {
  if (code === 0) return 'SUCCESS';
  if (code === 130 || code === 143) return 'ABORTED';
  return 'FAIL';
}

/**
 * Wrap a CLI command handler that reports its outcome as an exit code.
 *
 * As {@link trackCommand}, but the outcome comes from the returned exit code
 * (see {@link stateForExitCode}) as well as from a thrown error. The handler's
 * exit code or error is passed through unchanged: sending the event never
 * throws, never waits for the network, and never changes the result.
 *
 * @param commandName - The command being tracked
 * @param fn - The handler, resolving to its exit code
 * @param options - Optional metadata; `projectRoot` scopes the consent lookup
 * @returns The handler's exit code
 */
export async function trackExitCode(
  commandName: CommandName,
  fn: () => Promise<number>,
  options?: Pick<TrackCommandOptions, 'projectRoot'>,
): Promise<number> {
  if (!telemetryEnabledSafely(options?.projectRoot)) {
    return fn();
  }

  const startTime = Date.now();
  let state: CommandState = 'FAIL';
  let errorInfo: { code: string; phase: string } | undefined;

  try {
    const code = await fn();
    state = stateForExitCode(code);
    // A failure reported as an exit code has no error to classify; give it the
    // category classifyError gives an unrecognized one, as every FAIL carries one.
    if (state === 'FAIL') errorInfo = classifyError(undefined);
    return code;
  } catch (error: unknown) {
    errorInfo = classifyError(error);
    throw error;
  } finally {
    // buildAndSendEvent catches everything itself; this guard keeps a future
    // change there from replacing the handler's result with a telemetry error.
    try {
      buildAndSendEvent({
        command: commandName,
        state,
        duration: Date.now() - startTime,
        ...(options?.projectRoot && { projectRoot: options.projectRoot }),
        ...(errorInfo && { error: errorInfo }),
      });
    } catch {
      // Telemetry must never affect the user's command.
    }
  }
}
