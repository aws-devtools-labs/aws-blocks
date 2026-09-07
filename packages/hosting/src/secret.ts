// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `secret()` and `config()` — deferred references to externalized values for
 * self-hosted deployments. **Two intent functions, store inferred from which one
 * you call:**
 *
 * - `secret('STRIPE_KEY')` → a sensitive value backed by **AWS Secrets Manager**.
 * - `config('FEATURE_FLAGS')` → a non-sensitive value backed by **SSM Parameter
 *   Store** (free tier).
 *
 * Neither returns the value. Each returns a lightweight **marker** — a coat-check
 * ticket — safe to write in source and commit to git. The value itself lives at
 * rest in its store and is set out-of-band via the `secret set` / `config set`
 * CLI; it never appears in source, the CloudFormation template, or the browser.
 * At runtime the app reads it with `getSecret('KEY')` / `getConfig('KEY')`.
 *
 * The developer never picks a *store* — it is implied by the function called.
 * This is the "two intent functions" model (I1, Approach B).
 *
 * This module is **framework-neutral and dependency-free** (no CDK, no AWS SDK,
 * no `@aws-blocks/*`), so any consumer — the `Hosting` construct, a plain
 * framework app, or `@aws-blocks/pipeline` — imports the same markers.
 *
 * @module
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * Which backing store physically holds a value. An implementation detail — the
 * developer chooses the *function* (`secret()` vs `config()`), and the store is
 * derived via {@link storeForKind}.
 */
export type SecretStore = 'ssm' | 'secrets-manager';

/** The kind of managed value — mirrors the function used to declare it. */
export type ValueKind = 'secret' | 'config';

/** Unique brand. `Symbol.for` so it survives across module/realm copies. */
export const MANAGED_BRAND: unique symbol = Symbol.for('@aws-blocks/hosting.ManagedValue');

/** Marker returned by {@link secret} — a sensitive value in AWS Secrets Manager. */
export interface SecretValue {
	readonly [MANAGED_BRAND]: true;
	/** The logical name; the key you set with `secret set <key>` and read with `getSecret('<key>')`. */
	readonly key: string;
	/** Always `'secret'` (→ Secrets Manager). */
	readonly kind: 'secret';
	/**
	 * Optional value schema (Zod/Valibot/ArkType — any Standard Schema). When set,
	 * `getSecret('<key>')` **returns the schema's output type** (typegen inlines it)
	 * and the runtime **JSON-parses** the stored value. Carried for synth wiring
	 * (the parse flag) and typegen type inference; never serialized to the template.
	 */
	readonly schema?: StandardSchemaV1<unknown>;
}

/** Marker returned by {@link config} — a non-sensitive value in SSM Parameter Store. */
export interface ConfigValue {
	readonly [MANAGED_BRAND]: true;
	/** The logical name; the key you set with `config set <key>` and read with `getConfig('<key>')`. */
	readonly key: string;
	/** Always `'config'` (→ SSM Parameter Store). */
	readonly kind: 'config';
	/**
	 * Optional value schema (Zod/Valibot/ArkType — any Standard Schema). When set,
	 * `getConfig('<key>')` **returns the schema's output type** (typegen inlines it)
	 * and the runtime **JSON-parses** the stored value. Carried for synth wiring
	 * (the parse flag) and typegen type inference; never serialized to the template.
	 */
	readonly schema?: StandardSchemaV1<unknown>;
}

/** Options for {@link secret} / {@link config}. */
export interface ManagedValueOptions {
	/**
	 * A Standard Schema (Zod, Valibot, ArkType, …) describing the value. Typing it
	 * as {@link StandardSchemaV1} keeps this API library-neutral. When provided, the
	 * runtime getter JSON-parses the stored value and (via typegen) returns the
	 * schema's inferred output type instead of `string`.
	 */
	readonly schema?: StandardSchemaV1<unknown>;
}

/** Either managed marker. */
export type ManagedValue = SecretValue | ConfigValue;

