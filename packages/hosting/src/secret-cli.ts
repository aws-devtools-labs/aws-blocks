// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared CLI core for the two value kinds — `secret …` (AWS Secrets Manager) and
 * `config …` (SSM Parameter Store), each with `set` / `list` / `remove`. The kind
 * selects the store (`storeForKind`), mirroring `secret()` / `config()` in code
 * so the write and the read can't drift.
 *
 * Values are set OUT OF BAND (never in source). This module writes to the store;
 * deploy/runtime only READ.
 *
 * **Providing a value safely.** A positional value lands in `argv` (visible in
 * `ps`, `/proc`, shell history). Prefer `--value-stdin` (pipe it) or the
 * interactive hidden prompt when no value is on the command line.
 *
 * **Region.** Writes go to the SDK's default region unless `--region <name>` is
 * passed. This matters because the value must be written in the SAME region the
 * app deploys to — resolve them there or the deploy sees "not set". Pass
 * `--region` (or set `AWS_REGION`) to pin it explicitly.
 *
 * @module
 */

import { defaultPrefixForKind, type SecretStore, secretStoreLocator, storeForKind, type ValueKind } from './secret.js';

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Consumer-supplied CLI config. `kind` is fixed by a wrapper (e.g. the `secret`/`config` npm scripts). */
export interface ValueCliOptions {
	/** The value kind this invocation manages. If omitted, the first positional arg selects it. */
	kind?: ValueKind;
	/** Store path prefix (no trailing slash). Defaults to the kind's neutral prefix. */
	prefix?: string;
	/** Optional environment segment (`<prefix>/<stage>/<key>`). */
	stage?: string;
	/** AWS region to write/read in. Defaults to the SDK's resolved region (`AWS_REGION`, profile, …). */
	region?: string;
	/** Command label shown in usage text (e.g. `'blocks secret'`, `'hosting-config'`). */
	label?: string;
}

function assertValidKey(key: string): void {
	if (!key || !KEY_PATTERN.test(key)) {
		throw new Error(
			`Invalid key ${JSON.stringify(key)}. Keys must match ${KEY_PATTERN} ` +
				`(start with a letter or underscore, then letters, digits, or underscores).`,
		);
	}
}

/** Set (create or overwrite) a value of `kind` in its store. */
export async function setValue(
	kind: ValueKind,
	key: string,
	value: string,
	opts: { prefix?: string; stage?: string; region?: string } = {},
): Promise<void> {
	assertValidKey(key);
	if (value === undefined || value === null) throw new Error(`No value provided for '${key}'.`);
	const store = storeForKind(kind);
	const prefix = opts.prefix ?? defaultPrefixForKind(kind);
	const name = secretStoreLocator(key, { prefix, store, stage: opts.stage });
	const clientConfig = opts.region ? { region: opts.region } : {};

	if (store === 'secrets-manager') {
		const { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand } = await import(
			'@aws-sdk/client-secrets-manager'
		);
		const client = new SecretsManagerClient(clientConfig);
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
		const client = new SSMClient(clientConfig);
		await client.send(new PutParameterCommand({ Name: name, Value: value, Type: 'SecureString', Overwrite: true }));
	}
	console.log(`${kind === 'secret' ? '🔐' : '⚙️ '} ${kind} '${key}' set (${name}).`);
}

