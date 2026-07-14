// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-aware resolution glue for the `secret()` marker. This is the shared
 * engine that turns an inert {@link SecretValue} into wired infrastructure —
 * relocated here (from `@aws-blocks/core`) so ALL consumers reuse it: the
 * Blocks `Hosting` block, a standalone hosting app, Amplify's `defineHosting`,
 * and (the synth-time helpers) `@aws-blocks/pipeline`.
 *
 * Two resolution strategies, chosen by where the marker appears:
 *   • `environment` runtime secret (secure default) — inject the store LOCATOR
 *     (never the value) as `HOSTING_SECRET_PARAM_<KEY>` + grant the compute role
 *     read+decrypt; `getSecret()` fetches at runtime.
 *   • `domain.domainName` / `exposeAsEnv` — resolved at SYNTH time via an SDK
 *     GetParameter/GetSecretValue call and inlined as a literal (SecureString
 *     dynamic refs can't go in CloudFront Aliases / Lambda env).
 *
 * The SSM namespace prefix and the backing store are BOTH injectable, so this
 * package hardcodes no framework branding and no single store.
 *
 * @module
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
	DEFAULT_SECRET_PARAMETER_PREFIX,
	DEFAULT_SECRET_STORE,
	isSecret,
	type SecretStore,
	type SecretValue,
	secretEnvVarName,
	secretStoreLocator,
} from './secret.js';

export type { SecretStore };

/** A `compute.environment` value: a literal, or a deferred secret reference. */
export type EnvValue = string | SecretValue;

/** A custom-domain name: a literal, a secret, or a mix in an array. */
export type DomainNameInput = string | SecretValue | Array<string | SecretValue>;

/** Options shared by the resolve/wire helpers. */
export interface SecretResolveOptions {
	/** SSM path prefix (no trailing slash). Default {@link DEFAULT_SECRET_PARAMETER_PREFIX}. */
	prefix?: string;
	/** Backing store. Default `'ssm'`. */
	store?: SecretStore;
}

/**
 * Split an environment map into plain / runtime-secret / exposeAsEnv buckets.
 */
export function partitionEnvironment(environment: Record<string, EnvValue> | undefined): {
	plain: Record<string, string>;
	runtimeSecrets: SecretValue[];
	exposeSecrets: SecretValue[];
} {
	const plain: Record<string, string> = {};
	const runtimeSecrets: SecretValue[] = [];
	const exposeSecrets: SecretValue[] = [];

	for (const [key, value] of Object.entries(environment ?? {})) {
		if (isSecret(value)) {
			if (value.key !== key) {
				throw new Error(
					`Hosting environment '${key}': secret key '${value.key}' must match ` +
						`the environment variable name. Use ${key}: secret('${key}').`,
				);
			}
			(value.exposeAsEnv ? exposeSecrets : runtimeSecrets).push(value);
		} else {
			plain[key] = value;
		}
	}
	return { plain, runtimeSecrets, exposeSecrets };
}

/** Every secret key that requires a synth-time fetch (domain + exposeAsEnv). */
export function collectSynthSecretKeys(
	domainName: DomainNameInput | undefined,
	exposeSecrets: SecretValue[],
): string[] {
	const keys = new Set<string>();
	for (const name of toDomainArray(domainName)) {
		if (isSecret(name)) keys.add(name.key);
	}
	for (const s of exposeSecrets) keys.add(s.key);
	return [...keys];
}

function toDomainArray(domainName: DomainNameInput | undefined): Array<string | SecretValue> {
	if (domainName === undefined) return [];
	return Array.isArray(domainName) ? domainName : [domainName];
}

/**
 * Resolve secret keys to plaintext at synth time via the configured store.
 * Throws an actionable error if a referenced secret was never set.
 */
export async function resolveSecretsAtSynth(
	keys: string[],
	options: SecretResolveOptions & { fetcher?: SecretFetcher } = {},
): Promise<Map<string, string>> {
	const prefix = options.prefix ?? DEFAULT_SECRET_PARAMETER_PREFIX;
	const store = options.store ?? DEFAULT_SECRET_STORE;
	const fetcher = options.fetcher ?? synthFetcherOverride ?? defaultSynthFetcher(store);
	const resolved = new Map<string, string>();
	await Promise.all(
		keys.map(async (key) => {
			const locator = secretStoreLocator(key, { prefix, store });
			try {
				resolved.set(key, await fetcher(locator));
			} catch (error: unknown) {
				const e = error as { name?: string };
				if (e?.name === 'ParameterNotFound' || e?.name === 'ResourceNotFoundException') {
					throw new Error(
						`Hosting: secret '${key}' is referenced (domain or exposeAsEnv) but ` +
							`not set. Set it before deploying:\n  secret set ${key} <value>`,
					);
				}
				throw error;
			}
		}),
	);
	return resolved;
}