/**
 * Derive the backing store from a value's kind — the single source of truth for
 * the kind → store mapping, used by the CLI write, the CDK IAM grant + env
 * injection, the synth-time fetch, and the runtime resolver, so no actor
 * re-derives it independently and they can never drift.
 */
export function storeForKind(kind: ValueKind): SecretStore {
	return kind === 'secret' ? 'secrets-manager' : 'ssm';
}

/**
 * Key validation. Keys map to store name segments and env var names, so they are
 * constrained to a safe, portable charset: start with a letter or underscore,
 * then letters/digits/underscores.
 */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertKey(fn: 'secret' | 'config', key: string): void {
	if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
		throw new Error(
			`${fn}(): invalid key ${JSON.stringify(key)}. Keys must match ${KEY_PATTERN} ` +
				`(start with a letter or underscore, then letters, digits, or underscores).`,
		);
	}
}

/**
 * Reference a **sensitive** value stored in AWS Secrets Manager.
 *
 * @param key - Logical name (e.g. `'STRIPE_KEY'`). Set the value out-of-band with
 *   `secret set <key>` and read it at runtime with `getSecret('<key>')`.
 * @returns A {@link SecretValue} marker — pass it into `Hosting` `environment` /
 *   `domain`, or a pipeline's `buildSecrets` / `connectionArn`.
 *
 * @example
 * ```ts
 * environment: { STRIPE_KEY: secret('STRIPE_KEY') }   // → Secrets Manager
 * const key = await getSecret('STRIPE_KEY');
 * ```
 */
export function secret(key: string, options: ManagedValueOptions = {}): SecretValue {
	assertKey('secret', key);
	return { [MANAGED_BRAND]: true, key, kind: 'secret', ...(options.schema ? { schema: options.schema } : {}) };
}

/**
 * Reference a **non-sensitive** value stored in SSM Parameter Store (free tier) —
 * e.g. a feature flag, a custom domain, a connection ARN.
 *
 * @param key - Logical name (e.g. `'FEATURE_FLAGS'`). Set the value out-of-band
 *   with `config set <key>` and read it at runtime with `getConfig('<key>')`.
 * @returns A {@link ConfigValue} marker.
 *
 * @example
 * ```ts
 * environment: { FEATURE_FLAGS: config('FEATURE_FLAGS') }   // → SSM Parameter Store
 * const flags = await getConfig('FEATURE_FLAGS');
 * ```
 */
export function config(key: string, options: ManagedValueOptions = {}): ConfigValue {
	assertKey('config', key);
	return { [MANAGED_BRAND]: true, key, kind: 'config', ...(options.schema ? { schema: options.schema } : {}) };
}

/** Type guard: a marker produced by {@link secret}. */
export function isSecret(v: unknown): v is SecretValue {
	return isManagedValue(v) && v.kind === 'secret';
}

/** Type guard: a marker produced by {@link config}. */
export function isConfig(v: unknown): v is ConfigValue {
	return isManagedValue(v) && v.kind === 'config';
}

/** Type guard: any managed marker ({@link secret} or {@link config}). */
export function isManagedValue(v: unknown): v is ManagedValue {
	return typeof v === 'object' && v !== null && (v as Record<PropertyKey, unknown>)[MANAGED_BRAND] === true;
}

