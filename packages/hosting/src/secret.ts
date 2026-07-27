// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `secret()` — a deferred reference to a sensitive value stored in AWS Systems
 * Manager Parameter Store (SecureString), for self-hosted deployments.
 *
 * A `secret('STRIPE_KEY')` call does NOT return the secret value. It returns a
 * lightweight **marker** — think of it as a coat-check ticket. The ticket is
 * safe to write in source code and commit to git; only AWS (the cloakroom),
 * given the right IAM permissions (your ID), can exchange it for the real
 * value. The value itself lives encrypted at rest in Parameter Store and is
 * set out-of-band via the `secret set <KEY> <value>` CLI — it never appears in
 * source, in the CloudFormation template, or in the browser.
 *
 * This module is **framework-neutral and dependency-free** (no CDK, no AWS SDK,
 * no `@aws-blocks/*`). It is a leaf so any consumer — the `Hosting` construct, a
 * framework wrapper, a plain framework app, or a future standalone hosting
 * package — can import the same marker without a dependency cycle or inheriting
 * a framework's branding. Consumers decide *how* and *when* to resolve it, and
 * supply their own SSM namespace via {@link secretParameterName}'s `prefix`.
 *
 * @module
 */

/**
 * Branded marker returned by {@link secret}. Carrying a unique symbol lets
 * consumers reliably distinguish a real secret reference from an arbitrary
 * object that happens to have a `key` field — see {@link isSecret}.
 */
export interface SecretValue {
	/** Brand — present only on values produced by {@link secret}. */
	readonly [SECRET_BRAND]: true;
	/**
	 * The logical secret name. This is the key the customer sets with
	 * `secret set <key> <value>` and references with `secret('<key>')`.
	 * The mapping is 1:1 — the key you set is the key you reference (no implicit
	 * stage-scoping). The underlying SSM parameter path is derived from this key
	 * by {@link secretParameterName}.
	 */
	readonly key: string;
	/**
	 * When the secret's value is resolved. See {@link SecretResolveAt}.
	 * - `'runtime'` (default) — stays encrypted; fetched lazily via {@link getSecret}.
	 * - `'deploy'` — resolved at synth and injected as a plaintext env var
	 *   (escape hatch; the value leaves the encrypted store — see the security
	 *   note on {@link SecretResolveAt}).
	 */
	readonly resolveAt: SecretResolveAt;
}

/**
 * When a secret's value is resolved and delivered.
 *
 * - `'runtime'` (**default, secure**) — only the store *locator* is wired into
 *   the compute; `getSecret(KEY)` fetches + decrypts the value on first use. The
 *   value stays encrypted at rest and never enters the CloudFormation template,
 *   the Lambda configuration, or the client bundle.
 * - `'deploy'` — the value is resolved at **synth time** (SDK read) and injected
 *   as a **plaintext** Lambda environment variable, so `process.env[KEY]` works
 *   with no runtime code. Use only when an integration insists on reading
 *   `process.env` and can't call {@link getSecret}.
 *
 *   ⚠️ **Security implication of `'deploy'`.** The resolved plaintext leaves the
 *   encrypted store: it is readable by anyone with `lambda:GetFunctionConfiguration`
 *   (or in the Lambda console), and — for the SSM store — it is also inlined into
 *   the CloudFormation template (readable via `cloudformation:GetTemplate`). It is
 *   also baked in at deploy, so rotating the value requires a redeploy. The
 *   `'runtime'` default has none of these properties; prefer it.
 */
export type SecretResolveAt = 'runtime' | 'deploy';

/** Unique brand symbol. `Symbol.for` so the brand survives across module/realm copies. */
export const SECRET_BRAND: unique symbol = Symbol.for('@aws-blocks/hosting.SecretValue');

/**
 * Which backing store holds a secret value.
 * - `'secrets-manager'` — AWS Secrets Manager (**default**): encrypted at rest,
 *   with **built-in automatic rotation** and native service integrations. This
 *   is the store AWS's public guidance recommends for application secrets and
 *   credentials (API tokens, database passwords) — see
 *   https://aws.amazon.com/blogs/security/how-to-choose-the-right-aws-service-for-managing-secrets-and-configurations/
 * - `'ssm'` — SSM Parameter Store SecureString: free and scales to zero. Per
 *   the same guidance, best for *non-sensitive* configuration and simple
 *   key-value pairs that don't need rotation; kept as a first-class opt-in.
 */
export type SecretStore = 'ssm' | 'secrets-manager';

