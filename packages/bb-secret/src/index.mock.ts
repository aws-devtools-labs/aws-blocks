// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { Logger } from '@aws-blocks/bb-logger';
import type { ScopeParent } from '@aws-blocks/core';
import { registerSdkIdentifiers, Scope } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { SecretErrors } from './errors.js';
import type { ExternalSecretRef, SecretOptions, SecretReadOptions, SecretVersion, SecretVersionInfo } from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

// Re-export public types and errors (canonical source)
export { SecretErrors } from './errors.js';
export type { ExternalSecretRef, SecretOptions, SecretReadOptions, SecretVersion, SecretVersionInfo } from './types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

// Secrets share the same local store as AppSetting — `.bb-data/settings.json`,
// a flat `{ key: value }` map at the project root — so the `/aws-blocks/settings`
// route surfaces settings AND secrets in one place, locally and when deployed.
// The CURRENT value lives here as a plain `{ key: value }` entry (human-editable
// via the route). Version HISTORY (current + previous, for get({ version }) /
// listVersions()) lives in a sidecar so the settings file stays a flat map.
// Locally everything in `.bb-data` is plaintext regardless (dev-only); deployed,
// secrets live KMS-encrypted in Secrets Manager with real version history.
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

/** Internal mock version record — a public SecretVersionInfo plus the stored value. */
interface MockVersion extends SecretVersionInfo {
	value: unknown;
}

/** Read the per-key version history sidecar (newest-first). */
function readVersions(scope: Scope): Record<string, MockVersion[]> {
	const fp = join(getMockDataDir(scope, { root: true }), 'secret-versions.json');
	if (!existsSync(fp)) return {};
	try {
		const raw = JSON.parse(readFileSync(fp, 'utf8')) as Record<
			string,
			Array<Omit<MockVersion, 'createdDate'> & { createdDate: string }>
		>;
		// Revive createdDate strings into Date objects (createdDate is readonly, so
		// rebuild each entry rather than mutating in place).
		const out: Record<string, MockVersion[]> = {};
		for (const [key, list] of Object.entries(raw)) {
			out[key] = list.map((v) => ({ ...v, createdDate: new Date(v.createdDate) }));
		}
		return out;
	} catch {
		return {};
	}
}

function writeVersions(scope: Scope, data: Record<string, MockVersion[]>): void {
	const fp = join(getMockDataDir(scope, { root: true }), 'secret-versions.json');
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
 * version history.
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
 * **Rotation:** rotate by setting a new value (`put()`, the console, or the AWS
 * CLI); the prior value stays readable via `get({ version: 'previous' })` for a
 * grace window. Automatic rotation is credential-type-specific and out of scope
 * — for custom schedules, drive `put()` from a `CronJob`.
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
	 * By default reads the current value. Pass `{ version }` to read a different
	 * version — `'previous'` for the value before the last change (a rotation
	 * grace window), or a {@link SecretVersion} obtained from {@link listVersions}.
	 *
	 * Without a schema, returns the raw stored string. With a schema, parses the
	 * stored JSON and validates it, returning the typed value `T`.
	 *
	 * Returns `null` when the requested version has no value — reads never throw
	 * for a missing value, so callers can use `null` for normal control flow
	 * rather than try/catch. In particular `{ version: 'previous' }` returns
	 * `null` until the secret has been changed at least once.
	 *
	 * @param options - Optional read options; `version` selects which version.
	 * @returns The secret value, or `null` if that version has not been set.
	 * @throws {SecretErrors.ValidationFailed} If a schema is configured and the stored value is not valid JSON, or fails validation.
	 *
	 * @example
	 * ```typescript
	 * const key = await stripeKey.get();
	 * if (key === null) throw new Error('Stripe key not configured');
	 *
	 * // Rotation grace window — accept tokens signed by the previous key too.
	 * const prev = await signingKey.get({ version: 'previous' }); // string | null
	 * ```
	 */
	async get(options?: SecretReadOptions): Promise<T | null> {
		const raw = this.resolveStoredValue(options?.version);
		if (raw === undefined) return null;

		if (this.schema) {
			// The stored value is the already-parsed JSON value (put() stores it
			// structurally). Validate it directly; a legacy raw string is parsed
			// first for forward-compat.
			const parsed = typeof raw === 'string' ? safeJsonParse(raw) : raw;
			return await validateSchema(this.schema, parsed);
		}

		return raw as unknown as T;
	}

	/**
	 * Resolve the stored value for a version selector, or `undefined` when absent.
	 * `'current'`/undefined reads the live settings.json entry; `'previous'` and a
	 * {@link SecretVersion} read the version-history sidecar.
	 */
	private resolveStoredValue(version?: 'current' | 'previous' | SecretVersion): unknown {
		if (version === undefined || version === 'current') {
			const settings = readSettings(this);
			return this.storeKey in settings ? settings[this.storeKey] : undefined;
		}
		const history = readVersions(this)[this.storeKey] ?? [];
		if (version === 'previous') {
			// history is newest-first: [0] = current, [1] = previous.
			return history.length > 1 ? history[1].value : undefined;
		}
		// A specific SecretVersion handle — match by versionId.
		const match = history.find((v) => v.versionId === version.versionId);
		return match ? match.value : undefined;
	}

	/**
	 * Update the secret value.
	 *
	 * Without a schema, accepts a string. With a schema, accepts `T`, validates
	 * it, and stores the structured value. The prior value becomes the
	 * `'previous'` version (readable via `get({ version: 'previous' })`).
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

		// Live value in the shared settings file (human-editable via the route).
		const settings = readSettings(this);
		settings[this.storeKey] = value;
		writeSettings(this, settings);

		// Version history sidecar: prepend the new current, demote the old current
		// to previous, keep at most 2 (current + previous) — mirroring the AWSCURRENT
		// / AWSPREVIOUS labels AWS maintains.
		const all = readVersions(this);
		const prior = all[this.storeKey] ?? [];
		const next: MockVersion[] = [
			{ versionId: randomUUID(), stages: ['AWSCURRENT'], createdDate: new Date(), value },
			...prior.slice(0, 1).map((v) => ({ ...v, stages: ['AWSPREVIOUS'] })),
		];
		all[this.storeKey] = next;
		writeVersions(this, all);
	}

	/**
	 * List the stored versions of this secret, newest first — metadata only, never
	 * the values. Pass a returned {@link SecretVersionInfo} to `get({ version })`
	 * to read that version's value.
	 *
	 * Locally the mock keeps the current and previous versions (deeper history is
	 * an AWS-only capability); against AWS this returns the full retained history.
	 *
	 * @returns The versions, newest first (`stages` includes `'AWSCURRENT'` / `'AWSPREVIOUS'`).
	 */
	async listVersions(): Promise<SecretVersionInfo[]> {
		const history = readVersions(this)[this.storeKey] ?? [];
		return history.map(({ versionId, stages, createdDate }) => ({ versionId, stages, createdDate }));
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
