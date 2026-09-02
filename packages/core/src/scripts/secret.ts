// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `blocks secret` — manage a Blocks app's **secrets** (AWS Secrets Manager),
 * pinned to the Blocks `/blocks/<stackId>/secrets` namespace (scoped to the app's
 * stable `stackId` from `.blocks/config.json`, so two apps in one account never
 * collide). Thin wrapper over the shared `@aws-blocks/hosting` CLI with the kind
 * fixed to `secret`. The `config` counterpart is `./config.ts`.
 *
 * @module
 */

import { listValues, removeValue, runValueCli, setValue } from '@aws-blocks/hosting/scripts';
import { blocksSecretPrefix } from '../secret-naming.js';

/** Set (create or overwrite) a Blocks secret. */
export function setSecret(key: string, value: string, opts: { stage?: string } = {}): Promise<void> {
	return setValue('secret', key, value, { prefix: blocksSecretPrefix(), ...opts });
}

/** List Blocks secret keys (names only). */
export function listSecrets(opts: { stage?: string } = {}): Promise<string[]> {
	return listValues('secret', { prefix: blocksSecretPrefix(), ...opts });
}

/** Remove a Blocks secret. */
export function removeSecret(key: string, opts: { stage?: string } = {}): Promise<boolean> {
	return removeValue('secret', key, { prefix: blocksSecretPrefix(), ...opts });
}

/** CLI dispatcher for `blocks secret <set|list|remove> …`. */
export function runSecretCli(argv: string[]): Promise<void> {
	return runValueCli(argv, { kind: 'secret', prefix: blocksSecretPrefix(), label: 'blocks secret' });
}