// ── JSON transport codec ─────────────────────────────────────────────────────
//
// A marker is branded with a `Symbol` and may carry a non-serializable `schema`,
// so it does NOT survive `JSON.stringify`/`JSON.parse`: the symbol brand is
// dropped and `isManagedValue()` then returns false on the far side. Any consumer
// that carries a config object containing markers across a JSON boundary — e.g. an
// orchestrator that serializes per-stage config into a build environment variable
// and reads it back in a later phase — needs a lossless round-trip. This codec
// provides one: markers encode to a tagged plain object and decode back into real
// branded markers.
//
// The wire form is *versioned* (a `v` field) and self-describing (a namespaced
// tag), so producers and consumers on different package versions fail predictably
// rather than silently misreading each other: `decodeManagedValue` throws a typed
// `ManagedValueCodecError` on an unknown version/kind or a malformed value, and the
// reviver leaves anything that is not an exact wire value untouched (never throws).
//
// A marker's optional `schema` object is not serializable, so it is not transported.
// What IS transported is the schema's *operational* consequence — a `json` bit — so
// a schema-bearing marker round-trips without silently changing runtime behavior:
// the far side still emits the synth-time JSON-parse flag and parses the stored
// value. Deep re-validation still needs the schema re-declared on the far side (the
// runtime getter is parse-only regardless — see `secret-runtime`).

/** Stable tag identifying the JSON-transport form of a {@link ManagedValue}. */
export const MANAGED_VALUE_JSON_TAG = '$aws-blocks/hosting.ManagedValue' as const;

/**
 * Current version of the {@link ManagedValueJSON} wire protocol. It is embedded in
 * every encoded value; a decoder rejects versions it does not understand rather
 * than guessing, so this public cross-build format can evolve safely. Bump this
 * (and widen the decoder) only for a backward-incompatible wire change.
 */
export const MANAGED_VALUE_JSON_VERSION = 1 as const;

/** Plain, JSON-safe representation of a {@link ManagedValue} marker. */
export interface ManagedValueJSON {
	readonly [MANAGED_VALUE_JSON_TAG]: {
		/** Wire protocol version. See {@link MANAGED_VALUE_JSON_VERSION}. */
		readonly v: typeof MANAGED_VALUE_JSON_VERSION;
		readonly kind: ValueKind;
		readonly key: string;
		/**
		 * Present and `true` iff the source marker declared a `schema`. The schema
		 * object itself is not serializable and is not transported; this bit carries
		 * its *operational* consequence — the runtime JSON-parse behavior — so a
		 * schema-bearing marker round-trips without silently degrading (see the codec
		 * note above and {@link decodeManagedValue}).
		 */
		readonly json?: true;
	};
}

/**
 * Thrown by {@link decodeManagedValue} when a value is not a valid, supported
 * {@link ManagedValueJSON} wire form — missing/foreign tag, unsupported protocol
 * version, unknown kind, invalid key, or a stray malformed shape. A typed error (vs.
 * a raw `TypeError`) lets callers distinguish "incompatible/garbled wire data" from
 * other failures.
 */
export class ManagedValueCodecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ManagedValueCodecError';
	}
}

/** Validated wire payload — the inner object under {@link MANAGED_VALUE_JSON_TAG}. */
interface WirePayload {
	readonly kind: ValueKind;
	readonly key: string;
	readonly json?: true;
}

/**
 * Single, exhaustive validator shared by {@link isManagedValueJSON} (boolean) and
 * {@link decodeManagedValue} (throws). Because the guard delegates here, the reviver
 * only ever hands `decodeManagedValue` values that already validated, so the reviver
 * never throws on malformed data — it leaves it untouched.
 */
