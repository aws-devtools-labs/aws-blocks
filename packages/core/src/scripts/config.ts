// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `cdk-blocks config` — manage a Blocks app's non-sensitive **config** values (SSM
 * Parameter Store), pinned to the Blocks `/blocks/<stackId>/config` namespace
 * (scoped to the app's stable `stackId` from `.blocks/config.json`). Thin wrapper
 * over the shared `@aws-blocks/hosting` CLI with the kind fixed to `config`. The
 * `secret` counterpart is `./secret.ts`.
 *
 * @module
 */

import { listValues, removeValue, runValueCli, setValue } from '@aws-blocks/hosting/scripts';
import { blocksCliPrefix } from '../secret-naming.js';

/** Set (create or overwrite) a Blocks config value. */
export async function setConfig(key: string, value: string, opts: { stage?: string } = {}): Promise<void> {
	return setValue('config', key, value, { prefix: blocksCliPrefix('config', 'setConfig()'), ...opts });
}

/** List Blocks config keys (names only). */
export async function listConfig(opts: { stage?: string } = {}): Promise<string[]> {
	return listValues('config', { prefix: blocksCliPrefix('config', 'listConfig()'), ...opts });
}

/** Remove a Blocks config value. */
export async function removeConfig(key: string, opts: { stage?: string } = {}): Promise<boolean> {
	return removeValue('config', key, { prefix: blocksCliPrefix('config', 'removeConfig()'), ...opts });
}

/**
 * CLI dispatcher for `cdk-blocks config <set|list|remove> …`. `interactive: false`
 * refuses prompts; a usage problem throws hosting's `ValueCliUsageError`. Warns
 * on stderr when no `stackId` scopes the default namespace, and rejects when
 * `.blocks/config.json` can't be parsed. An explicit `--prefix` skips the default
 * namespace entirely.
 */
export async function runConfigCli(argv: string[], options: { interactive?: boolean; yes?: boolean } = {}): Promise<void> {
	const explicitPrefix = argv.some((arg) => arg === '--prefix' || arg.startsWith('--prefix='));
	const prefix = explicitPrefix ? undefined : blocksCliPrefix('config', 'cdk-blocks config');
	return runValueCli(argv, { kind: 'config', prefix, label: 'cdk-blocks config', ...options });
}
