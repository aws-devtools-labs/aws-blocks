// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-aware resolution glue for the `secret()` marker. This is the shared
 * engine that turns an inert {@link SecretValue} into wired infrastructure —
 * relocated here (from `@aws-blocks/core`) so ALL consumers reuse it: the
 * Blocks `Hosting` block, a standalone hosting app, and (the synth-time helpers)
 * `@aws-blocks/pipeline`.
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
import { HostingError } from './hosting_error.js';
import {
	DEFAULT_SECRET_PARAMETER_PREFIX,
	DEFAULT_SECRET_STORE,
	isSecret,
	type SecretStore,
	type SecretValue,
	secretEnvVarName,
	secretFallbackEnvVarName,
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
	/** Backing store. Default {@link DEFAULT_SECRET_STORE} (`'secrets-manager'`). */
	store?: SecretStore;
	/**
	 * Optional environment segment (e.g. `'prod'`, `'beta'`, a PR id). When set,
	 * a secret resolves to `<prefix>/<stage>/<key>` and **falls back** to the
	 * shared `<prefix>/<key>` if the stage-specific value is unset — so a value
	 * can differ per environment while ephemeral/preview stages inherit a shared
	 * default. Omit for a single flat namespace (no fallback, unchanged behavior).
	 */
	stage?: string;
	/**
	 * Runtime cache lifetime in **seconds** for `getSecret()`. When set (and > 0),
	 * a resolved value is re-fetched after this many seconds, so a rotated secret
	 * is picked up by a warm compute without waiting for a cold start (at the cost
	 * of a periodic store read). Omit (or `0`) to cache for the life of the
	 * process — rotation then lands only on the next cold start (unchanged default).
	 * Only affects runtime secrets; synth-time secrets are inlined at deploy.
	 */
	cacheTtlSeconds?: number;
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
				throw new HostingError('SecretKeyMismatchError', {
					message: `Hosting environment '${key}': secret key '${value.key}' must match the environment variable name.`,
					resolution: `Use a matching key: ${key}: secret('${key}').`,
				});
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
	const stage = options.stage;
	const fetcher = options.fetcher ?? synthFetcherOverride ?? defaultSynthFetcher(store);

	const isNotFound = (error: unknown): boolean => {
		const name = (error as { name?: string })?.name;
		return name === 'ParameterNotFound' || name === 'ResourceNotFoundException';
	};

	const resolved = new Map<string, string>();
	await Promise.all(
		keys.map(async (key) => {
			// Stage-specific first; fall back to the shared value if unset.
			const primary = secretStoreLocator(key, { prefix, store, stage });
			const fallback = stage ? secretStoreLocator(key, { prefix, store }) : undefined;
			try {
				resolved.set(key, await fetcher(primary));
				return;
			} catch (error: unknown) {
				if (!isNotFound(error)) throw error;
				if (!fallback) {
					throw new HostingError('UnresolvedSecretError', {
						message: `secret '${key}' is referenced (domain or exposeAsEnv) but not set.`,
						resolution: `Set it before deploying:\n  secret set ${key} <value>`,
					});
				}
			}
			// Fallback attempt (only reached when stage-specific was not found).
			try {
				resolved.set(key, await fetcher(fallback));
			} catch (error: unknown) {
				if (isNotFound(error)) {
					throw new HostingError('UnresolvedSecretError', {
						message: `secret '${key}' is referenced (domain or exposeAsEnv) but set for neither stage '${stage}' nor the shared default.`,
						resolution:
							`Set it before deploying:\n` +
							`  secret set ${key} <value> --stage ${stage}   # or the shared:  secret set ${key} <value>`,
					});
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
			throw new HostingError('UnresolvedSecretError', {
				message: `domain secret('${name.key}') requires async resolution.`,
				resolution: 'Construct with the async create() path (e.g. Hosting.create).',
			});
		}
		return value;
	});
	return Array.isArray(domainName) ? arr : arr[0];
}

/**
 * Inject the store LOCATOR (not the value) for a runtime secret and grant the
 * compute role read+decrypt access scoped to that one parameter/secret.
 *
 * With a `stage`, the primary locator is stage-specific (`<prefix>/<stage>/<key>`)
 * and a *fallback* (shared `<prefix>/<key>`) locator is also injected + granted,
 * so the runtime resolver can fall back to the shared value when the stage has
 * none set. Without a `stage`, only the single shared locator is wired
 * (unchanged behavior).
 *
 * ⚠️ **Shared-fallback trust model.** When a `stage` is set, the compute role is
 * granted standing `GetSecretValue`/`GetParameter` on the shared fallback ARN —
 * the two-try fallback is application logic, not an IAM boundary, so a handler
 * in *any* stage (including an ephemeral PR/preview deploy) can read the shared
 * value directly. Treat the shared slot as a **safe default for all stages**
 * (e.g. a test/sandbox credential), never a production secret. Give production
 * its own stage-scoped value (`secret set KEY <prod-value> --stage prod`) so it
 * is never reachable from a preview stage's role.
 */
export function wireRuntimeSecret(fn: cdk.aws_lambda.Function, key: string, options: SecretResolveOptions = {}): void {
	const prefix = options.prefix ?? DEFAULT_SECRET_PARAMETER_PREFIX;
	const store = options.store ?? DEFAULT_SECRET_STORE;
	const stage = options.stage;

	const primary = secretStoreLocator(key, { prefix, store, stage });
	// Fallback (shared) locator only when a stage is in play and differs.
	const fallback = stage ? secretStoreLocator(key, { prefix, store }) : undefined;

	// Runtime resolver reads the primary locator; the _STORE hint tells it which
	// API, and the _FALLBACK hint (when present) is the shared locator to try
	// if the stage-specific value is not found.
	fn.addEnvironment(secretEnvVarName(key), primary);
	if (store !== 'ssm') fn.addEnvironment(`${secretEnvVarName(key)}_STORE`, store);
	if (fallback) fn.addEnvironment(secretFallbackEnvVarName(key), fallback);

	// Optional runtime cache TTL (global to the function, not per-key). Injected
	// only when configured; the runtime treats absent/0 as "cache until cold start".
	if (options.cacheTtlSeconds && options.cacheTtlSeconds > 0) {
		fn.addEnvironment('HOSTING_SECRET_CACHE_TTL', String(Math.floor(options.cacheTtlSeconds)));
	}

	// Read grant on every locator the runtime might read (primary + fallback),
	// deduped. The KMS Decrypt grant is emitted separately, once, by
	// grantKmsDecrypt — it's identical for every secret in the same store, so
	// per-locator statements would just be duplicates bloating the inline policy.
	const locators = [...new Set([primary, ...(fallback ? [fallback] : [])])];
	for (const locator of locators) {
		grantSecretRead(fn, locator, store);
	}
	grantKmsDecrypt(fn, store);
}

/** Grant a Lambda role least-priv READ on one secret locator (no KMS — see {@link grantKmsDecrypt}). */
function grantSecretRead(fn: cdk.aws_lambda.Function, locator: string, store: SecretStore): void {
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
			new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [secretArn] }),
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
}

