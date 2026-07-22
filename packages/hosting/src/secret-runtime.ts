// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime resolver for secrets referenced via {@link secret} in
 * `compute.environment`. Inside the running compute (Lambda),
 * `getSecret('STRIPE_KEY')` fetches and decrypts the value and returns it.
 *
 * Resolution order for a key:
 *   1. `process.env[KEY]` — local dev (and the `exposeAsEnv` escape hatch),
 *      where the plaintext is already present. No AWS call, works offline.
 *   2. `process.env[HOSTING_SECRET_PARAM_<KEY>]` — the store LOCATOR the Hosting
 *      wiring injected. `process.env[HOSTING_SECRET_PARAM_<KEY>_STORE]` (if set)
 *      selects the store ('secrets-manager'); default is SSM. Fetch, then cache.
 *
 * The value is held only in process memory and only after the first call;
 * it never lands in git, the CloudFormation template, or the browser.
 *
 * **Cache lifetime.** By default a resolved value is cached for the life of the
 * process, so a rotated secret is only picked up on the next cold start — with
 * steady traffic or provisioned concurrency a warm compute can serve a stale
 * value for a long time. Configure `secrets.cacheTtlSeconds` on the Hosting
 * props to inject `HOSTING_SECRET_CACHE_TTL`; the resolver then re-fetches after
 * the TTL elapses, so rotation lands without a cold start (at the cost of a
 * periodic store read).
 *
 * @module
 */

import { secretEnvVarName, secretFallbackEnvVarName } from './secret.js';

/** True if a store error means "the secret/parameter does not exist". */
function isNotFoundError(error: unknown): boolean {
	const name = (error as { name?: string })?.name;
	return name === 'ParameterNotFound' || name === 'ResourceNotFoundException';
}

/** A cached value plus the epoch-ms after which it is considered stale. */
interface CacheEntry {
	value: string;
	/** Epoch ms when this entry expires; `Infinity` = cache forever (no TTL). */
	expiresAt: number;
}

/** Cache of resolved secret values, keyed by logical secret name. */
const cache = new Map<string, CacheEntry>();
/** In-flight fetches, so concurrent callers for the same key share one call. */
const inFlight = new Map<string, Promise<string>>();

/**
 * Cache lifetime in ms, from `HOSTING_SECRET_CACHE_TTL` (seconds), injected by
 * the Hosting wiring when a TTL is configured. Absent/invalid/`0` → `Infinity`
 * (cache for the life of the process, i.e. until cold start — the historical
 * behavior). A finite TTL lets a warm compute pick up a rotated value without
 * waiting for a cold start.
 */
function cacheTtlMs(): number {
	const raw = process.env.HOSTING_SECRET_CACHE_TTL;
	if (!raw) return Number.POSITIVE_INFINITY;
	const seconds = Number(raw);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Number.POSITIVE_INFINITY;
}

/** Pluggable fetcher so tests can resolve without a live endpoint. */
type StoreFetcher = (locator: string, store: string) => Promise<string>;
let fetcherOverride: StoreFetcher | null = null;

async function defaultFetcher(locator: string, store: string): Promise<string> {
	if (store === 'secrets-manager') {
		const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
		const client = new SecretsManagerClient({
			region: process.env.AWS_REGION,
			requestHandler: { requestTimeout: 5000 },
			maxAttempts: 3,
		});
		const result = await client.send(new GetSecretValueCommand({ SecretId: locator }));
		const value = result.SecretString;
		if (value === undefined || value === null) {
			throw new Error(`[hosting] Secret "${locator}" has no string value.`);
		}
		return value;
	}

	const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
	const client = new SSMClient({
		region: process.env.AWS_REGION,
		requestHandler: { requestTimeout: 5000 },
		maxAttempts: 3,
	});
	const result = await client.send(new GetParameterCommand({ Name: locator, WithDecryption: true }));
	const value = result.Parameter?.Value;
	if (value === undefined || value === null) {
		throw new Error(
			`[hosting] Secret parameter "${locator}" exists but has no value. ` +
				`Set it with your secret CLI (e.g. \`secret set <KEY> <value>\`).`,
		);
	}
	return value;
}

/**
 * Resolve a secret value at runtime.
 *
 * @param key - The logical secret name, exactly as passed to `secret('<key>')`.
 * @returns The decrypted plaintext value.
 * @throws If the secret is neither present in `process.env` nor backed by an
 *   injected locator — i.e. the reference was never wired or never set.
 */
export async function getSecret(key: string): Promise<string> {
	const cached = cache.get(key);
	if (cached !== undefined && Date.now() < cached.expiresAt) return cached.value;

	// 1. Plaintext already in env (local dev, or exposeAsEnv escape hatch).
	const direct = process.env[key];
	if (direct !== undefined) {
		// Env-var values can't rotate under a running process, so cache forever.
		cache.set(key, { value: direct, expiresAt: Number.POSITIVE_INFINITY });
		return direct;
	}

	// 2. Store locator injected by the Hosting wiring.
	const envName = secretEnvVarName(key);
	const locator = process.env[envName];
	if (!locator) {
		throw new Error(
			`[hosting] getSecret(${JSON.stringify(key)}): no secret reference found. ` +
				`Reference it in Hosting props with secret(${JSON.stringify(key)}) so the ` +
				`parameter is wired, and set its value with your secret CLI ` +
				`(e.g. \`secret set ${key} <value>\`).`,
		);
	}
	const store = process.env[`${envName}_STORE`] ?? 'ssm';
	// Optional shared/fallback locator, injected only for stage-scoped secrets.
	const fallbackLocator = process.env[secretFallbackEnvVarName(key)];

	const existing = inFlight.get(key);
	if (existing) return existing;

	const fetcher = fetcherOverride ?? defaultFetcher;
	// Try the primary (stage-specific) locator; on not-found, fall back to the
	// shared locator when one was wired. Cache whichever wins.
	const promise = fetcher(locator, store)
		.catch((error: unknown) => {
			if (fallbackLocator && isNotFoundError(error)) {
				return fetcher(fallbackLocator, store);
			}
			throw error;
		})
		.then((value) => {
			const ttl = cacheTtlMs();
			const expiresAt = ttl === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Date.now() + ttl;
			cache.set(key, { value, expiresAt });
			return value;
		})
		.finally(() => {
			inFlight.delete(key);
		});
	inFlight.set(key, promise);
	return promise;
}

/** Reset cached secrets and any fetcher override. **For testing only.** */
export function _resetSecretCache(): void {
	cache.clear();
	inFlight.clear();
	fetcherOverride = null;
}

/** Override the fetcher. **For testing only.** */
export function _setSecretFetcher(fetcher: StoreFetcher | null): void {
	fetcherOverride = fetcher;
}
