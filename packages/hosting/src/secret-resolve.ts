// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-aware resolution glue for the `secret()` / `config()` markers, plus BYO
 * (bring-your-own) `ISecret` / `IParameter` handles. Turns an inert marker (or an
 * existing CDK handle) into wired infrastructure — reused by the Blocks `Hosting`
 * block, a standalone hosting app, and `@aws-blocks/pipeline`.
 *
 * The store is derived from the marker's kind ({@link storeForKind}): `secret`
 * → Secrets Manager, `config` → SSM Parameter Store. Each kind uses its own
 * runtime env prefix and its own per-construct namespace config
 * (`secretStore` / `configStore`).
 *
 * Two resolution strategies, by where the marker appears:
 *   • `environment` — inject the store LOCATOR (never the value) + grant the
 *     compute role read+decrypt; `getSecret()`/`getConfig()` fetch at runtime.
 *   • `domain.domainName` — resolved at SYNTH via an SDK read and inlined (a
 *     domain must be a literal before CloudFront/ACM are built).
 *
 * @module
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { IParameter } from 'aws-cdk-lib/aws-ssm';
import { HostingError } from './hosting_error.js';
import {
	type ConfigValue,
	cacheTtlEnvVarName,
	configEnvVarName,
	defaultPrefixForKind,
	envVarNameForKind,
	jsonFlagEnvVarName,
	fallbackEnvVarName,
	isManagedValue,
	type ManagedValue,
	type SecretStore,
	secretEnvVarName,
	secretStoreLocator,
	storeForKind,
	type ValueKind,
} from './secret.js';

export type { SecretStore };

/** Per-kind namespace/cache config (one for `secretStore`, one for `configStore`). */
export interface KindStoreOptions {
	/** Store path prefix (no trailing slash). Defaults to the kind's neutral prefix. */
	prefix?: string;
	/**
	 * Optional environment segment; a value resolves to `<prefix>/<stage>/<key>` and
	 * falls back to the shared `<prefix>/<key>`.
	 *
	 * ⚠️ **`stage` is NOT a security boundary.** To make the fallback work, the IAM
	 * grant is *static* and gives the compute standing read on **both** the stage
	 * locator and the shared `<prefix>/<key>`. So every stage sharing a prefix can
	 * read the shared value — keep production-only secrets in a stage-scoped slot,
	 * and put only a safe cross-stage default (e.g. a sandbox credential) in the
	 * shared slot. Two `Hosting`/`Pipeline` constructs sharing a prefix are **not**
	 * isolated from each other.
	 */
	stage?: string;
	/** Runtime cache TTL (seconds) for this kind's getter; omit/`0` = cache for the process life. */
	cacheTtlSeconds?: number;
}

/** Split construct config: separate namespace/cache settings per kind. */
export interface StoreConfig {
	/** Config for `secret()` values (AWS Secrets Manager). */
	secretStore?: KindStoreOptions;
	/** Config for `config()` values (SSM Parameter Store). */
	configStore?: KindStoreOptions;
}

/** A `compute.environment` value: a literal, a managed marker, or a BYO CDK handle. */
export type EnvValue = string | ManagedValue | ISecret | IParameter;

/**
 * A custom-domain name: a literal, a `config()` marker, or a mix in an array.
 *
 * Only `config()` (non-sensitive → SSM) is accepted here, never `secret()`: a
 * domain is resolved at **synth time** and inlined as a literal into the
 * CloudFormation template (CloudFront/ACM need a literal), so a `secret()` would
 * leak its plaintext into the template. Domains are public anyway — use `config()`.
 */
export type DomainNameInput = string | ConfigValue | Array<string | ConfigValue>;

/** A BYO handle bound to a logical key, tagged with the kind it resolves as. */
export interface ByoBinding {
	key: string;
	kind: ValueKind;
	handle: ISecret | IParameter;
}

// ── BYO handle detection (duck-typed; cross-copy-safe) ──────────────────────

/** Duck-typed guard for a BYO CDK Secrets Manager handle (`ISecret`). */
export function isCdkSecret(v: unknown): v is ISecret {
	return typeof v === 'object' && v !== null && 'secretArn' in v && 'grantRead' in v;
}
/** Duck-typed guard for a BYO CDK SSM parameter handle (`IParameter`). */
export function isCdkParameter(v: unknown): v is IParameter {
	return typeof v === 'object' && v !== null && 'parameterArn' in v && 'grantRead' in v;
}

