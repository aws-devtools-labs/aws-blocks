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
 * ⚠️ **Local-dev caveat:** step 1 keys off the bare `process.env[KEY]`, which is
 * NOT kind-prefixed — so if you declare both `secret('K')` and `config('K')`, a
 * single `.env` entry `K=…` satisfies BOTH `getSecret('K')` and `getConfig('K')`
 * locally. The per-kind namespace independence (secret ≠ config for the same key)
 * only holds on the deployed store path (step 2), where each getter reads its own
 * `HOSTING_SECRET_PARAM_*` / `HOSTING_CONFIG_PARAM_*` locator. Reusing the same key
 * name for both a secret and a config is best avoided for exactly this reason.
 *
 * **Cache lifetime.** By default a resolved value is cached for the life of the
 * process (rotation lands on the next cold start). Set `secretStore.cacheTtlSeconds`
 * / `configStore.cacheTtlSeconds` on the construct to inject a per-kind TTL so a
 * warm compute re-fetches after the TTL — rotation without a cold start.
 *
 * @module
 */

import {
	cacheTtlEnvVarName,
	envVarNameForKind,
	fallbackEnvVarName,
	jsonFlagEnvVarName,
	storeForKind,
	type ValueKind,
} from './secret.js';

function isNotFoundError(error: unknown): boolean {
	const name = (error as { name?: string })?.name;
	return name === 'ParameterNotFound' || name === 'ResourceNotFoundException';
}

interface CacheEntry {
	/** The resolved value — the raw string, or the JSON-parsed value when a schema was declared. */
	value: unknown;
	/** Epoch ms when this entry expires; `Infinity` = cache for the process life. */
	expiresAt: number;
}

/** Cache keyed by `${kind}:${key}` (secret and config namespaces are distinct). */
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();

/**
 * When a marker declared a `schema`, the Hosting wiring sets a per-key JSON flag
 * env var; parse the stored string so the returned value matches the schema's
 * inferred type (parse-only — deep validation would need the schema at runtime,
 * which does not cross the synth→runtime bundle boundary).
 */
