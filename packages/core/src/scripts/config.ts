// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `npm run config` — manage a CDK Blocks app's non-sensitive **config** values (SSM
 * Parameter Store), pinned to the CDK Blocks `/blocks/<stackId>/config` namespace
 * (scoped to the app's stable `stackId` from `.cdk-blocks/config.json`). Thin wrapper
 * over the shared `@aws-cdk-blocks/hosting` CLI with the kind fixed to `config`. The
 * `secret` counterpart is `./secret.ts`.
 *
 * @module
 */

import { listValues, removeValue, runValueCli, setValue } from '@aws-cdk-blocks/hosting/scripts';
import { blocksConfigPrefix } from '../secret-naming.js';
import { trackCommand } from '../telemetry/trackCommand.js';

/** Set (create or overwrite) a CDK Blocks config value. */
export function setConfig(key: string, value: string, opts: { stage?: string } = {}): Promise<void> {
	return setValue('config', key, value, { prefix: blocksConfigPrefix(), ...opts });
}

/** List CDK Blocks config keys (names only). */
export function listConfig(opts: { stage?: string } = {}): Promise<string[]> {
	return listValues('config', { prefix: blocksConfigPrefix(), ...opts });
}

/** Remove a CDK Blocks config value. */
export function removeConfig(key: string, opts: { stage?: string } = {}): Promise<boolean> {
	return removeValue('config', key, { prefix: blocksConfigPrefix(), ...opts });
}

/**
 * CLI dispatcher for `npm run config -- <set|list|remove> …`. `interactive: false`
 * refuses prompts; a usage problem throws hosting's `ValueCliUsageError`.
 */
export function runConfigCli(argv: string[], options: { interactive?: boolean; yes?: boolean } = {}): Promise<void> {
	// Tracked here, not in the CLI, so an app still running a vendored `aws-blocks/scripts/config.ts`
	// that calls this function directly sends the same `config` event.
	return trackCommand('config', () =>
		runValueCli(argv, { kind: 'config', prefix: blocksConfigPrefix(), label: 'npm run config --', ...options }),
	);
}
