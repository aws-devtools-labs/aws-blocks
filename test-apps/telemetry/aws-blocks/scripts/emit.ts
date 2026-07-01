// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Telemetry emission harness for the e2e suite.
 *
 * Exercises the REAL `trackCommand` telemetry pipeline for an arbitrary command
 * name in either the SUCCESS or FAIL terminal state, writing the resulting event
 * to the path given by `--telemetry-file`. This lets the e2e tests assert that
 * every telemetry-emitting command produces a correct success AND failure event
 * without requiring AWS credentials (which real deploy/destroy/sandbox need for
 * their SUCCESS path).
 *
 * The telemetry code exercised here (`trackCommand` → `buildAndSendEvent` →
 * file sink) is the exact same code the production CLI commands run; only the
 * wrapped operation is a controlled no-op / thrower.
 *
 * Usage:
 *   tsx aws-blocks/scripts/emit.ts <command> <success|fail> [--telemetry-file=...]
 */

import { trackCommand, type CommandName } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Register the backend's Building Blocks so emitted events carry real counters.
// Best-effort: a registration hiccup must not mask the telemetry assertion.
try {
  await import(join(__dirname, '..', 'index.ts'));
} catch {
  // block registration is best-effort
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const command = (positional[0] ?? 'deploy') as CommandName;
const outcome = positional[1] ?? 'success';

async function run(): Promise<void> {
  if (outcome === 'fail') {
    // A message that classifyError maps to CREDENTIALS_FAILED / auth.
    await trackCommand(command, async () => {
      throw new Error('No credentials found: security token is invalid');
    });
  } else {
    await trackCommand(command, async () => {
      // Successful no-op operation.
    });
  }
}

run().catch(() => {
  // FAIL path rethrows after the telemetry event is emitted in the finally
  // block; swallow it here so the process exit code stays clean for the test.
  process.exitCode = 0;
});