function readWirePayload(v: unknown): { ok: true; payload: WirePayload } | { ok: false; reason: string } {
	if (typeof v !== 'object' || v === null) return { ok: false, reason: 'value is not an object' };
	// Require the EXACT wire shape: the tag is the object's only own key. A plain
	// object that merely happens to also carry the tag (a collision) plus sibling
	// fields is NOT a wire value — reviving it would silently drop those siblings —
	// so reject it and leave it untouched.
	const ownKeys = Object.keys(v as object);
	if (ownKeys.length !== 1 || ownKeys[0] !== MANAGED_VALUE_JSON_TAG) {
		return { ok: false, reason: `object is not exactly a single ${MANAGED_VALUE_JSON_TAG} wire value` };
	}
	const inner = (v as Record<string, unknown>)[MANAGED_VALUE_JSON_TAG];
	if (typeof inner !== 'object' || inner === null) return { ok: false, reason: 'tag payload is not an object' };
	const p = inner as Record<string, unknown>;
	if (p.v !== MANAGED_VALUE_JSON_VERSION) {
		return {
			ok: false,
			reason: `unsupported wire version ${JSON.stringify(p.v)} (this build understands v${MANAGED_VALUE_JSON_VERSION})`,
		};
	}
	if (p.kind !== 'secret' && p.kind !== 'config') {
		return { ok: false, reason: `unknown kind ${JSON.stringify(p.kind)} (expected 'secret' or 'config')` };
	}
	if (typeof p.key !== 'string' || !KEY_PATTERN.test(p.key)) {
		return { ok: false, reason: `invalid key ${JSON.stringify(p.key)}` };
	}
	if (p.json !== undefined && p.json !== true) {
		return { ok: false, reason: `invalid json flag ${JSON.stringify(p.json)} (expected true or absent)` };
	}
	return { ok: true, payload: { kind: p.kind, key: p.key, ...(p.json === true ? { json: true } : {}) } };
}

/** Type guard: a value produced by {@link encodeManagedValue} (the JSON form). */
export function isManagedValueJSON(v: unknown): v is ManagedValueJSON {
	return readWirePayload(v).ok;
}

/** Encode a marker into a JSON-safe tagged object that survives `JSON.stringify`. */
export function encodeManagedValue(v: ManagedValue): ManagedValueJSON {
	return {
		[MANAGED_VALUE_JSON_TAG]: {
			v: MANAGED_VALUE_JSON_VERSION,
			kind: v.kind,
			key: v.key,
			// Transport the schema's operational bit (not the un-serializable schema).
			...(v.schema ? { json: true } : {}),
		},
	};
}

/**
 * Decode a wire value (see {@link encodeManagedValue}) back into a branded marker.
 *
 * Accepts `unknown` and validates exhaustively: throws {@link ManagedValueCodecError}
 * on an unsupported version, unknown kind, invalid key, or any other malformed shape.
 * When the wire value's `json` bit is set, the returned marker carries a passthrough
 * schema so the far side re-emits the runtime JSON-parse flag — preserving the
 * origin's runtime behavior (deep re-validation still needs the real schema
 * re-declared; the runtime getter is parse-only either way).
 */
export function decodeManagedValue(v: unknown): ManagedValue {
	const result = readWirePayload(v);
	if (!result.ok) {
		throw new ManagedValueCodecError(
			`decodeManagedValue: not a valid ${MANAGED_VALUE_JSON_TAG} wire value — ${result.reason}.`,
		);
	}
	const { kind, key, json } = result.payload;
	const options: ManagedValueOptions = json ? { schema: JSON_PASSTHROUGH_SCHEMA } : {};
	return kind === 'secret' ? secret(key, options) : config(key, options);
}

/**
 * Sentinel Standard Schema attached to a marker revived from a wire value whose
 * `json` bit was set. The origin's real schema is not serializable and does not
 * cross the boundary, and the runtime getter never deep-validates (it is parse-only
 * — see `secret-runtime`'s `finalizeValue`). This passthrough therefore reproduces
 * exactly the operational effect of "a schema was declared": synth emits the
 * per-key JSON-parse flag, so the stored value is `JSON.parse`d on read as at the
 * origin. It is a valid, callable Standard Schema (returns its input unchanged).
 */
const JSON_PASSTHROUGH_SCHEMA: StandardSchemaV1<unknown> = {
	'~standard': {
		version: 1,
		vendor: '@aws-blocks/hosting',
		validate: (value: unknown) => ({ value }),
	},
};

/**
 * A `JSON.stringify` replacer that encodes any {@link ManagedValue} markers it
 * encounters into their JSON-safe form.
 *
 * @example
 * ```ts
 * const wire = JSON.stringify({ domain: config('DOMAIN') }, managedValueReplacer);
 * ```
 */
export function managedValueReplacer(_key: string, value: unknown): unknown {
	return isManagedValue(value) ? encodeManagedValue(value) : value;
}

