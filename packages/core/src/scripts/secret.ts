// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `cdk-blocks secret` — manage a Blocks app's **secrets** (AWS Secrets Manager),
 * pinned to the Blocks `/blocks/<stackId>/secrets` namespace (scoped to the app's
 * stable `stackId` from `.blocks/config.json`, so two apps in one account never
 * collide). Thin wrapper over the shared `@aws-blocks/hosting` CLI with the kind
 * fixed to `secret`. The `config` counterpart is `./config.ts`.
 *
 * @module
 */

import { listValues, removeValue, runValueCli, setValue } from '@aws-blocks/hosting/scripts';
import { blocksCliPrefix } from '../secret-naming.js';

/** Set (create or overwrite) a Blocks secret. */
export async function setSecret(key: string, value: string, opts: { stage?: string } = {}): Promise<void> {
	return setValue('secret', key, value, { prefix: blocksCliPrefix('secret', 'setSecret()'), ...opts });
}

/** List Blocks secret keys (names only). */
export async function listSecrets(opts: { stage?: string } = {}): Promise<string[]> {
	return listValues('secret', { prefix: blocksCliPrefix('secret', 'listSecrets()'), ...opts });
}

/**
 * Remove a Blocks secret. By default Secrets Manager schedules the deletion, so the
 * name stays reserved for the recovery window (and can be restored); pass
 * `force: true` to delete it immediately, as `cdk-blocks secret remove --force --yes` does.
 * A forced delete has no recovery window: it logs a warning naming the stage (or
 * saying the value is shared by every stage, production included) and proceeds —
 * this API is non-interactive. The CLI additionally requires `--yes` for every
 * `--force` delete.
 */
export async function removeSecret(key: string, opts: { stage?: string; force?: boolean } = {}): Promise<boolean> {
	return removeValue('secret', key, { prefix: blocksCliPrefix('secret', 'removeSecret()'), ...opts });
}

/**
 * CLI dispatcher for `cdk-blocks secret <set|list|remove> …`. `interactive: false`
 * refuses the hidden prompt, and `yes` confirms `remove --force` as `--yes` does;
 * a usage problem throws hosting's `ValueCliUsageError`. Warns on stderr when no
 * `stackId` scopes the default namespace, and rejects when `.blocks/config.json`
 * can't be parsed. An explicit `--prefix` skips the default namespace entirely.
 */
export async function runSecretCli(argv: string[], options: { interactive?: boolean; yes?: boolean } = {}): Promise<void> {
	const explicitPrefix = argv.some((arg) => arg === '--prefix' || arg.startsWith('--prefix='));
	const prefix = explicitPrefix ? undefined : blocksCliPrefix('secret', 'cdk-blocks secret');
	return runValueCli(argv, { kind: 'secret', prefix, label: 'cdk-blocks secret', ...options });
}
