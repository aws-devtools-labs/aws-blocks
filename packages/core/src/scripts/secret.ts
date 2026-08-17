// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `blocks secret` — manage a Blocks app's **secrets** (AWS Secrets Manager),
 * pinned to the Blocks `/blocks/secrets` namespace. Thin wrapper over the shared
 * `@aws-blocks/hosting` CLI with the kind fixed to `secret`. The `config`
 * counterpart is `./config.ts`.
 *
 * @module
 */

import { listValues, removeValue, runValueCli, setValue } from '@aws-blocks/hosting/secret';
import { BLOCKS_SECRET_PARAMETER_PREFIX } from '../secret-naming.js';

const PREFIX = BLOCKS_SECRET_PARAMETER_PREFIX;

/** Set (create or overwrite) a Blocks secret. */
export function setSecret(key: string, value: string, opts: { stage?: string } = {}): Promise<void> {
	return setValue('secret', key, value, { prefix: PREFIX, ...opts });
}

/** List Blocks secret keys (names only). */
export function listSecrets(opts: { stage?: string } = {}): Promise<string[]> {
	return listValues('secret', { prefix: PREFIX, ...opts });
}

/** Remove a Blocks secret. */
export function removeSecret(key: string, opts: { stage?: string } = {}): Promise<boolean> {
	return removeValue('secret', key, { prefix: PREFIX, ...opts });
}

/** CLI dispatcher for `blocks secret <set|list|remove> …`. */
export function runSecretCli(argv: string[]): Promise<void> {
	return runValueCli(argv, { kind: 'secret', prefix: PREFIX, label: 'blocks secret' });
}