function finalizeValue(kind: ValueKind, key: string, raw: string): unknown {
	if (process.env[jsonFlagEnvVarName(kind, key)] === undefined) return raw;
	try {
		return JSON.parse(raw);
	} catch {
		const getter = kind === 'secret' ? 'getSecret' : 'getConfig';
		throw new Error(
			`[hosting] ${getter}(${JSON.stringify(key)}): a schema was declared but the stored value is not valid JSON.`,
		);
	}
}

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
async function resolveValue(kind: ValueKind, key: string): Promise<unknown> {
	const cacheKey = `${kind}:${key}`;
	const cached = cache.get(cacheKey);
	if (cached !== undefined && Date.now() < cached.expiresAt) return cached.value;

	// 1. Plaintext already in env (local dev).
	const direct = process.env[key];
	if (direct !== undefined) {
		const value = finalizeValue(kind, key, direct);
		cache.set(cacheKey, { value, expiresAt: Number.POSITIVE_INFINITY });
		return value;
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
		.then((raw) => {
			const value = finalizeValue(kind, key, raw);
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
 * Type-safe key registry for {@link getSecret} — **empty by default**, populated by
 * declaration merging (module augmentation). When it has no members, `getSecret`
 * accepts any `string` (the loose default); once keys are merged in, `getSecret`
 * narrows to exactly those keys, giving editor autocomplete and a compile error on
 * a typo. Nothing else changes — the value is still fetched from Secrets Manager at
 * runtime.
 *
 * You normally never write this by hand: `npm run typegen` scans your app's
 * `secret('...')` calls and generates a `.d.ts` that augments it. To do it manually:
 *
 * ```ts
 * declare module '@aws-blocks/hosting' {
 *   interface HostingSecretRegistry {
 *     STRIPE_KEY: string;
 *   }
 * }
 * ```
 *
 * @see {@link HostingConfigRegistry} for the `config()` / `getConfig` counterpart.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally empty — customers/codegen augment it via declaration merging.
export interface HostingSecretRegistry {}

/**
 * Type-safe key registry for {@link getConfig} — the SSM/`config()` counterpart to
 * {@link HostingSecretRegistry}. Empty by default (any `string`); augment it (via
 * `npm run typegen` or by hand) to narrow `getConfig` to your declared config keys.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally empty — customers/codegen augment it via declaration merging.
export interface HostingConfigRegistry {}

/**
 * The key type accepted by {@link getSecret}: the union of registered secret keys,
 * or the open `string` when the registry is empty (unadopted apps keep the loose
 * DX). `Extract<…, string>` keeps it cast-free (registry keys are always strings).
 */
export type SecretKey = keyof HostingSecretRegistry extends never
	? string
	: Extract<keyof HostingSecretRegistry, string>;

/** The key type accepted by {@link getConfig} — see {@link SecretKey}. */
export type ConfigKey = keyof HostingConfigRegistry extends never
	? string
	: Extract<keyof HostingConfigRegistry, string>;

/**
 * The resolved value type for a secret `key`: the schema's inferred output type
 * when `secret(key, { schema })` was declared (typegen inlines it into the
 * registry), otherwise `string`. Falls back to `string` for an unadopted app.
 */
export type SecretValueOf<K extends SecretKey> = keyof HostingSecretRegistry extends never
	? string
	: K extends keyof HostingSecretRegistry
		? HostingSecretRegistry[K]
		: string;

/** The resolved value type for a config `key` — see {@link SecretValueOf}. */
export type ConfigValueOf<K extends ConfigKey> = keyof HostingConfigRegistry extends never
	? string
	: K extends keyof HostingConfigRegistry
		? HostingConfigRegistry[K]
		: string;

/**
 * Resolve a **secret** (AWS Secrets Manager) at runtime.
 *
 * **Local development.** Reads `process.env.KEY` first, so a `.env` file supplies
 * the value with no AWS call. On a deployed function it falls through to fetching
 * the wired secret from Secrets Manager.
 *
 * **Type safety.** `key` is typed as {@link SecretKey}: by default any `string`, but
 * once you run `npm run typegen` (which generates a `.d.ts` augmenting
 * {@link HostingSecretRegistry} from your `secret('...')` calls) it narrows to your
 * declared keys — autocomplete, and a typo is a compile error. When you declared a
 * `schema` (`secret('K', { schema })`), the **return type is the schema's inferred
 * output** and the value is **JSON-parsed** at runtime; otherwise it is `string`.
 *
 * @param key - The logical name, exactly as passed to `secret('<key>')`.
 * @returns The value — parsed to the schema's type when a schema was declared, else the decrypted string.
 * @throws If the key is neither in `process.env` nor backed by an injected locator.
 */
export function getSecret<K extends SecretKey>(key: K): Promise<SecretValueOf<K>> {
	// Runtime yields the parsed value or the raw string; the precise type comes from
	// the typegen-augmented registry, so assert it here (framework-internal).
	return resolveValue('secret', key) as Promise<SecretValueOf<K>>;
}

/**
 * Resolve a **config** value (SSM Parameter Store) at runtime. Same resolution
 * order as {@link getSecret} (env-first for local dev, then the injected locator).
 *
 * **Type safety.** `key` is typed as {@link ConfigKey} — any `string` by default,
 * narrowing to your declared config keys after `npm run typegen` (see {@link getSecret}).
 * With `config('K', { schema })` the return type is the schema's inferred output and
 * the value is JSON-parsed at runtime — no `JSON.parse(...)` and no `any`.
 *
 * @param key - The logical name, exactly as passed to `config('<key>')`.
 * @returns The value — parsed to the schema's type when a schema was declared, else the string.
 * @throws If the key is neither in `process.env` nor backed by an injected locator.
 */
export function getConfig<K extends ConfigKey>(key: K): Promise<ConfigValueOf<K>> {
	return resolveValue('config', key) as Promise<ConfigValueOf<K>>;
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
