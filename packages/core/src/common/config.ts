// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime config loader for Building Blocks.
 *
 * At deploy time, BB resource mappings (ARNs, URLs, paths) are stored in an
 * S3 JSON file instead of Lambda environment variables (which have a 4KB limit).
 * This module loads that config file once at cold start and caches it.
 *
 * Lookup order for each key:
 * 1. `process.env[key]` — local dev where env vars are set directly
 * 2. Cached S3 config — loaded once per cold start
 *
 * @module
 */

let configCache: Record<string, string> | null = null;
let configLoadPromise: Promise<Record<string, string>> | null = null;

type S3Fetcher = (bucket: string, key: string) => Promise<string>;
let s3FetcherOverride: S3Fetcher | null = null;

async function defaultS3Fetcher(bucket: string, key: string): Promise<string> {
	const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
	const client = new S3Client({
		region: process.env.AWS_REGION,
		requestHandler: { requestTimeout: 5000 },
		maxAttempts: 3,
	});
	const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
	const body = await response.Body?.transformToString('utf-8');
	if (!body) throw new Error('Empty config file');
	return body;
}

/**
 * Load the config JSON from S3. Fetches once and caches forever (Lambda lifetime).
 * Skips S3 entirely if BLOCKS_CONFIG_BUCKET/BLOCKS_CONFIG_KEY are not set (local dev).
 * Throws if the env vars ARE set but the S3 fetch fails.
 */
async function loadConfigFromS3(): Promise<Record<string, string>> {
	if (configCache) return configCache;

	const bucket = process.env.BLOCKS_CONFIG_BUCKET;
	const key = process.env.BLOCKS_CONFIG_KEY;

	if (!bucket || !key) {
		configCache = {};
		return configCache;
	}

	const fetcher = s3FetcherOverride ?? defaultS3Fetcher;

	try {
		const body = await fetcher(bucket, key);
		configCache = JSON.parse(body);
	} catch (error: any) {
		const isNotFound = error?.name === 'NoSuchKey'
			|| error?.Code === 'NoSuchKey'
			|| error?.$metadata?.httpStatusCode === 404;
		if (isNotFound) {
			// Do NOT cache the empty result: a 404 right after deploy is usually the config file
			// not being readable yet (the transient window before the BucketDeployment settles), not
			// a genuinely config-less app. Caching {} here would poison the container for its whole
			// lifetime. Returning without caching lets the next invocation re-fetch and pick up the
			// real config once it's present. (Apps that truly have no config just re-check cheaply.)
			console.warn(`[Blocks] Config file not found in S3 (${bucket}/${key}), proceeding with empty config (will retry on next request)`);
			return {};
		}
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(`[Blocks] Failed to load config from S3 (${bucket}/${key}): ${msg}`);
	}

	if (typeof configCache !== 'object' || configCache === null || Array.isArray(configCache)) {
		throw new Error('[Blocks] Config file must be a JSON object');
	}

	console.log(`[Blocks] Config loaded: ${Object.keys(configCache).length} keys`);
	return configCache!;
}

/**
 * Ensure only one S3 fetch is in flight at a time.
 * Multiple BB constructors calling getConfig() concurrently will share the same promise.
 */
function ensureConfigLoaded(): Promise<Record<string, string>> {
	if (configCache) return Promise.resolve(configCache);
	if (!configLoadPromise) {
		configLoadPromise = loadConfigFromS3().finally(() => {
			configLoadPromise = null;
		});
	}
	return configLoadPromise;
}

/**
 * Get a config value by key.
 *
 * Checks `process.env[key]` first (local dev where env vars are set directly).
 * If not found, reads from the cached S3 config file.
 *
 * @param key - The config key (e.g., `BLOCKS_AUTH_COGNITO_MYAPP_AUTHC_USER_POOL_ID`)
 * @returns The config value, or empty string if not found anywhere
 */
export async function getConfig(key: string): Promise<string> {
	const envValue = process.env[key];
	if (envValue !== undefined) return envValue;

	const config = await ensureConfigLoaded();
	return config[key] ?? '';
}

/**
 * Synchronous config access — returns the value if already cached, otherwise
 * returns the process.env fallback. Use this only when you're certain the
 * config has already been loaded (e.g., after an initial await getConfig() call).
 *
 * @param key - The config key
 * @returns The config value, or empty string if not found
 */
export function getConfigSync(key: string): string {
	const envValue = process.env[key];
	if (envValue !== undefined) return envValue;

	if (configCache) return configCache[key] ?? '';

	return '';
}

/**
 * Preload the S3 config. Call this early in Lambda cold start to ensure
 * the config is cached before any BB constructors need it.
 *
 * This is a no-op if the config is already loaded or if S3 env vars aren't set.
 */
export async function preloadConfig(): Promise<void> {
	await ensureConfigLoaded();
}

/**
 * Load S3 config and inject all values into `process.env`.
 *
 * This enables the lazy-init handler pattern: the handler loads config into
 * process.env BEFORE importing the backend module, so BB constructors can
 * read their config via `process.env[key]` as before — no BB code changes needed.
 *
 * Only sets env vars that aren't already set (won't override explicit env vars).
 */
export async function loadConfigToProcessEnv(): Promise<void> {
	const config = await ensureConfigLoaded();
	for (const [key, value] of Object.entries(config)) {
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}

/**
 * Whether a config load has resolved and cached a result.
 *
 * Returns `true` once `loadConfigFromS3()` has cached a config object — either a
 * successful S3 load, a genuinely-empty `{}` config, or the no-bucket local-dev
 * path (both of which cache `{}`). Returns `false` in the initial state AND
 * after a transient not-found miss: the 404 path deliberately does NOT cache its
 * empty result (see `loadConfigFromS3`), so a `false` return immediately after
 * awaiting a load uniquely identifies the post-deploy S3 window where
 * blocks-config.json isn't readable yet.
 *
 * Callers use this to tell a transient-empty load (retry on the next request)
 * apart from a legitimately-config-less app (do nothing) without reaching into
 * the module's private cache.
 */
export function isConfigResolved(): boolean {
	return configCache !== null;
}

/**
 * Reset the config cache. **For testing only.**
 */
export function _resetConfigCache(): void {
	configCache = null;
	configLoadPromise = null;
	s3FetcherOverride = null;
}

/**
 * Override the S3 fetcher function. **For testing only.**
 */
export function _setS3Fetcher(fetcher: ((bucket: string, key: string) => Promise<string>) | null): void {
	s3FetcherOverride = fetcher;
}
