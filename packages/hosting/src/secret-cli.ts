// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared secret CLI core — `set` / `list` / `remove` for hosting/pipeline
 * secrets. Relocated into the framework-neutral leaf so every consumer reuses
 * it: Blocks (`npm run secret`) and a standalone app (`npm run secret`). Each
 * consumer supplies its own SSM prefix and store via {@link SecretCliOptions};
 * the command surface is glue on top.
 *
 * The value is set OUT OF BAND (never in source). This module writes to the
 * store; deploy/runtime only READ. Store is pluggable: SSM SecureString
 * (default) or Secrets Manager.
 *
 * @module
 */

import {
	DEFAULT_SECRET_PARAMETER_PREFIX,
	DEFAULT_SECRET_STORE,
	type SecretStore,
	secretStoreLocator,
} from './secret.js';

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Consumer-supplied configuration for the CLI (namespace + store + label). */
export interface SecretCliOptions {
	/** Path prefix (no trailing slash). Default {@link DEFAULT_SECRET_PARAMETER_PREFIX}. */
	prefix?: string;
	/** Backing store. Default {@link DEFAULT_SECRET_STORE} (`'secrets-manager'`). */
	store?: SecretStore;
	/**
	 * Optional environment segment. When set, the value is written under
	 * `<prefix>/<stage>/<key>`; omit it to write the shared/fallback value at
	 * `<prefix>/<key>`. The CLI passes this from `--stage <name>`.
	 */
	stage?: string;
	/** Command label shown in usage text (e.g. `'blocks secret'`, `'ampx hosting secret'`). */
	label?: string;
}

function assertValidKey(key: string): void {
	if (!key || !KEY_PATTERN.test(key)) {
		throw new Error(
			`Invalid secret key ${JSON.stringify(key)}. Keys must match ` +
				`${KEY_PATTERN} (start with a letter or underscore, then letters, ` +
				`digits, or underscores).`,
		);
	}
}

/** Set (create or overwrite) a secret value. */
export async function setSecret(key: string, value: string, opts: SecretCliOptions = {}): Promise<void> {
	assertValidKey(key);
	if (value === undefined || value === null) {
		throw new Error(`No value provided for secret '${key}'.`);
	}
	const prefix = opts.prefix ?? DEFAULT_SECRET_PARAMETER_PREFIX;
	const store = opts.store ?? DEFAULT_SECRET_STORE;
	const name = secretStoreLocator(key, { prefix, store, stage: opts.stage });

	if (store === 'secrets-manager') {
		const { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand } = await import(
			'@aws-sdk/client-secrets-manager'
		);
		const client = new SecretsManagerClient({});
		try {
			await client.send(new CreateSecretCommand({ Name: name, SecretString: value }));
		} catch (error: unknown) {
			if ((error as { name?: string })?.name === 'ResourceExistsException') {
				await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
			} else {
				throw error;
			}
		}
	} else {
		const { SSMClient, PutParameterCommand } = await import('@aws-sdk/client-ssm');
		const client = new SSMClient({});
		await client.send(new PutParameterCommand({ Name: name, Value: value, Type: 'SecureString', Overwrite: true }));
	}
	console.log(`🔐 Secret '${key}' set (${name}).`);
}

/**
 * List secret keys under the prefix. Values are never returned. With a `stage`,
 * lists the stage's own secrets (`<prefix>/<stage>/…`); without one, lists the
 * shared secrets at `<prefix>/…` (stage-scoped ones live one level deeper and
 * are intentionally excluded from the shared view).
 */
