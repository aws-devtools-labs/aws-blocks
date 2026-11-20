// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `npm run secret` — manage a CDK Blocks app's **secrets** (AWS Secrets Manager),
 * pinned to the CDK Blocks `/blocks/<stackId>/secrets` namespace (scoped to the app's
 * stable `stackId` from `.cdk-blocks/config.json`, so two apps in one account never
 * collide). Thin wrapper over the shared `@aws-cdk-blocks/hosting` CLI with the kind
 * fixed to `secret`. The `config` counterpart is `./config.ts`.
 *
 * @module
 */

import { listValues, removeValue, runValueCli, setValue } from '@aws-cdk-blocks/hosting/scripts';
import { blocksSecretPrefix } from '../secret-naming.js';
import { trackCommand } from '../telemetry/trackCommand.js';

/** Set (create or overwrite) a CDK Blocks secret. */
export function setSecret(key: string, value: string, opts: { stage?: string } = {}): Promise<void> {
	return setValue('secret', key, value, { prefix: blocksSecretPrefix(), ...opts });
}

/** List CDK Blocks secret keys (names only). */
export function listSecrets(opts: { stage?: string } = {}): Promise<string[]> {
	return listValues('secret', { prefix: blocksSecretPrefix(), ...opts });
}

/**
 * Remove a CDK Blocks secret. By default Secrets Manager schedules the deletion, so the
 * name stays reserved for the recovery window (and can be restored); pass
 * `force: true` to delete it immediately, as `npm run secret -- remove <KEY> --force --yes` does.
 * A forced delete has no recovery window: it logs a warning naming the stage (or
 * saying the value is shared by every stage, production included) and proceeds —
 * this API is non-interactive. The CLI additionally requires `--yes` for every
 * `--force` delete.
 */
export function removeSecret(key: string, opts: { stage?: string; force?: boolean } = {}): Promise<boolean> {
	return removeValue('secret', key, { prefix: blocksSecretPrefix(), ...opts });
}

/**
 * CLI dispatcher for `npm run secret -- <set|list|remove> …`. `interactive: false`
 * refuses the hidden prompt, and `yes` confirms `remove --force` as `--yes` does;
 * a usage problem throws hosting's `ValueCliUsageError`.
 */
export function runSecretCli(argv: string[], options: { interactive?: boolean; yes?: boolean } = {}): Promise<void> {
	// Tracked here, not in the CLI, so an app still running a vendored `aws-blocks/scripts/secret.ts`
	// that calls this function directly sends the same `secret` event.
	return trackCommand('secret', () =>
		runValueCli(argv, { kind: 'secret', prefix: blocksSecretPrefix(), label: 'npm run secret --', ...options }),
	);
}