/**
 * Default backing store for hosting/pipeline secrets: **`'secrets-manager'`**.
 * AWS's public guidance ("How to choose the right AWS service for managing
 * secrets and configurations", 2025) recommends Secrets Manager for application
 * secrets and credentials — for its automatic rotation, multi-Region
 * replication, and native service integrations — while Parameter Store is for
 * non-sensitive configuration. `secret()` holds credentials, so it defaults to
 * Secrets Manager.
 *
 * MIGRATION SEAM: this single constant selects the default for every consumer
 * (CLI write, wireRuntimeSecret, resolveSecretsAtSynth, runtime getSecret).
 * Callers that pin an explicit `store` are unaffected. NOTE for anyone who set
 * secrets under an earlier SSM default: SSM and Secrets Manager are distinct
 * services — an SSM value is NOT auto-copied to SM, so re-run
 * `secret set <KEY>` once per key after upgrading (or pin `store: 'ssm'`).
 *
 * NOTE: this is the leaf's neutral default for DIRECT consumers (a standalone
 * hosting app, pipeline, or any other framework-neutral caller of the L3).
 * `@aws-blocks/core` (Blocks) pins its own SSM `/blocks/secrets` namespace
 * independently and is unaffected by this constant.
 */
export const DEFAULT_SECRET_STORE: SecretStore = 'secrets-manager';

/** Options for {@link secret}. */
export interface SecretOptions {
	/**
	 * When the value is resolved and delivered — expresses intent, not a side
	 * effect. `'runtime'` (default) keeps it encrypted and fetched via
	 * {@link getSecret}; `'deploy'` resolves at synth and inlines a plaintext env
	 * var. See {@link SecretResolveAt} for the full semantics and the security
	 * implication of `'deploy'`. @default 'runtime'
	 */
	resolveAt?: SecretResolveAt;
}

/**
 * Validation for secret keys. Keys map to SSM parameter path segments and to
 * environment variable names, so we constrain them to a safe, portable charset:
 * start with a letter or underscore, then letters/digits/underscores. This is
 * the intersection of "valid env var name" and "safe SSM path segment".
 */
const SECRET_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reference a secret stored in SSM Parameter Store (SecureString).
 *
 * @param key - Logical secret name (e.g. `'STRIPE_KEY'`, `'DOMAIN_PROD'`).
 *   Must match `^[A-Za-z_][A-Za-z0-9_]*$`. Set the value out-of-band with your
 *   consumer's CLI (e.g. `blocks secret set <key> <value>`).
 * @returns A {@link SecretValue} marker — pass it into `Hosting` props
 *   (`compute.environment` values, or `domain.domainName`).
 *
 * @example
 * ```ts
 * import { Hosting, secret } from '@aws-blocks/blocks/cdk';
 *
 * await Hosting.create(stack, 'Web', {
 *   root: '.',
 *   framework: 'nextjs',
 *   domain: { domainName: secret('DOMAIN_PROD') },
 *   environment: {
 *     STRIPE_KEY: secret('STRIPE_KEY'),          // resolved at runtime via getSecret()
 *     LEGACY_TOKEN: secret('LEGACY', { resolveAt: 'deploy' }), // plaintext env (escape hatch)
 *   },
 * });
 * ```
 */
export function secret(key: string, options: SecretOptions = {}): SecretValue {
	if (typeof key !== 'string' || !SECRET_KEY_PATTERN.test(key)) {
		throw new Error(
			`secret(): invalid key ${JSON.stringify(key)}. Keys must match ` +
				`${SECRET_KEY_PATTERN} (start with a letter or underscore, then ` +
				`letters, digits, or underscores).`,
		);
	}
	return {
		[SECRET_BRAND]: true,
		key,
		resolveAt: options.resolveAt ?? 'runtime',
	};
}

/** Type guard: is `value` a marker produced by {@link secret}? */
export function isSecret(value: unknown): value is SecretValue {
	return (
		typeof value === 'object' && value !== null && (value as Record<PropertyKey, unknown>)[SECRET_BRAND] === true
	);
}

// ── SSM path convention (single source of truth) ────────────────────────────

/**
 * Framework-neutral default prefix for secrets in SSM Parameter Store, used
 * when a consumer does not supply its own. A branded consumer overrides this by
 * passing an explicit `prefix` to {@link secretParameterName} (e.g. Blocks
 * passes `/blocks/secrets`), so this package never hardcodes a framework's
 * namespace into the shared upstream.
 *
 * NOTE: must NOT begin with `aws` or `ssm` — SSM Parameter Store reserves
 * those prefixes and rejects create/read with "No access to reserved parameter
 * name". (An earlier `/aws-hosting/...` default hit exactly that.)
 */
export const DEFAULT_SECRET_PARAMETER_PREFIX = '/hosting/secrets';

