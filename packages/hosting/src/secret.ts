// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `secret()` — a deferred reference to a sensitive value stored in AWS Systems
 * Manager Parameter Store (SecureString), for self-hosted Blocks deployments.
 *
 * A `secret('STRIPE_KEY')` call does NOT return the secret value. It returns a
 * lightweight **marker** — think of it as a coat-check ticket. The ticket is
 * safe to write in source code and commit to git; only AWS (the cloakroom),
 * given the right IAM permissions (your ID), can exchange it for the real
 * value. The value itself lives encrypted at rest in Parameter Store and is
 * set out-of-band via `blocks secret set <KEY> <value>` — it never appears in
 * source, in the CloudFormation template, or in the browser.
 *
 * This module is intentionally **dependency-free** (no CDK, no AWS SDK). It is
 * a leaf so that both `@aws-blocks/core` (for the `Hosting` block) and, later,
 * `@aws-blocks/pipeline` can import the same marker without a dependency cycle.
 * The packages that consume the marker decide *how* and *when* to resolve it.
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
	 * `blocks secret set <key> <value>` and references with `secret('<key>')`.
	 * The mapping is 1:1 — the key you set is the key you reference (no implicit
	 * stage-scoping). The underlying SSM parameter path is derived from this key
	 * by {@link secretParameterName}.
	 */
	readonly key: string;
	/**
	 * Opt-in escape hatch. When `true`, the consumer resolves the secret at
	 * **deploy time** and injects the plaintext value directly as a Lambda
	 * environment variable, so `process.env[KEY]` works with no runtime code.
	 *
	 * ⚠️ Tradeoff: the resolved value then appears in plaintext in the Lambda's
	 * configuration and the CloudFormation template — it is no longer encrypted
	 * at rest. Leave this `false` (the default) unless an integration genuinely
	 * needs `process.env` and you accept that exposure. The secure default
	 * resolves the value at runtime via {@link getSecret}.
	 */
	readonly exposeAsEnv: boolean;
}

/** Unique brand symbol. `Symbol.for` so the brand survives across module/realm copies. */
export const SECRET_BRAND: unique symbol = Symbol.for('@aws-blocks/hosting.SecretValue');

/** Options for {@link secret}. */
export interface SecretOptions {
	/**
	 * Resolve the secret at deploy time and inject it as a plaintext Lambda
	 * environment variable instead of resolving lazily at runtime. See
	 * {@link SecretValue.exposeAsEnv} for the security tradeoff. @default false
	 */
	exposeAsEnv?: boolean;
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
 *   Must match `^[A-Za-z_][A-Za-z0-9_]*$`. Set the value out-of-band with
 *   `blocks secret set <key> <value>`.
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
 *     LEGACY_TOKEN: secret('LEGACY', { exposeAsEnv: true }), // plaintext env (escape hatch)
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
		exposeAsEnv: options.exposeAsEnv ?? false,
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
 * Root prefix for all hosting secrets in SSM Parameter Store. Kept under
 * `/blocks/` to sit alongside the existing `/blocks/{stage}/db-connection-string`
 * convention used by the database provisioner, so a customer browsing Parameter
 * Store sees one consistent `/blocks` namespace.
 */
export const SECRET_PARAMETER_PREFIX = '/blocks/secrets';

/**
 * Map a logical secret key to its SSM parameter name. This is the ONLY place
 * the path is constructed — the CLI (`blocks secret set`), the CDK wiring
 * (IAM grants + env injection), and the runtime resolver all route through
 * here so the name can never drift between write and read.
 *
 * Flat namespace by design: `secret('DOMAIN_BETA')` always resolves to
 * `/blocks/secrets/DOMAIN_BETA` regardless of which stage is deploying. The
 * customer picks the key explicitly — no magic scoping.
 *
 * @example secretParameterName('STRIPE_KEY') // '/blocks/secrets/STRIPE_KEY'
 */
export function secretParameterName(key: string): string {
	return `${SECRET_PARAMETER_PREFIX}/${key}`;
}

/**
 * Environment variable name under which the Hosting wiring publishes a secret's
 * SSM parameter *name* (not its value) to the compute runtime. The runtime
 * resolver ({@link getSecret}) reads this to know which parameter to fetch.
 *
 * Kept distinct from the customer's own key so a `secret('FOO')` reference and
 * a plain `environment: { FOO: '...' }` literal can coexist without collision.
 *
 * @example secretEnvVarName('STRIPE_KEY') // 'BLOCKS_SECRET_PARAM_STRIPE_KEY'
 */
export function secretEnvVarName(key: string): string {
	return `BLOCKS_SECRET_PARAM_${key}`;
}
