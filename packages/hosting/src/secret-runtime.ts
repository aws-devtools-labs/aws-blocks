// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime resolvers for values referenced via {@link secret} / {@link config}.
 * Inside the running compute (Lambda):
 *
 * - `getSecret('STRIPE_KEY')` fetches + decrypts from **AWS Secrets Manager**.
 * - `getConfig('FEATURE_FLAGS')` fetches from **SSM Parameter Store**.
 *
 * Each reads its own injected locator env var (`HOSTING_SECRET_PARAM_<KEY>` vs
 * `HOSTING_CONFIG_PARAM_<KEY>`), so the store is unambiguous per getter — no
 * runtime store hint needed.
 *
 * **Resolution order** for a key:
 *   1. `process.env[KEY]` — local dev; put the value in a `.env` file, no AWS call.
 *   2. the injected store locator — fetch, then cache.
 *
 * **Cache lifetime.** By default a resolved value is cached for the life of the
 * process (rotation lands on the next cold start). Set `secretStore.cacheTtlSeconds`
 * / `configStore.cacheTtlSeconds` on the construct to inject a per-kind TTL so a
 * warm compute re-fetches after the TTL — rotation without a cold start.
 *
 * @module
 */

import { cacheTtlEnvVarName, envVarNameForKind, fallbackEnvVarName, storeForKind, type ValueKind } from './secret.js';

function isNotFoundError(error: unknown): boolean {
	const name = (error as { name?: string })?.name;
	return name === 'ParameterNotFound' || name === 'ResourceNotFoundException';
}

interface CacheEntry {
	value: string;
	/** Epoch ms when this entry expires; `Infinity` = cache for the process life. */
	expiresAt: number;
}

/** Cache keyed by `${kind}:${key}` (secret and config namespaces are distinct). */
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string>>();

function cacheTtlMs(kind: ValueKind): number {
	const raw = process.env[cacheTtlEnvVarName(kind)];
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
			throw new Error(`[hosting] secret "${locator}" has no string value.`);
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
		throw new Error(`[hosting] parameter "${locator}" exists but has no value.`);
	}
	return value;
}

/** Shared resolver for both kinds. */
async function resolveValue(kind: ValueKind, key: string): Promise<string> {
	const cacheKey = `${kind}:${key}`;
	const cached = cache.get(cacheKey);
	if (cached !== undefined && Date.now() < cached.expiresAt) return cached.value;

	// 1. Plaintext already in env (local dev).
	const direct = process.env[key];
	if (direct !== undefined) {
		cache.set(cacheKey, { value: direct, expiresAt: Number.POSITIVE_INFINITY });
		return direct;
	}

	// 2. Store locator injected by the Hosting wiring.
	const envName = envVarNameForKind(kind, key);
	const locator = process.env[envName];
	if (!locator) {
		const fn = kind === 'secret' ? 'secret' : 'config';
		const getter = kind === 'secret' ? 'getSecret' : 'getConfig';
		throw new Error(
			`[hosting] ${getter}(${JSON.stringify(key)}): no ${kind} reference found. ` +
				`Reference it in Hosting props with ${fn}(${JSON.stringify(key)}) so the store locator ` +
				`is wired, and set its value with your CLI (e.g. \`${fn} set ${key} …\`).`,
		);
	}
	const store = storeForKind(kind);
	const fallbackLocator = process.env[fallbackEnvVarName(envName)];

	const existing = inFlight.get(cacheKey);
	if (existing) return existing;

	const fetcher = fetcherOverride ?? defaultFetcher;
	const promise = fetcher(locator, store)
		.catch((error: unknown) => {
			if (fallbackLocator && isNotFoundError(error)) return fetcher(fallbackLocator, store);
			throw error;
		})
		.then((value) => {
			const ttl = cacheTtlMs(kind);
			const expiresAt = ttl === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Date.now() + ttl;
			cache.set(cacheKey, { value, expiresAt });
			return value;
		})
		.finally(() => {
			inFlight.delete(cacheKey);
		});
	inFlight.set(cacheKey, promise);
	return promise;
}

/**
 * Resolve a **secret** (AWS Secrets Manager) at runtime.
 *
 * **Local development.** Reads `process.env.KEY` first, so a `.env` file supplies
 * the value with no AWS call. On a deployed function it falls through to fetching
 * the wired secret from Secrets Manager.
 *
 * @param key - The logical name, exactly as passed to `secret('<key>')`.
 * @returns The decrypted plaintext value.
 * @throws If the key is neither in `process.env` nor backed by an injected locator.
 */
export function getSecret(key: string): Promise<string> {
	return resolveValue('secret', key);
}

/**
 * Resolve a **config** value (SSM Parameter Store) at runtime. Same resolution
 * order as {@link getSecret} (env-first for local dev, then the injected locator).
 *
 * @param key - The logical name, exactly as passed to `config('<key>')`.
 * @returns The value.
 * @throws If the key is neither in `process.env` nor backed by an injected locator.
 */
export function getConfig(key: string): Promise<string> {
	return resolveValue('config', key);
}

/** Reset cached values and any fetcher override. **For testing only.** */
export function _resetSecretCache(): void {
	cache.clear();
	inFlight.clear();
	fetcherOverride = null;
}

/** Override the fetcher. **For testing only.** */
export function _setSecretFetcher(fetcher: StoreFetcher | null): void {
	fetcherOverride = fetcher;
}
