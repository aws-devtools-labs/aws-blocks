// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `blocks secret` — manage hosting/pipeline secrets in SSM Parameter Store.
 *
 * Secrets are stored as SecureString parameters under `/blocks/secrets/<KEY>`
 * (see {@link blocksSecretParameterName} — the single source of truth for the
 * Blocks path; the neutral engine lives in `@aws-blocks/hosting/secret`).
 * This is the out-of-band counterpart to `secret('KEY')` in `hosting.ts`:
 * the customer sets values here once; the deploy only ever READS them.
 *
 * Commands:
 *   blocks secret set <KEY> <value>   create/update a SecureString
 *   blocks secret list                list secret keys (names only, never values)
 *   blocks secret remove <KEY>        delete a secret
 *
 * Flat namespace by design — no stage scoping. The key you set is the key you
 * reference. (Use distinct keys like DOMAIN_BETA / DOMAIN_PROD for per-stage
 * values; the value is the explicit choice, not magic.)
 *
 * @module
 */

import { secretEnvVarName } from '@aws-blocks/hosting/secret';
import { BLOCKS_SECRET_PARAMETER_PREFIX, blocksSecretParameterName } from '../secret-naming.js';

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
export async function setSecret(key: string, value: string): Promise<void> {
	assertValidKey(key);
	if (value === undefined || value === null) {
		throw new Error(`No value provided for secret '${key}'.`);
	}
	const { SSMClient, PutParameterCommand } = await import('@aws-sdk/client-ssm');
	const client = new SSMClient({});
	const name = blocksSecretParameterName(key);
	await client.send(
		new PutParameterCommand({
			Name: name,
			Value: value,
			Type: 'SecureString',
			Overwrite: true,
		}),
	);
	console.log(`🔐 Secret '${key}' set (${name}).`);
}

/** List secret keys stored under the hosting secrets prefix. Values are never returned. */
export async function listSecrets(): Promise<string[]> {
	const { SSMClient, GetParametersByPathCommand } = await import('@aws-sdk/client-ssm');
	const client = new SSMClient({});
	const keys: string[] = [];
	let nextToken: string | undefined;
	do {
		const result = await client.send(
			new GetParametersByPathCommand({
				Path: BLOCKS_SECRET_PARAMETER_PREFIX,
				Recursive: false,
				WithDecryption: false, // names only — never decrypt for a list
				NextToken: nextToken,
			}),
		);
		for (const p of result.Parameters ?? []) {
			if (p.Name) keys.push(p.Name.slice(BLOCKS_SECRET_PARAMETER_PREFIX.length + 1));
		}
		nextToken = result.NextToken;
	} while (nextToken);
	return keys.sort();
}

/** Remove a secret. Returns true if it existed, false if it was already absent. */
export async function removeSecret(key: string): Promise<boolean> {
	assertValidKey(key);
	const { SSMClient, DeleteParameterCommand } = await import('@aws-sdk/client-ssm');
	const client = new SSMClient({});
	try {
		await client.send(new DeleteParameterCommand({ Name: blocksSecretParameterName(key) }));
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
 * CLI dispatcher for `blocks secret <subcommand> [...args]`. Thin argv parsing
 * so a template script (or a future top-level CLI) can wire it in one line.
 */
export async function runSecretCli(argv: string[]): Promise<void> {
	const [subcommand, ...rest] = argv;
	switch (subcommand) {
		case 'set': {
			const [key, ...valueParts] = rest;
			// Allow values with spaces without forcing the caller to quote-escape.
			const value = valueParts.join(' ');
			if (!key || valueParts.length === 0) {
				throw new Error('Usage: blocks secret set <KEY> <value>');
			}
			await setSecret(key, value);
			break;
		}
		case 'list': {
			const keys = await listSecrets();
			if (keys.length === 0) {
				console.log('No secrets set. Add one with: blocks secret set <KEY> <value>');
			} else {
				console.log('Secrets:');
				for (const key of keys) {
					console.log(`  ${key}  (env: ${secretEnvVarName(key)})`);
				}
			}
			break;
		}
		case 'remove':
		case 'rm': {
			const [key] = rest;
			if (!key) throw new Error('Usage: blocks secret remove <KEY>');
			await removeSecret(key);
			break;
		}
		default:
			throw new Error(
				`Unknown secret subcommand ${JSON.stringify(subcommand)}. ` + `Expected one of: set, list, remove.`,
			);
	}
}
