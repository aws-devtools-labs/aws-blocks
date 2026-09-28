// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildLogger } from '@aws-blocks/bb-logger';
import { Logger } from '@aws-blocks/bb-logger';
import type { ScopeParent } from '@aws-blocks/core';
import { installClientUserAgent, Scope } from '@aws-blocks/core';
import {
	GetSecretValueCommand,
	PutSecretValueCommand,
	ResourceNotFoundException,
	SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
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

async function validateSchema<T>(schema: StandardSchemaV1<T>, value: unknown): Promise<T> {
	const result = schema['~standard'].validate(value);
	const resolved = result instanceof Promise ? await result : result;
	if (resolved.issues) {
		throw blocksError(SecretErrors.ValidationFailed, resolved.issues[0].message);
	}
	return (resolved as { value: T }).value;
}

// ── Secret (AWS runtime) ────────────────────────────────────────────────────

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
 * The underlying secret ARN is resolved from the config registry that the CDK
 * layer populates (or directly from the `ExternalSecretRef` when wrapping an
 * existing secret via {@link Secret.fromExisting}).
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
	readonly bbName = BB_NAME;
	private schema?: StandardSchemaV1<T>;
	private constructId: string;
	private externalArn?: string;
	private client: SecretsManagerClient;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: SecretOptions<T>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.schema = options?.schema;
		this.constructId = id;
		this.externalArn = options?.secret?.secretArn;
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });

		this.client = new SecretsManagerClient({
			customUserAgent: this.buildUserAgentChain(),
		});
		installClientUserAgent(this.client);
	}

	/**
	 * Resolve the underlying secret ARN. Deferred to call time (not the
	 * constructor) so instantiating a Secret during CDK synth / client-spec
	 * generation — where the Lambda config env is not present — never throws;
	 * the ARN is only needed when a data method actually runs. When wrapping an
	 * existing secret via `fromExisting()`, the ARN is known directly; otherwise
	 * it comes from the config key the CDK layer registered
	 * (`BLOCKS_SECRET_ARN_<ID>`).
	 */
	private resolveSecretArn(): string {
		const secretArn = this.externalArn ?? process.env[configKey(this.constructId)];
		if (!secretArn) {
			throw blocksError(
				SecretErrors.NotSupported,
				`Secret '${this.constructId}' is missing its secret ARN. The CDK layer must register it (config key ${configKey(this.constructId)}), or pass an existing secret via Secret.fromExisting().`,
			);
		}
		return secretArn;
	}

	/**
	 * Read the secret value.
	 *
	 * Without a schema, returns the raw stored string. With a schema, parses the
	 * stored JSON and validates it, returning the typed value `T`.
	 *
	 * Returns `null` when the secret has no value yet or does not exist — reads
	 * never throw for a missing value, so callers can use `null` for normal
	 * control flow rather than try/catch.
	 *
	 * @returns The secret value, or `null` if it has not been set or does not exist.
	 * @throws {SecretErrors.ValidationFailed} If a schema is configured and the stored value is not valid JSON, or fails validation.
	 *
	 * @example
	 * ```typescript
	 * const key = await stripeKey.get();
	 * if (key === null) throw new Error('Stripe key not configured');
	 * ```
	 */
	async get(): Promise<T | null> {
		const secretArn = this.resolveSecretArn();
		let raw: string;
		try {
			const result = await this.client.send(new GetSecretValueCommand({ SecretId: secretArn }));
			if (result.SecretString === undefined || result.SecretString === null) return null;
			raw = result.SecretString;
		} catch (err: unknown) {
			if (err instanceof ResourceNotFoundException) return null;
			throw err;
		}

		if (this.schema) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				throw blocksError(SecretErrors.ValidationFailed, 'Stored secret value is not valid JSON');
			}
			return await validateSchema(this.schema, parsed);
		}

		return raw as unknown as T;
	}

	/**
	 * Update the secret value.
	 *
	 * Without a schema, accepts a string. With a schema, accepts `T`, validates
	 * it, and serializes to JSON before storing.
	 *
	 * @param value - The new secret value.
	 * @throws {SecretErrors.ValidationFailed} If a schema is configured and the value fails validation.
	 * @throws {SecretErrors.SecretNotFound} If the underlying Secrets Manager secret does not exist.
	 *
	 * @example
	 * ```typescript
	 * await stripeKey.put('sk_live_new_value');
	 * ```
	 */
	async put(value: T): Promise<void> {
		let serialized: string;
		if (this.schema) {
			await validateSchema(this.schema, value);
			serialized = JSON.stringify(value);
		} else {
			serialized = value as unknown as string;
		}

		const secretArn = this.resolveSecretArn();
		try {
			await this.client.send(new PutSecretValueCommand({ SecretId: secretArn, SecretString: serialized }));
		} catch (err: unknown) {
			if (err instanceof ResourceNotFoundException) {
				throw blocksError(SecretErrors.SecretNotFound, `Secret '${this.fullId}' does not exist`);
			}
			throw err;
		}
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

/**
 * The config-registry / environment key the CDK layer uses to pass a Secret's
 * ARN to the runtime. Derived from the construct `id` (same derivation on both
 * layers). The `BLOCKS_` prefix is framework-reserved.
 */
function configKey(id: string): string {
	return `BLOCKS_SECRET_ARN_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}