/**
 * Grant `kms:Decrypt` for a store's service-default key, once per (function,
 * store). The statement is identical for every secret read through the same
 * store — `Resource: '*'` scoped by `kms:ViaService` — so emitting it per
 * locator would append 2N duplicate statements and push the inline policy
 * toward the 10 KB limit. Idempotent: tracks what it has already granted on the
 * function so repeat calls (multiple secrets, same store) are no-ops.
 */
function grantKmsDecrypt(fn: cdk.aws_lambda.Function, store: SecretStore): void {
	const region = cdk.Stack.of(fn).region;
	const viaService =
		store === 'secrets-manager' ? `secretsmanager.${region}.amazonaws.com` : `ssm.${region}.amazonaws.com`;

	const granted = (kmsDecryptGranted.get(fn) ?? new Set<string>());
	if (granted.has(viaService)) return;
	granted.add(viaService);
	kmsDecryptGranted.set(fn, granted);

	fn.addToRolePolicy(
		new iam.PolicyStatement({
			actions: ['kms:Decrypt'],
			resources: ['*'],
			conditions: { StringEquals: { 'kms:ViaService': viaService } },
		}),
	);
}

/** Per-function set of `kms:ViaService` values already granted (dedupe key). */
const kmsDecryptGranted = new WeakMap<cdk.aws_lambda.Function, Set<string>>();

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