/** Resolve the effective per-kind options from the split store config. */
function optsForKind(kind: ValueKind, cfg: StoreConfig): Required<Pick<KindStoreOptions, 'prefix'>> & KindStoreOptions {
	const k = kind === 'secret' ? cfg.secretStore : cfg.configStore;
	return { prefix: k?.prefix ?? defaultPrefixForKind(kind), stage: k?.stage, cacheTtlSeconds: k?.cacheTtlSeconds };
}

/**
 * Split an environment map into plain literals, managed markers, and BYO handles.
 * @internal
 */
export function partitionEnvironment(environment: Record<string, EnvValue> | undefined): {
	plain: Record<string, string>;
	managed: ManagedValue[];
	byo: ByoBinding[];
} {
	const plain: Record<string, string> = {};
	const managed: ManagedValue[] = [];
	const byo: ByoBinding[] = [];

	for (const [key, val] of Object.entries(environment ?? {})) {
		if (isManagedValue(val)) {
			if (val.key !== key) {
				throw new HostingError('SecretKeyMismatchError', {
					message: `Hosting environment '${key}': ${val.kind} key '${val.key}' must match the environment variable name.`,
					resolution: `Use a matching key: ${key}: ${val.kind}('${key}').`,
				});
			}
			managed.push(val);
		} else if (isCdkSecret(val)) {
			byo.push({ key, kind: 'secret', handle: val });
		} else if (isCdkParameter(val)) {
			byo.push({ key, kind: 'config', handle: val });
		} else {
			plain[key] = val;
		}
	}
	return { plain, managed, byo };
}

/** Every managed marker that requires a synth-time fetch (domain markers only). * @internal
 */
export function collectSynthMarkers(domainName: DomainNameInput | undefined): ManagedValue[] {
	const byKey = new Map<string, ManagedValue>();
	for (const name of toDomainArray(domainName)) {
		if (isManagedValue(name)) byKey.set(name.key, name);
	}
	return [...byKey.values()];
}

function toDomainArray(domainName: DomainNameInput | undefined): Array<string | ManagedValue> {
	if (domainName === undefined) return [];
	return Array.isArray(domainName) ? domainName : [domainName];
}

/**
 * Resolve managed markers to plaintext at synth time via each marker's derived
 * store + per-kind prefix. Throws an actionable error if a referenced value was
 * never set.
 * @internal
 */
export async function resolveSecretsAtSynth(
	markers: ManagedValue[],
	cfg: StoreConfig & { fetcher?: SecretFetcher } = {},
): Promise<Map<string, string>> {
	const isNotFound = (error: unknown): boolean => {
		const name = (error as { name?: string })?.name;
		return name === 'ParameterNotFound' || name === 'ResourceNotFoundException';
	};

	const resolved = new Map<string, string>();
	await Promise.all(
		markers.map(async (marker) => {
			const key = marker.key;
			const store = storeForKind(marker.kind);
			const { prefix, stage } = optsForKind(marker.kind, cfg);
			const fetcher = cfg.fetcher ?? synthFetcherOverride ?? defaultSynthFetcher(store);
			const primary = secretStoreLocator(key, { prefix, store, stage });
			const fallback = stage ? secretStoreLocator(key, { prefix, store }) : undefined;
			try {
				resolved.set(key, await fetcher(primary));
				return;
			} catch (error: unknown) {
				if (!isNotFound(error)) throw error;
				if (!fallback) {
					throw new HostingError('UnresolvedSecretError', {
						message: `${marker.kind} '${key}' is referenced (domain) but not set.`,
						resolution: `Set it before deploying:\n  ${marker.kind} set ${key} …`,
					});
				}
			}
			try {
				resolved.set(key, await fetcher(fallback));
			} catch (error: unknown) {
				if (isNotFound(error)) {
					throw new HostingError('UnresolvedSecretError', {
						message: `${marker.kind} '${key}' is referenced (domain) but set for neither stage '${stage}' nor the shared default.`,
						resolution: `Set it:\n  ${marker.kind} set ${key} … --stage ${stage}   # or shared:  ${marker.kind} set ${key} …`,
					});
				}
				throw error;
			}
		}),
	);
	return resolved;
}

