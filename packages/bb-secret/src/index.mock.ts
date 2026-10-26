// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { Logger } from '@aws-blocks/bb-logger';
import type { ScopeParent } from '@aws-blocks/core';
import { blocksError, registerSdkIdentifiers, Scope } from '@aws-blocks/core';
import { getMockDataDir, assertNotMockInDeployedEnv } from '@aws-blocks/core/bb-utils';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { SecretErrors } from './errors.js';
import type { ExternalSecretRef, SecretOptions, SecretReadOptions, SecretVersion, SecretVersionInfo } from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

// Fail closed if this mock entry loads in a deployed env — see assertNotMockInDeployedEnv.
assertNotMockInDeployedEnv('bb-secret');

// Re-export public types and errors (canonical source)
export { SecretErrors } from './errors.js';
export type {
	ExternalSecretRef,
	SecretOptions,
	SecretReadOptions,
	SecretVersion,
	SecretVersionInfo,
} from './types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

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

/**
 * Produce a random 32-character value for a `generate: true` secret, mirroring
 * (locally) the random string Secrets Manager's generator seeds on first deploy.
 * Only the length/shape matters for parity — the mock is dev-only plaintext.
 */
function generateMockValue(): string {
	return randomBytes(24).toString('base64url').slice(0, 32);
}

// The local mock persists secret values as plaintext on disk (.bb-data). Warn
// once per process so developers never mistake it for a secure store — real
// credentials must never be used in local development.
let plaintextWarningLogged = false;

// ── Secret (mock) ─────────────────────────────────────────────────────────

/** @internal Implementation backing the public {@link Secret} constructor. */
class SecretImpl<T = string> extends Scope {
	/** The key this secret is stored under in `.bb-data/settings.json` — the explicit `name`, else the instance `fullId`. */
	private storeKey: string;
	private schema?: StandardSchemaV1<T>;
	private external?: ExternalSecretRef;

	/**
	 * Update the secret value — **present only when the secret was constructed
	 * with `allowRuntimeWrite: true`**. Otherwise this property is absent from the
	 * instance (and the public read-only {@link Secret} type omits it).
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
	declare put?: (value: T) => Promise<void>;

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

		// Runtime writes are opt-in and least-privilege: only expose `put()` on the
		// instance when `allowRuntimeWrite: true`. When absent/false the method is
		// genuinely not on the object (not just a thrower), matching the read-only
		// public type and the read-only IAM the CDK layer grants.
		if (options?.allowRuntimeWrite === true) {
			this.put = (value: T) => this.#put(value);
		}

		if (!plaintextWarningLogged) {
			this.log.warn(
				'Secret: the local mock stores secret values as plaintext in .bb-data/settings.json. Do not use real credentials in local development.',
			);
			plaintextWarningLogged = true;
		}

		// `generate: true` — seed a random value on first creation so the secret
		// EXISTS immediately (parity with the AWS generator). Only when not
		// wrapping an external secret and only if unset, so a re-instantiation
		// (dev restart, another test) does not clobber an existing/`put()` value —
		// mirroring deploy-once creation. A generated value is a random string, so
		// it is never seeded for a schema'd secret (it would not be valid JSON).
		if (options?.generate === true && !this.external && !this.schema) {
			const settings = readSettings(this);
			if (!(this.storeKey in settings)) {
				const seeded = generateMockValue();
				settings[this.storeKey] = seeded;
				writeSettings(this, settings);
				const all = readVersions(this);
				all[this.storeKey] = [
					{ versionId: randomUUID(), stages: ['AWSCURRENT'], createdDate: new Date(), value: seeded },
				];
				writeVersions(this, all);
			}
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
	 * Internal write implementation, exposed as the public `put` only when
	 * `allowRuntimeWrite: true` (see the constructor).
	 */
	async #put(value: T): Promise<void> {
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
	 * Returns the **labeled** versions — current and previous. Both the mock and
	 * the AWS layer surface only these two; deeper history (unlabeled versions
	 * Secrets Manager still retains) is reachable via the AWS SDK against the
	 * secret, but is intentionally not exposed here.
	 *
	 * @returns The versions, newest first (`stages` includes `'AWSCURRENT'` / `'AWSPREVIOUS'`).
	 */
	async listVersions(): Promise<SecretVersionInfo[]> {
		const history = readVersions(this)[this.storeKey] ?? [];
		return history.map(({ versionId, stages, createdDate }) => ({ versionId, stages, createdDate }));
	}
}