/**
 * A `JSON.parse` reviver that rehydrates encoded markers back into real branded
 * markers, so `isManagedValue()` / `isSecret()` / `isConfig()` recognize them again.
 *
 * @example
 * ```ts
 * const restored = JSON.parse(wire, managedValueReviver);
 * isConfig(restored.domain); // true
 * ```
 */
export function managedValueReviver(_key: string, value: unknown): unknown {
	return isManagedValueJSON(value) ? decodeManagedValue(value) : value;
}

// ── store path convention (single source of truth) ──────────────────────────

/** Framework-neutral default prefix for **secrets** (Secrets Manager). */
export const DEFAULT_SECRET_PARAMETER_PREFIX = '/hosting/secrets';

/** Framework-neutral default prefix for **config** (SSM Parameter Store). */
export const DEFAULT_CONFIG_PARAMETER_PREFIX = '/hosting/config';

/** The default prefix for a kind. */
export function defaultPrefixForKind(kind: ValueKind): string {
	return kind === 'secret' ? DEFAULT_SECRET_PARAMETER_PREFIX : DEFAULT_CONFIG_PARAMETER_PREFIX;
}

/**
 * Join a prefix and key into a store path. The ONLY place the path is built — the
 * CLI, the CDK wiring, and the runtime resolver all route through here so the
 * name can never drift between write and read.
 */
export function parameterName(key: string, prefix: string): string {
	return `${prefix}/${key}`;
}

/**
 * The store-appropriate locator for a value — used identically by the CLI, the
 * IAM grant, the synth-time fetch, and the runtime read.
 *
 * - **SSM** (config) keeps the leading-slash path form (`/hosting/config/KEY`).
 * - **Secrets Manager** (secret) names are slash-free at the root; the leading
 *   slash is stripped (`hosting/secrets/KEY`) so the created name and the IAM ARN
 *   resource agree.
 *
 * A `stage` becomes a segment between prefix and key (`<prefix>/<stage>/<key>`).
 */
export function secretStoreLocator(key: string, opts: { prefix: string; store: SecretStore; stage?: string }): string {
	const prefix = opts.stage ? `${opts.prefix}/${opts.stage}` : opts.prefix;
	const path = parameterName(key, prefix);
	return opts.store === 'secrets-manager' ? path.replace(/^\//, '') : path;
}

// ── runtime env var naming (separate per kind) ──────────────────────────────

/** Env var carrying a **secret**'s Secrets Manager locator to the compute runtime. */
export function secretEnvVarName(key: string): string {
	return `HOSTING_SECRET_PARAM_${key}`;
}

/** Env var carrying a **config**'s SSM locator to the compute runtime. */
export function configEnvVarName(key: string): string {
	return `HOSTING_CONFIG_PARAM_${key}`;
}

/** Env var name for a value's kind. */
export function envVarNameForKind(kind: ValueKind, key: string): string {
	return kind === 'secret' ? secretEnvVarName(key) : configEnvVarName(key);
}

/** Fallback (shared stage) locator env var name for a given primary env var name. */
export function fallbackEnvVarName(envVarName: string): string {
	return `${envVarName}_FALLBACK`;
}

/** Per-kind runtime cache-TTL env var (seconds). */
export function cacheTtlEnvVarName(kind: ValueKind): string {
	return kind === 'secret' ? 'HOSTING_SECRET_CACHE_TTL' : 'HOSTING_CONFIG_CACHE_TTL';
}

/**
 * Env var flag set at synth when a marker declares a `schema`. Its presence tells
 * the runtime getter to `JSON.parse` the stored string, so the returned value
 * matches the schema's inferred type that typegen puts on `getSecret`/`getConfig`.
 */
export function jsonFlagEnvVarName(kind: ValueKind, key: string): string {
	return kind === 'secret' ? `HOSTING_SECRET_JSON_${key}` : `HOSTING_CONFIG_JSON_${key}`;
}