/**
 * Confirms a locator EXISTS without fetching its value — a secret must never enter
 * the synth process. Resolves when present; throws `ParameterNotFound` /
 * `ResourceNotFoundException` when absent.
 * @internal
 */
export type SynthExistsChecker = (locator: string, store: SecretStore) => Promise<void>;
let synthExistsOverride: SynthExistsChecker | null = null;

/** Override the synth-time existence checker. **For testing only.** @internal */
export function _setSynthExistsChecker(checker: SynthExistsChecker | null): void {
	synthExistsOverride = checker;
}

/** Metadata-only existence probe: `DescribeSecret` (SM) / `GetParameter` without decryption (SSM). */
function defaultSynthExistsChecker(): SynthExistsChecker {
	return async (locator, store) => {
		if (store === 'secrets-manager') {
			const { SecretsManagerClient, DescribeSecretCommand } = await import('@aws-sdk/client-secrets-manager');
			await new SecretsManagerClient({}).send(new DescribeSecretCommand({ SecretId: locator }));
			return;
		}
		const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
		// WithDecryption:false — confirm presence without materialising a SecureString value.
		await new SSMClient({}).send(new GetParameterCommand({ Name: locator, WithDecryption: false }));
	};
}

/**
 * Fail synth when a referenced `environment` marker has no value set — **existence
 * only, never a value fetch** (a secret must not enter the synth process). This is
 * the same deploy-time failure the domain path gives ({@link resolveSecretsAtSynth}),
 * applied to runtime `environment` markers so a missing value fails at deploy rather
 * than on a customer request. When a `stage` is set, a stage-specific value OR the
 * shared default satisfies the check. Skips silently when existence cannot be
 * determined (e.g. no credentials during a local `cdk synth`); throws only on a
 * definitive not-found.
 * @internal
 */
export async function assertMarkersExistAtSynth(markers: ManagedValue[], cfg: StoreConfig = {}): Promise<void> {
	if (markers.length === 0) return;
	const isNotFound = (error: unknown): boolean => {
		const name = (error as { name?: string })?.name;
		return name === 'ParameterNotFound' || name === 'ResourceNotFoundException';
	};
	const check = synthExistsOverride ?? defaultSynthExistsChecker();

	await Promise.all(
		markers.map(async (marker) => {
			const store = storeForKind(marker.kind);
			const { prefix, stage } = optsForKind(marker.kind, cfg);
			const primary = secretStoreLocator(marker.key, { prefix, store, stage });
			const fallback = stage ? secretStoreLocator(marker.key, { prefix, store }) : undefined;

			try {
				await check(primary, store);
				return; // exists
			} catch (error: unknown) {
				if (!isNotFound(error)) return; // couldn't determine (no creds/etc.) — don't block synth
			}
			if (fallback) {
				try {
					await check(fallback, store);
					return; // shared default exists
				} catch (error: unknown) {
					if (!isNotFound(error)) return;
				}
			}
			throw new HostingError('UnresolvedSecretError', {
				message: `${marker.kind} '${marker.key}' is referenced (environment) but not set${
					stage ? ` for stage '${stage}' nor the shared default` : ''
				}.`,
				resolution: `Set it before deploying:\n  ${marker.kind} set ${marker.key} …${stage ? ` --stage ${stage}` : ''}`,
			});
		}),
	);
}

/** Resolve domain markers to literals using the synth-resolved value map. * @internal
 */
export function resolveDomainNames(domainName: DomainNameInput, resolved: Map<string, string>): string | string[] {
	const arr = toDomainArray(domainName).map((name) => {
		if (!isManagedValue(name)) return name;
		const val = resolved.get(name.key);
		if (val === undefined) {
			throw new HostingError('UnresolvedSecretError', {
				message: `domain ${name.kind}('${name.key}') requires async resolution.`,
				resolution: 'Construct with the async create() path (e.g. Hosting.create).',
			});
		}
		return val;
	});
	return Array.isArray(domainName) ? arr : arr[0];
}