/**
 * The public, read-only `Secret` surface: `get()` + `listVersions()`, no `put()`.
 * This is what you get from `new Secret(scope, id)` (or any construction without
 * `allowRuntimeWrite: true`). The runtime object has no `put` method either.
 */
export type Secret<T = string> = Omit<SecretImpl<T>, 'put'>;

/**
 * A `Secret` constructed with `allowRuntimeWrite: true`: the read-only surface
 * plus a non-optional {@link SecretImpl.put}.
 */
export type WritableSecret<T = string> = Secret<T> & { put(value: T): Promise<void> };

/**
 * The `Secret` constructor. Overloaded so the returned type reflects
 * `allowRuntimeWrite`: `true` yields a {@link WritableSecret} (has `put`),
 * anything else yields the read-only {@link Secret}.
 */
export interface SecretConstructor {
	new <T = string>(
		scope: ScopeParent,
		id: string,
		options: SecretOptions<T> & { allowRuntimeWrite: true },
	): WritableSecret<T>;
	new <T = string>(scope: ScopeParent, id: string, options?: SecretOptions<T>): Secret<T>;
	/**
	 * Wrap an existing AWS Secrets Manager secret. `Secret` will not create,
	 * seed, or delete infrastructure for it — it only reads (and, with
	 * `allowRuntimeWrite: true`, writes) the value.
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
	fromExisting(secretArn: string): ExternalSecretRef;
}

function fromExisting(secretArn: string): ExternalSecretRef {
	return { __brand: 'ExternalSecretRef' as const, secretArn };
}

// Bind the overloaded constructor interface to the implementation. The single
// cast is framework plumbing: a class cannot narrow its own constructor return
// type per-overload, so the public `Secret` is the impl viewed through
// `SecretConstructor`.
Object.assign(SecretImpl, { fromExisting });
/**
 * A single application secret backed by AWS Secrets Manager.
 *
 * Each instance represents exactly one secret value. Declare multiple `Secret`
 * instances for multiple secrets. `Secret` is the recommended home for
 * production secrets — a dedicated per-secret resource with its own access
 * controls and version history. For non-sensitive configuration use
 * `AppSetting`; `AppSetting` with `secret: true` is only a free, encrypted
 * fallback for a low-value secret.
 *
 * **When to use:** Third-party API keys, OAuth client secrets, database
 * connection strings, webhook signing keys, encryption keys.
 *
 * **When NOT to use:** For non-sensitive configuration (feature flags, display
 * strings, thresholds), use `AppSetting`. For application state, use `KVStore`
 * or `DistributedTable`.
 *
 * **Read-only by default:** a `Secret` has no `put()` method and the deployed
 * execution role gets read-only IAM. Pass `allowRuntimeWrite: true` to add
 * `put()` and grant write access — only when the app itself sets/rotates the
 * value at runtime. Most apps read a value set out-of-band (console / CLI / CI).
 *
 * **Best practices:**
 * - One `Secret` per logical credential.
 * - Never commit real secret values to source — set them out-of-band (console /
 *   CLI), or via `put()` when `allowRuntimeWrite: true`, then read with `get()`.
 * - Use a schema when the secret is structured JSON (e.g. a set of related keys)
 *   to get type safety and validation.
 *
 * **Rotation:** rotate by setting a new value (console / CLI, or `put()` when
 * `allowRuntimeWrite: true`); the prior value stays readable via
 * `get({ version: 'previous' })` for a grace window. Automatic rotation is
 * credential-type-specific and out of scope.
 *
 * **Local dev:** The mock stores values as plaintext on disk under `.bb-data/`.
 * It is NOT secure — do not use real credentials locally.
 *
 * @example
 * ```typescript
 * // Read-only secret (default): value set out-of-band, read with get().
 * const stripeKey = new Secret(scope, 'stripe-api-key');
 * const key = await stripeKey.get(); // string | null  (no put())
 *
 * // Writable secret: the app sets/rotates the value itself.
 * const token = new Secret(scope, 'self-rotating-token', { allowRuntimeWrite: true });
 * await token.put('t-123');
 *
 * // Typed JSON secret with schema validation.
 * const dbConfig = new Secret(scope, 'db-config', {
 *   schema: z.object({ host: z.string(), port: z.number() }),
 *   allowRuntimeWrite: true,
 * });
 * await dbConfig.put({ host: 'db.internal', port: 5432 });
 * const config = await dbConfig.get(); // { host: string; port: number } | null
 * ```
 */
export const Secret = SecretImpl as unknown as SecretConstructor;
