// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `blocks config` — manage a Blocks app's non-sensitive **config** values (SSM
 * Parameter Store), pinned to the Blocks `/blocks/config` namespace. Thin wrapper
 * over the shared `@aws-blocks/hosting` CLI with the kind fixed to `config`. The
 * `secret` counterpart is `./secret.ts`.
 *
 * @module
 */

import { listValues, removeValue, runValueCli, setValue } from '@aws-blocks/hosting/secret';
import { BLOCKS_CONFIG_PARAMETER_PREFIX } from '../secret-naming.js';

const PREFIX = BLOCKS_CONFIG_PARAMETER_PREFIX;

/** Set (create or overwrite) a Blocks config value. */
export function setConfig(key: string, value: string, opts: { stage?: string } = {}): Promise<void> {
	return setValue('config', key, value, { prefix: PREFIX, ...opts });
}

/** List Blocks config keys (names only). */
export function listConfig(opts: { stage?: string } = {}): Promise<string[]> {
	return listValues('config', { prefix: PREFIX, ...opts });
}

/** Remove a Blocks config value. */
export function removeConfig(key: string, opts: { stage?: string } = {}): Promise<boolean> {
	return removeValue('config', key, { prefix: PREFIX, ...opts });
}

/** CLI dispatcher for `blocks config <set|list|remove> …`. */
export function runConfigCli(argv: string[]): Promise<void> {
	return runValueCli(argv, { kind: 'config', prefix: PREFIX, label: 'blocks config' });
}