/**
 * Inject the store LOCATOR (not the value) for a runtime managed marker and grant
 * the compute role read+decrypt scoped to that one parameter/secret. Store, env
 * prefix, namespace, and cache TTL are all derived from the marker's kind.
 *
 * **Trust boundary (stage fallback).** When a `stage` is configured the runtime
 * tries `<prefix>/<stage>/<key>` first and falls back to the shared
 * `<prefix>/<key>`. The IAM grant here is STATIC, so the compute role gets
 * standing read on BOTH locators — not just the one a given request resolves. A
 * stage's compute can therefore always read the shared value (that is what makes
 * the fallback work), so treat the shared entry as readable by every stage that
 * shares this prefix and put stage-private values under the stage locator only.
 * @internal
 */
export function wireManagedValue(fn: cdk.aws_lambda.Function, marker: ManagedValue, cfg: StoreConfig = {}): void {
	const { key, kind } = marker;
	const store = storeForKind(kind);
	const { prefix, stage, cacheTtlSeconds } = optsForKind(kind, cfg);
	const envName = envVarNameForKind(kind, key);

	const primary = secretStoreLocator(key, { prefix, store, stage });
	const fallback = stage ? secretStoreLocator(key, { prefix, store }) : undefined;

	fn.addEnvironment(envName, primary);
	if (fallback) fn.addEnvironment(fallbackEnvVarName(envName), fallback);
	if (cacheTtlSeconds && cacheTtlSeconds > 0) {
		fn.addEnvironment(cacheTtlEnvVarName(kind), String(Math.floor(cacheTtlSeconds)));
	}
	// A schema means the value is JSON: flag it so the runtime getter parses it
	// (returning the schema's inferred type that typegen puts on the getter).
	if (marker.schema) fn.addEnvironment(jsonFlagEnvVarName(kind, key), '1');

	for (const locator of [...new Set([primary, ...(fallback ? [fallback] : [])])]) {
		grantStoreRead(fn, locator, store);
	}
	grantKmsDecrypt(fn, store);
}

/**
 * Wire a BYO (existing) CDK handle: grant read via the handle's own `grantRead`
 * (which also covers KMS for the handle's key) and inject its locator under the
 * kind-appropriate env prefix, so `getSecret`/`getConfig` resolve it identically.
 * @internal
 */
export function wireByo(fn: cdk.aws_lambda.Function, binding: ByoBinding, cfg: StoreConfig = {}): void {
	const { key, kind, handle } = binding;
	handle.grantRead(fn);
	if (kind === 'secret') {
		fn.addEnvironment(secretEnvVarName(key), (handle as ISecret).secretName);
	} else {
		fn.addEnvironment(configEnvVarName(key), (handle as IParameter).parameterName);
	}
	const { cacheTtlSeconds } = optsForKind(kind, cfg);
	if (cacheTtlSeconds && cacheTtlSeconds > 0) {
		fn.addEnvironment(cacheTtlEnvVarName(kind), String(Math.floor(cacheTtlSeconds)));
	}
}

function grantStoreRead(fn: cdk.aws_lambda.Function, locator: string, store: SecretStore): void {
	if (store === 'secrets-manager') {
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
	const parameterArn = cdk.Stack.of(fn).formatArn({
		service: 'ssm',
		resource: 'parameter',
		resourceName: locator.replace(/^\//, ''),
	});
	fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [parameterArn] }));
}

function grantKmsDecrypt(fn: cdk.aws_lambda.Function, store: SecretStore): void {
	const region = cdk.Stack.of(fn).region;
	const viaService =
		store === 'secrets-manager' ? `secretsmanager.${region}.amazonaws.com` : `ssm.${region}.amazonaws.com`;
	const granted = kmsDecryptGranted.get(fn) ?? new Set<string>();
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

const kmsDecryptGranted = new WeakMap<cdk.aws_lambda.Function, Set<string>>();

// ── SDK seam (store-aware; overridable for tests) ───────────────────────────

export type SecretFetcher = (locator: string) => Promise<string>;
let synthFetcherOverride: SecretFetcher | null = null;

/** Override the synth-time fetcher. **For testing only.** * @internal
 */
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
	if (value === undefined || value === null) throw new Error(`Value "${name}" has no value.`);
	return value;
}

async function secretsManagerFetcher(id: string): Promise<string> {
	const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
	const client = new SecretsManagerClient({});
	const result = await client.send(new GetSecretValueCommand({ SecretId: id }));
	const value = result.SecretString;
	if (value === undefined || value === null) throw new Error(`Value "${id}" has no string value.`);
	return value;
}
