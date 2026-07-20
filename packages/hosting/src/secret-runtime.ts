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
 * @module
 */

import { secretEnvVarName, secretFallbackEnvVarName } from './secret.js';

/** True if a store error means "the secret/parameter does not exist". */
function isNotFoundError(error: unknown): boolean {
	const name = (error as { name?: string })?.name;
	return name === 'ParameterNotFound' || name === 'ResourceNotFoundException';
}

/** Cache of resolved secret values, keyed by logical secret name. */
const cache = new Map<string, string>();
/** In-flight fetches, so concurrent callers for the same key share one call. */
const inFlight = new Map<string, Promise<string>>();

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
	if (cached !== undefined) return cached;

	// 1. Plaintext already in env (local dev, or exposeAsEnv escape hatch).
	const direct = process.env[key];
	if (direct !== undefined) {
		cache.set(key, direct);
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
			cache.set(key, value);
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