export async function listSecrets(opts: SecretCliOptions = {}): Promise<string[]> {
	const basePrefix = opts.prefix ?? DEFAULT_SECRET_PARAMETER_PREFIX;
	const prefix = opts.stage ? `${basePrefix}/${opts.stage}` : basePrefix;
	const store = opts.store ?? DEFAULT_SECRET_STORE;

	if (store === 'secrets-manager') {
		// SM names are the slash-free locator form (`hosting/secrets/<KEY>`).
		const smPrefix = prefix.replace(/^\//, '');
		const { SecretsManagerClient, ListSecretsCommand } = await import('@aws-sdk/client-secrets-manager');
		const client = new SecretsManagerClient({});
		const keys: string[] = [];
		let nextToken: string | undefined;
		do {
			const result = await client.send(
				new ListSecretsCommand({
					Filters: [{ Key: 'name', Values: [`${smPrefix}/`] }],
					NextToken: nextToken,
				}),
			);
			for (const s of result.SecretList ?? []) {
				if (s.Name?.startsWith(`${smPrefix}/`)) keys.push(s.Name.slice(smPrefix.length + 1));
			}
			nextToken = result.NextToken;
		} while (nextToken);
		return keys.sort();
	}

	const { SSMClient, GetParametersByPathCommand } = await import('@aws-sdk/client-ssm');
	const client = new SSMClient({});
	const keys: string[] = [];
	let nextToken: string | undefined;
	do {
		const result = await client.send(
			new GetParametersByPathCommand({
				Path: prefix,
				Recursive: false,
				WithDecryption: false, // names only — never decrypt for a list
				NextToken: nextToken,
			}),
		);
		for (const p of result.Parameters ?? []) {
			if (p.Name) keys.push(p.Name.slice(prefix.length + 1));
		}
		nextToken = result.NextToken;
	} while (nextToken);
	return keys.sort();
}

/** Remove a secret. Returns true if it existed, false if already absent. */
export async function removeSecret(key: string, opts: SecretCliOptions = {}): Promise<boolean> {
	assertValidKey(key);
	const prefix = opts.prefix ?? DEFAULT_SECRET_PARAMETER_PREFIX;
	const store = opts.store ?? DEFAULT_SECRET_STORE;
	const name = secretStoreLocator(key, { prefix, store, stage: opts.stage });

	if (store === 'secrets-manager') {
		const { SecretsManagerClient, DeleteSecretCommand } = await import('@aws-sdk/client-secrets-manager');
		const client = new SecretsManagerClient({});
		try {
			await client.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }));
			console.log(`🗑️  Secret '${key}' removed.`);
			return true;
		} catch (error: unknown) {
			if ((error as { name?: string })?.name === 'ResourceNotFoundException') {
				console.log(`Secret '${key}' was not set — nothing to remove.`);
				return false;
			}
			throw error;
		}
	}

	const { SSMClient, DeleteParameterCommand } = await import('@aws-sdk/client-ssm');
	const client = new SSMClient({});
	try {
		await client.send(new DeleteParameterCommand({ Name: name }));
		console.log(`🗑️  Secret '${key}' removed.`);
		return true;
	} catch (error: unknown) {
		if ((error as { name?: string })?.name === 'ParameterNotFound') {
			console.log(`Secret '${key}' was not set — nothing to remove.`);
			return false;
		}
		throw error;
	}
}

/**
 * CLI dispatcher for `<label> <subcommand> [...args]`. Thin argv parsing so a
 * template script (Blocks/standalone) can wire it in one line.
 */
export async function runSecretCli(argv: string[], opts: SecretCliOptions = {}): Promise<void> {
	const label = opts.label ?? 'secret';
	// Pull an optional `--stage <name>` (or `--stage=<name>`) out of argv; a
	// CLI-supplied stage overrides any preset on `opts`. Everything else is
	// positional, so set/list/remove parsing below stays unchanged.
	const { stage, positional } = extractStageFlag(argv);
	const effectiveOpts: SecretCliOptions = stage !== undefined ? { ...opts, stage } : opts;
	const [subcommand, ...rest] = positional;
	switch (subcommand) {
		case 'set': {
			const [key, ...valueParts] = rest;
			const value = valueParts.join(' ');
			if (!key || valueParts.length === 0) {
				throw new Error(`Usage: ${label} set <KEY> <value> [--stage <name>]`);
			}
			await setSecret(key, value, effectiveOpts);
			break;
		}
		case 'list': {
			const keys = await listSecrets(effectiveOpts);
			const scope = effectiveOpts.stage ? ` (stage '${effectiveOpts.stage}')` : '';
			if (keys.length === 0) {
				console.log(`No secrets set${scope}. Add one with: ${label} set <KEY> <value>`);
			} else {
				console.log(`Secrets${scope}:`);
				for (const key of keys) console.log(`  ${key}`);
			}
			break;
		}
		case 'remove':
		case 'rm': {
			const [key] = rest;
			if (!key) throw new Error(`Usage: ${label} remove <KEY> [--stage <name>]`);
			await removeSecret(key, effectiveOpts);
			break;
		}
		default:
			throw new Error(
				`Unknown secret subcommand ${JSON.stringify(subcommand)}. Expected one of: set, list, remove.`,
			);
	}
}

/** Extract `--stage <name>` / `--stage=<name>` from argv, returning the rest. */
function extractStageFlag(argv: string[]): { stage?: string; positional: string[] } {
	const positional: string[] = [];
	let stage: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--stage') {
			stage = argv[++i];
			if (stage === undefined) throw new Error('`--stage` requires a value, e.g. --stage prod');
		} else if (arg.startsWith('--stage=')) {
			stage = arg.slice('--stage='.length);
		} else {
			positional.push(arg);
		}
	}
	return { stage, positional };
}