/** Resolve domain markers to literals using the synth-resolved secret map. */
export function resolveDomainNames(domainName: DomainNameInput, resolved: Map<string, string>): string | string[] {
	const arr = toDomainArray(domainName).map((name) => {
		if (!isSecret(name)) return name;
		const value = resolved.get(name.key);
		if (value === undefined) {
			throw new Error(
				`Hosting: domain secret('${name.key}') requires async resolution. ` +
					`Construct with the async create() path.`,
			);
		}
		return value;
	});
	return Array.isArray(domainName) ? arr : arr[0];
}

/**
 * Inject the store LOCATOR (not the value) for a runtime secret and grant the
 * compute role read+decrypt access scoped to that one parameter/secret.
 */
export function wireRuntimeSecret(fn: cdk.aws_lambda.Function, key: string, options: SecretResolveOptions = {}): void {
	const prefix = options.prefix ?? DEFAULT_SECRET_PARAMETER_PREFIX;
	const store = options.store ?? DEFAULT_SECRET_STORE;
	const locator = secretStoreLocator(key, { prefix, store });
	const region = cdk.Stack.of(fn).region;

	// Runtime resolver reads the locator here; the store hint tells it which API.
	fn.addEnvironment(secretEnvVarName(key), locator);
	if (store !== 'ssm') fn.addEnvironment(`${secretEnvVarName(key)}_STORE`, store);

	if (store === 'secrets-manager') {
		// SM appends a random 6-char suffix to the ARN; match with `-??????`
		// (Secrets Manager's own recommended wildcard) so the grant scopes to
		// exactly this secret, not a prefix-collision sibling.
		const secretArn = cdk.Stack.of(fn).formatArn({
			service: 'secretsmanager',
			resource: 'secret',
			resourceName: `${locator}-??????`,
			arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
		});
		fn.addToRolePolicy(
			new iam.PolicyStatement({
				actions: ['secretsmanager:GetSecretValue'],
				resources: [secretArn],
			}),
		);
		fn.addToRolePolicy(
			new iam.PolicyStatement({
				actions: ['kms:Decrypt'],
				resources: ['*'],
				conditions: {
					StringEquals: { 'kms:ViaService': `secretsmanager.${region}.amazonaws.com` },
				},
			}),
		);
		return;
	}

	// SSM SecureString (opt-in via store: 'ssm').
	const parameterArn = cdk.Stack.of(fn).formatArn({
		service: 'ssm',
		resource: 'parameter',
		resourceName: locator.replace(/^\//, ''),
	});
	fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [parameterArn] }));
	fn.addToRolePolicy(
		new iam.PolicyStatement({
			actions: ['kms:Decrypt'],
			resources: ['*'],
			conditions: { StringEquals: { 'kms:ViaService': `ssm.${region}.amazonaws.com` } },
		}),
	);
}

// ── SDK seam (store-aware; overridable for tests) ───────────────────────────

export type SecretFetcher = (locator: string) => Promise<string>;

/** Global synth-fetcher override. **For testing only.** */
let synthFetcherOverride: SecretFetcher | null = null;

/** Override the synth-time fetcher. **For testing only.** */
export function _setSynthSecretFetcher(fetcher: SecretFetcher | null): void {
	synthFetcherOverride = fetcher;
}

function defaultSynthFetcher(store: SecretStore): SecretFetcher {
	return store === 'secrets-manager' ? secretsManagerFetcher : ssmFetcher;
}

async function ssmFetcher(name: string): Promise<string> {
	const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
	const client = new SSMClient({});
	const result = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
	const value = result.Parameter?.Value;
	if (value === undefined || value === null) {
		throw new Error(`Secret "${name}" has no value.`);
	}
	return value;
}

async function secretsManagerFetcher(id: string): Promise<string> {
	const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
	const client = new SecretsManagerClient({});
	const result = await client.send(new GetSecretValueCommand({ SecretId: id }));
	const value = result.SecretString;
	if (value === undefined || value === null) {
		throw new Error(`Secret "${id}" has no string value.`);
	}
	return value;
}
