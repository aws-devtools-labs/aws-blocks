// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { Logger } from '@aws-blocks/bb-logger';
import type { ScopeParent } from '@aws-blocks/core';
import { registerSdkIdentifiers, Scope } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { SecretErrors } from './errors.js';
import type { ExternalSecretRef, SecretOptions } from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

// Re-export public types and errors (canonical source)
export { SecretErrors } from './errors.js';
export type { ExternalSecretRef, SecretOptions } from './types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

// Secrets share the same local store as AppSetting — `.bb-data/settings.json`,
// a flat `{ key: value }` map at the project root — so the `/aws-blocks/settings`
// route surfaces settings AND secrets in one place, locally and when deployed.
// Locally everything in `.bb-data` is plaintext regardless (dev-only); deployed,
// secrets live KMS-encrypted in Secrets Manager.
function readSettings(scope: Scope): Record<string, unknown> {
	const fp = join(getMockDataDir(scope, { root: true }), 'settings.json');
	if (!existsSync(fp)) return {};
	try {
		return JSON.parse(readFileSync(fp, 'utf8'));
	} catch {
		return {};
	}
}

function writeSettings(scope: Scope, data: Record<string, unknown>): void {
	const fp = join(getMockDataDir(scope, { root: true }), 'settings.json');
	writeFileSync(fp, JSON.stringify(data, null, 2));
}

async function validateSchema<T>(schema: StandardSchemaV1<T>, value: unknown): Promise<T> {
	const result = schema['~standard'].validate(value);
	const resolved = result instanceof Promise ? await result : result;
	if (resolved.issues) {
		throw blocksError(SecretErrors.ValidationFailed, resolved.issues[0].message);
	}
	return (resolved as { value: T }).value;
}

/** Parse a legacy raw-string value, throwing ValidationFailed on malformed JSON. */
function safeJsonParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		throw blocksError(SecretErrors.ValidationFailed, 'Stored secret value is not valid JSON');
	}
}

// The local mock persists secret values as plaintext on disk (.bb-data). Warn
// once per process so developers never mistake it for a secure store — real
// credentials must never be used in local development.
let plaintextWarningLogged = false;

// ── Secret (mock) ─────────────────────────────────────────────────────────

/**
 * A single application secret backed by AWS Secrets Manager.
 *
 * Each instance represents exactly one secret value. Declare multiple `Secret`
 * instances for multiple secrets. Unlike `AppSetting` (SSM Parameter Store),
 * `Secret` is always backed by AWS Secrets Manager — use it for high-value
 * credentials that benefit from Secrets Manager's dedicated access controls and
 * (future) rotation support.
 *
 * **When to use:** Third-party API keys, OAuth client secrets, database
 * connection strings, webhook signing keys, encryption keys.
 *
 * **When NOT to use:** For non-sensitive configuration (feature flags, display
 * strings, thresholds), use `AppSetting`. For application state, use `KVStore`
 * or `DistributedTable`.
 *
 * **Best practices:**
 * - One `Secret` per logical credential.
 * - Never commit real secret values to source — set them at runtime via `put()`
 *   (or out-of-band in the AWS console / CLI), then read them with `get()`.
 * - Use a schema when the secret is structured JSON (e.g. a set of related keys)
 *   to get type safety and validation.
 *
 * **Cost:** AWS Secrets Manager charges per secret per month plus per API call.
 * See the AWS Secrets Manager pricing page for current rates.
 *
 * **Local dev:** The mock stores values as plaintext on disk under `.bb-data/`.
 * It is NOT secure — do not use real credentials locally.
 *
 * @typeParam T - The secret value type. Defaults to `string`; inferred from
 *   `schema` when one is provided.
 *
 * @example
 * ```typescript
 * // Opaque string secret
 * const stripeKey = new Secret(scope, 'stripe-api-key');
 * await stripeKey.put('sk_live_...');
 * const key = await stripeKey.get(); // string | null
 *
 * // Typed JSON secret with schema validation
 * const dbConfig = new Secret(scope, 'db-config', {
 *   schema: z.object({ host: z.string(), port: z.number() }),
 * });
 * await dbConfig.put({ host: 'db.internal', port: 5432 });
 * const config = await dbConfig.get(); // { host: string; port: number } | null
 * ```
 */
