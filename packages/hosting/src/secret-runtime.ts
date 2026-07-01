// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime resolver for secrets referenced via {@link secret} in
 * `compute.environment`. This is the code that exchanges the coat-check ticket
 * for the coat: inside the running compute (Lambda), `getSecret('STRIPE_KEY')`
 * fetches and decrypts the SSM SecureString and returns the plaintext value.
 *
 * Resolution order for a key:
 *   1. `process.env[KEY]` — local dev (and the `exposeAsEnv` escape hatch),
 *      where the plaintext is already present. No AWS call, works offline.
 *   2. `process.env[BLOCKS_SECRET_PARAM_<KEY>]` — the SSM parameter NAME the
 *      Hosting wiring injected. Fetch + decrypt via SSM, then cache.
 *
 * The value is held only in process memory and only after the first call;
 * it never lands in git, the CloudFormation template, or the browser.
 *
 * Mirrors the resolve-once-then-cache shape used by `bb-app-setting` and the
 * `bb-data` external-connection-string reader.
 *
 * @module
 */

import { secretEnvVarName } from './secret.js';

/** Cache of resolved secret values, keyed by logical secret name. */
const cache = new Map<string, string>();
/** In-flight fetches, so concurrent callers for the same key share one SSM call. */
const inFlight = new Map<string, Promise<string>>();

/** Pluggable fetcher so tests can resolve without a live SSM endpoint. */
type SsmFetcher = (parameterName: string) => Promise<string>;
let fetcherOverride: SsmFetcher | null = null;

async function defaultSsmFetcher(parameterName: string): Promise<string> {
	const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
	const client = new SSMClient({
		region: process.env.AWS_REGION,
		requestHandler: { requestTimeout: 5000 },
		maxAttempts: 3,
	});
	const result = await client.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
	const value = result.Parameter?.Value;
	if (value === undefined || value === null) {
		throw new Error(
			`[Blocks] Secret parameter "${parameterName}" exists but has no value. ` +
				`Set it with: blocks secret set <KEY> <value>`,
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
 *   injected SSM parameter name — i.e. the reference was never wired (no
 *   matching `secret()` in `Hosting` props) or the value was never set.
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

	// 2. SSM parameter name injected by the Hosting wiring.
	const parameterName = process.env[secretEnvVarName(key)];
	if (!parameterName) {
		throw new Error(
			`[Blocks] getSecret(${JSON.stringify(key)}): no secret reference found. ` +
				`Reference it in Hosting props with secret(${JSON.stringify(key)}) so the ` +
				`parameter is wired, and set its value with: blocks secret set ${key} <value>`,
		);
	}

	const existing = inFlight.get(key);
	if (existing) return existing;

	const fetcher = fetcherOverride ?? defaultSsmFetcher;
	const promise = fetcher(parameterName)
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

/** Override the SSM fetcher. **For testing only.** */
export function _setSecretFetcher(fetcher: SsmFetcher | null): void {
	fetcherOverride = fetcher;
}