/** List keys of `kind` under the prefix. Values are never returned. */
export async function listValues(
	kind: ValueKind,
	opts: { prefix?: string; stage?: string; region?: string } = {},
): Promise<string[]> {
	const store = storeForKind(kind);
	const base = opts.prefix ?? defaultPrefixForKind(kind);
	const scoped = opts.stage ? `${base}/${opts.stage}` : base;
	const clientConfig = opts.region ? { region: opts.region } : {};

	if (store === 'secrets-manager') {
		const smPrefix = scoped.replace(/^\//, '');
		const { SecretsManagerClient, ListSecretsCommand } = await import('@aws-sdk/client-secrets-manager');
		const client = new SecretsManagerClient(clientConfig);
		const keys: string[] = [];
		let nextToken: string | undefined;
		do {
			const result = await client.send(
				new ListSecretsCommand({ Filters: [{ Key: 'name', Values: [`${smPrefix}/`] }], NextToken: nextToken }),
			);
			for (const s of result.SecretList ?? []) {
				if (!s.Name?.startsWith(`${smPrefix}/`)) continue;
				const rest = s.Name.slice(smPrefix.length + 1);
				if (!opts.stage && rest.includes('/')) continue;
				keys.push(rest);
			}
			nextToken = result.NextToken;
		} while (nextToken);
		return keys.sort();
	}

	const { SSMClient, GetParametersByPathCommand } = await import('@aws-sdk/client-ssm');
	const client = new SSMClient(clientConfig);
	const keys: string[] = [];
	let nextToken: string | undefined;
	do {
		const result = await client.send(
			new GetParametersByPathCommand({
				Path: scoped,
				Recursive: false,
				WithDecryption: false,
				NextToken: nextToken,
			}),
		);
		for (const p of result.Parameters ?? []) if (p.Name) keys.push(p.Name.slice(scoped.length + 1));
		nextToken = result.NextToken;
	} while (nextToken);
	return keys.sort();
}

/**
 * Remove a value of `kind`. Returns true if it existed, false if already absent.
 *
 * For **secrets** (Secrets Manager) the default is a *recoverable* delete — the
 * secret enters Secrets Manager's recovery window (its default, ~30 days) and can
 * be restored, guarding against a typo'd key in prod. Pass `force: true` to delete
 * immediately with no recovery. (SSM `config` deletes are always immediate —
 * Parameter Store has no recovery window — so `force` is a no-op there.)
 */
export async function removeValue(
	kind: ValueKind,
	key: string,
	opts: { prefix?: string; stage?: string; region?: string; force?: boolean } = {},
): Promise<boolean> {
	assertValidKey(key);
	const store: SecretStore = storeForKind(kind);
	const prefix = opts.prefix ?? defaultPrefixForKind(kind);
	const name = secretStoreLocator(key, { prefix, store, stage: opts.stage });
	const clientConfig = opts.region ? { region: opts.region } : {};

	if (store === 'secrets-manager') {
		const { SecretsManagerClient, DeleteSecretCommand } = await import('@aws-sdk/client-secrets-manager');
		const client = new SecretsManagerClient(clientConfig);
		try {
			// Default: recoverable delete (recovery window). --force: immediate, no recovery.
			await client.send(
				new DeleteSecretCommand(
					opts.force ? { SecretId: name, ForceDeleteWithoutRecovery: true } : { SecretId: name },
				),
			);
			console.log(
				opts.force
					? `🗑️  ${kind} '${key}' permanently removed (no recovery).`
					: `🗑️  ${kind} '${key}' scheduled for deletion (recovery window active; restore with \`aws secretsmanager restore-secret\`, or use --force to delete immediately).`,
			);
			return true;
		} catch (error: unknown) {
			if ((error as { name?: string })?.name === 'ResourceNotFoundException') {
				console.log(`${kind} '${key}' was not set — nothing to remove.`);
				return false;
			}
			throw error;
		}
	}

	const { SSMClient, DeleteParameterCommand } = await import('@aws-sdk/client-ssm');
	const client = new SSMClient(clientConfig);
	try {
		await client.send(new DeleteParameterCommand({ Name: name }));
		console.log(`🗑️  ${kind} '${key}' removed.`);
		return true;
	} catch (error: unknown) {
		if ((error as { name?: string })?.name === 'ParameterNotFound') {
			console.log(`${kind} '${key}' was not set — nothing to remove.`);
			return false;
		}
		throw error;
	}
}

/**
 * CLI dispatcher. Two shapes:
 *  - `kind` fixed by the wrapper → argv is `<subcommand> [...args]` (e.g. `secret set KEY`).
 *  - `kind` not fixed → argv is `<secret|config> <subcommand> [...args]`.
 */
export async function runValueCli(argv: string[], opts: ValueCliOptions = {}): Promise<void> {
	const { stage, valueStdin, prefix, region, force, positional } = extractFlags(argv);

	let kind = opts.kind;
	let rest = positional;
	if (!kind) {
		const first = positional[0];
		if (first !== 'secret' && first !== 'config') {
			throw new Error(`Expected 'secret' or 'config' as the first argument (got ${JSON.stringify(first)}).`);
		}
		kind = first;
		rest = positional.slice(1);
	}
	const label = opts.label ?? kind;
	const effPrefix = prefix ?? opts.prefix;
	const effStage = stage ?? opts.stage;
	const effRegion = region ?? opts.region;
	const [subcommand, ...args] = rest;

	switch (subcommand) {
		case 'set': {
			const [key, ...valueParts] = args;
			if (!key)
				throw new Error(
					`Usage: ${label} set <KEY> [<value>] [--value-stdin] [--stage <name>] [--prefix <path>] [--region <name>]`,
				);
			let value: string;
			if (valueStdin) {
				if (valueParts.length > 0) throw new Error('Pass the value via stdin OR as an argument, not both.');
				value = await readStdin();
			} else if (valueParts.length > 0) {
				value = valueParts.join(' ');
			} else {
				value = await promptHidden(`Enter value for ${kind} '${key}' (hidden): `);
			}
			if (value.length === 0) throw new Error(`No value provided for '${key}'.`);
			await setValue(kind, key, value, { prefix: effPrefix, stage: effStage, region: effRegion });
			break;
		}
		case 'list': {
			const keys = await listValues(kind, { prefix: effPrefix, stage: effStage, region: effRegion });
			const scope = effStage ? ` (stage '${effStage}')` : '';
			if (keys.length === 0) console.log(`No ${kind} values set${scope}. Add one: ${label} set <KEY> <value>`);
			else {
				console.log(`${kind} values${scope}:`);
				for (const key of keys) console.log(`  ${key}`);
			}
			break;
		}
		case 'remove':
		case 'rm': {
			const [key] = args;
			if (!key) throw new Error(`Usage: ${label} remove <KEY> [--force] [--stage <name>] [--region <name>]`);
			await removeValue(kind, key, { prefix: effPrefix, stage: effStage, region: effRegion, force });
			break;
		}
		default:
			throw new Error(`Unknown subcommand ${JSON.stringify(subcommand)}. Expected one of: set, list, remove.`);
	}
}

function extractFlags(argv: string[]): {
	stage?: string;
	valueStdin: boolean;
	prefix?: string;
	region?: string;
	force: boolean;
	positional: string[];
} {
	const positional: string[] = [];
	let stage: string | undefined;
	let valueStdin = false;
	let prefix: string | undefined;
	let region: string | undefined;
	let force = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--force') {
			force = true;
		} else if (arg === '--stage') {
			stage = argv[++i];
			if (stage === undefined) throw new Error('`--stage` requires a value, e.g. --stage prod');
		} else if (arg.startsWith('--stage=')) {
			stage = arg.slice('--stage='.length);
		} else if (arg === '--value-stdin') {
			valueStdin = true;
		} else if (arg === '--prefix') {
			prefix = argv[++i];
			if (prefix === undefined) throw new Error('`--prefix` requires a value, e.g. --prefix /myapp/secrets');
		} else if (arg.startsWith('--prefix=')) {
			prefix = arg.slice('--prefix='.length);
		} else if (arg === '--region') {
			region = argv[++i];
			if (region === undefined) throw new Error('`--region` requires a value, e.g. --region us-east-1');
		} else if (arg.startsWith('--region=')) {
			region = arg.slice('--region='.length);
		} else {
			positional.push(arg);
		}
	}
	return { stage, valueStdin, prefix, region, force, positional };
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks)
		.toString('utf8')
		.replace(/\r?\n$/, '');
}

async function promptHidden(prompt: string): Promise<string> {
	if (!process.stdin.isTTY) {
		throw new Error('No value provided and stdin is not a TTY. Pass `--value-stdin` and pipe the value instead.');
	}
	const { createInterface } = await import('node:readline');
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	const output = rl as unknown as { _writeToOutput?: (s: string) => void };
	let muted = false;
	output._writeToOutput = (str: string) => {
		if (!muted) process.stdout.write(str);
	};
	process.stdout.write(prompt);
	muted = true;
	try {
		const value = await new Promise<string>((resolve) => rl.question('', resolve));
		process.stdout.write('\n');
		return value;
	} finally {
		rl.close();
	}
}