/**
 * Map a logical secret key to its SSM parameter name. This is the ONLY place
 * the path is constructed — the CLI (`secret set`), the CDK wiring (IAM grants
 * + env injection), and the runtime resolver all route through here so the name
 * can never drift between write and read.
 *
 * Flat namespace by design: a given key + prefix always resolves to the same
 * path regardless of which stage is deploying. The customer picks the key
 * explicitly — no magic scoping.
 *
 * @param key - The logical secret name.
 * @param prefix - SSM path prefix (no trailing slash). Defaults to
 *   {@link DEFAULT_SECRET_PARAMETER_PREFIX}. Consumers inject their own to keep
 *   this package brand-neutral (e.g. Blocks passes `/blocks/secrets`).
 * @example secretParameterName('STRIPE_KEY') // '/hosting/secrets/STRIPE_KEY'
 * @example secretParameterName('STRIPE_KEY', '/blocks/secrets') // '/blocks/secrets/STRIPE_KEY'
 */
export function secretParameterName(key: string, prefix: string = DEFAULT_SECRET_PARAMETER_PREFIX): string {
	return `${prefix}/${key}`;
}

/**
 * The store-appropriate locator for a secret — the string used identically by
 * the CLI (create/delete), the CDK IAM grant, the synth-time fetch, and the
 * runtime read, so a value written under one store is always found under the
 * same name.
 *
 * - **SSM** uses the leading-slash *path* form (`/hosting/secrets/KEY`).
 * - **Secrets Manager** secret *names* are conventionally slash-free at the
 *   root; the leading slash is stripped (`hosting/secrets/KEY`) so the created
 *   name and the IAM ARN resource (`…:secret:hosting/secrets/KEY-*`) agree.
 *   (A leading slash silently mismatched the ARN the grant scoped to.)
 *
 * When `stage` is given, it becomes a path segment between the prefix and the
 * key (`<prefix>/<stage>/<key>`), so the same logical key can hold a distinct
 * value per environment. Omitting `stage` yields the shared/flat locator
 * (`<prefix>/<key>`) — the fallback that stage-specific lookups fall back to,
 * and the only form used when a consumer opts out of per-stage secrets.
 *
 * @param key - The logical secret name.
 * @param opts.prefix - Path prefix (no trailing slash). Default {@link DEFAULT_SECRET_PARAMETER_PREFIX}.
 * @param opts.store - Backing store. Default {@link DEFAULT_SECRET_STORE}.
 * @param opts.stage - Optional environment segment (e.g. `'prod'`). Omit for the shared value.
 * @example secretStoreLocator('K', { store: 'ssm' })                 // '/hosting/secrets/K'   (shared)
 * @example secretStoreLocator('K', { store: 'ssm', stage: 'prod' })  // '/hosting/secrets/prod/K'
 */
export function secretStoreLocator(
	key: string,
	opts: { prefix?: string; store?: SecretStore; stage?: string } = {},
): string {
	const basePrefix = opts.prefix ?? DEFAULT_SECRET_PARAMETER_PREFIX;
	const prefix = opts.stage ? `${basePrefix}/${opts.stage}` : basePrefix;
	const path = secretParameterName(key, prefix);
	const store = opts.store ?? DEFAULT_SECRET_STORE;
	return store === 'secrets-manager' ? path.replace(/^\//, '') : path;
}

/**
 * Environment variable name under which the Hosting wiring publishes a secret's
 * SSM parameter *name* (not its value) to the compute runtime. The runtime
 * resolver ({@link getSecret}) reads this to know which parameter to fetch.
 *
 * Kept distinct from the customer's own key so a `secret('FOO')` reference and
 * a plain `environment: { FOO: '...' }` literal can coexist without collision.
 * The prefix is framework-neutral (`HOSTING_SECRET_PARAM_`) because this env var
 * is internal wiring shared by every consumer, not a customer-facing name.
 *
 * @example secretEnvVarName('STRIPE_KEY') // 'HOSTING_SECRET_PARAM_STRIPE_KEY'
 */
export function secretEnvVarName(key: string): string {
	return `HOSTING_SECRET_PARAM_${key}`;
}

/**
 * Env var name under which the wiring publishes the *fallback* (shared) locator
 * for a stage-scoped secret. Injected only when a `stage` is in play: the
 * runtime resolver tries {@link secretEnvVarName} (the stage-specific locator)
 * first and falls back to this shared locator on a not-found. Absent when the
 * consumer uses no stage, so the single-locator path is unchanged.
 *
 * @example secretFallbackEnvVarName('STRIPE_KEY') // 'HOSTING_SECRET_PARAM_STRIPE_KEY_FALLBACK'
 */
export function secretFallbackEnvVarName(key: string): string {
	return `${secretEnvVarName(key)}_FALLBACK`;
}
