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
// Note: only `kind` + `key` are transported (the locator identity). A marker's
// optional `schema` is not serializable and is intentionally dropped; re-declare
// the schema on the far side if the runtime JSON-parse behavior is needed there.

/** Stable tag identifying the JSON-transport form of a {@link ManagedValue}. */
export const MANAGED_VALUE_JSON_TAG = '$aws-blocks/hosting.ManagedValue' as const;

/** Plain, JSON-safe representation of a {@link ManagedValue} marker. */
export interface ManagedValueJSON {
	readonly [MANAGED_VALUE_JSON_TAG]: { readonly kind: ValueKind; readonly key: string };
}

/** Type guard: a value produced by {@link encodeManagedValue} (the JSON form). */
export function isManagedValueJSON(v: unknown): v is ManagedValueJSON {
	if (typeof v !== 'object' || v === null) return false;
	const inner = (v as Record<string, unknown>)[MANAGED_VALUE_JSON_TAG];
	return (
		typeof inner === 'object' &&
		inner !== null &&
		((inner as ManagedValue).kind === 'secret' || (inner as ManagedValue).kind === 'config') &&
		typeof (inner as ManagedValue).key === 'string'
	);
}

/** Encode a marker into a JSON-safe tagged object that survives `JSON.stringify`. */
export function encodeManagedValue(v: ManagedValue): ManagedValueJSON {
	return { [MANAGED_VALUE_JSON_TAG]: { kind: v.kind, key: v.key } };
}

/** Decode a tagged object (see {@link encodeManagedValue}) back into a branded marker. */
export function decodeManagedValue(v: ManagedValueJSON): ManagedValue {
	const { kind, key } = v[MANAGED_VALUE_JSON_TAG];
	return kind === 'secret' ? secret(key) : config(key);
}

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