export class Secret<T = string> extends Scope {
	/** The key this secret is stored under in `.bb-data/settings.json` — the explicit `name`, else the instance `fullId`. */
	private storeKey: string;
	private schema?: StandardSchemaV1<T>;
	private external?: ExternalSecretRef;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: SecretOptions<T>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.schema = options?.schema;
		this.external = options?.secret;
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });

		// Key the local store by the explicit name when provided, else the fullId —
		// the same identity used for the Secrets Manager secret name in the CDK
		// layer, so the local key and the deployed name line up. `fromExisting`
		// references an external secret; locally it behaves like a normal (unseeded)
		// secret keyed by its fullId.
		this.storeKey = options?.name ?? this.fullId;
		registerSdkIdentifiers(this.fullId, {
			secretName: this.external
				? this.external.secretArn
				: (options?.name ?? `mock-${this.fullId}`).substring(0, 255),
		});

		if (!plaintextWarningLogged) {
			this.log.warn(
				'Secret: the local mock stores secret values as plaintext in .bb-data/settings.json. Do not use real credentials in local development.',
			);
			plaintextWarningLogged = true;
		}
	}

	/**
	 * Read the secret value.
	 *
	 * Without a schema, returns the raw stored string. With a schema, parses the
	 * stored JSON and validates it, returning the typed value `T`.
	 *
	 * Returns `null` when the secret has not been populated yet — reads never
	 * throw for a missing value, so callers can use `null` for normal control
	 * flow rather than try/catch.
	 *
	 * @returns The secret value, or `null` if it has not been set.
	 * @throws {SecretErrors.ValidationFailed} If a schema is configured and the stored value is not valid JSON, or fails validation.
	 *
	 * @example
	 * ```typescript
	 * const key = await stripeKey.get();
	 * if (key === null) throw new Error('Stripe key not configured');
	 * ```
	 */
	async get(): Promise<T | null> {
		const settings = readSettings(this);
		if (!(this.storeKey in settings)) return null;
		const stored = settings[this.storeKey];

		if (this.schema) {
			// With a schema the stored value is the already-parsed JSON value
			// (put() stores it structurally in settings.json). Validate it directly;
			// a legacy raw string is parsed first for forward-compat.
			const parsed = typeof stored === 'string' ? safeJsonParse(stored) : stored;
			return await validateSchema(this.schema, parsed);
		}

		return stored as unknown as T;
	}

	/**
	 * Update the secret value.
	 *
	 * Without a schema, accepts a string. With a schema, accepts `T`, validates
	 * it, and stores the structured value.
	 *
	 * @param value - The new secret value.
	 * @throws {SecretErrors.ValidationFailed} If a schema is configured and the value fails validation.
	 *
	 * @example
	 * ```typescript
	 * await stripeKey.put('sk_live_new_value');
	 * ```
	 */
	async put(value: T): Promise<void> {
		if (this.schema) {
			await validateSchema(this.schema, value);
		}
		const settings = readSettings(this);
		settings[this.storeKey] = value;
		writeSettings(this, settings);
	}

	/**
	 * Wrap an existing AWS Secrets Manager secret. `Secret` will not create,
	 * seed, or delete infrastructure for it — it only reads and writes the value.
	 *
	 * @param secretArn - The ARN of the existing Secrets Manager secret.
	 * @returns A reference to pass to the constructor's `secret` option.
	 *
	 * @example
	 * ```typescript
	 * const legacy = new Secret(scope, 'legacy-key', {
	 *   secret: Secret.fromExisting('arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-AbCdEf'),
	 * });
	 * ```
	 */
	static fromExisting(secretArn: string): ExternalSecretRef {
		return { __brand: 'ExternalSecretRef' as const, secretArn };
	}
}
