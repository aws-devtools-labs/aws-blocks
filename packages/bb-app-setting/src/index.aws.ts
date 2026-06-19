// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
	SSMClient,
	GetParameterCommand,
	PutParameterCommand,
} from '@aws-sdk/client-ssm';
import { Scope, registerSdkIdentifiers, getSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { AppSettingErrors } from './errors.js';
import type { AppSettingOptions, InternalAppSettingOptions } from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

// Re-export public types from types module (canonical source)
export { AppSettingErrors } from './errors.js';
export { copyFrom } from './types.js';
export type { AppSettingOptions, CopyFromSource } from './types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

async function validateSchema<T>(schema: StandardSchemaV1<T> | undefined, value: unknown): Promise<void> {
	if (!schema) return;
	const result = schema['~standard'].validate(value);
	const resolved = result instanceof Promise ? await result : result;
	if (resolved.issues) {
		throw blocksError(AppSettingErrors.ValidationFailed, resolved.issues[0].message);
	}
}

// ── AppSetting (AWS runtime) ────────────────────────────────────────────────

/**
 * A single application configuration value backed by SSM Parameter Store.
 *
 * **When to use:** You need to store and retrieve a non-secret configuration
 * value at runtime — a feature flag, API URL, threshold, or structured config
 * object. For sensitive values, set `secret: true` to use SSM SecureString.
 *
 * **When NOT to use:** If you need structured key-value data with conditional
 * writes and queries, use `KVStore` or `DistributedTable`.
 *
 * **Best practices:**
 * - One AppSetting per logical configuration value
 * - Use a schema for structured objects to get type safety and runtime validation
 * - Use `secret: true` for API keys, tokens, and passwords
 *
 * **Scaling:** Standard-tier SSM parameters. 40 TPS default for GetParameter
 * (can be increased). No cost for standard parameters.
 */
export class AppSetting<T = string> extends Scope {
	/**
	 * Reference an SSM parameter created and owned **outside this stack** (e.g. a
	 * connection string seeded out-of-band by your own tooling). At runtime this
	 * reads the value like any other setting; the construct-time behavior (no
	 * create/seed/tag/delete, read-only grant) is applied by the CDK variant. The
	 * factory exists on every variant so app code uses one API across dev/deploy.
	 */
	static fromExisting<T = string>(
		scope: ScopeParent,
		id: string,
		options: { name?: string; secret?: boolean },
	): AppSetting<T> {
		const opts: InternalAppSettingOptions<T> = { ...options, external: true };
		return new AppSetting<T>(scope, id, opts);
	}

	readonly bbName = BB_NAME;
	private schema?: StandardSchemaV1<T>;
	private isSecret: boolean;
	private client: SSMClient;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options: AppSettingOptions<T>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });

		const parameterName = options.name ?? `/${this.fullId}`;
		this.schema = options.schema;
		this.isSecret = options.secret ?? false;
		this.client = new SSMClient({
			customUserAgent: this.buildUserAgentChain(),
		});
		registerSdkIdentifiers(this.fullId, { parameterName });
	}

	/**
	 * Retrieve the current value.
	 *
	 * Returns the stored SSM parameter value. The parameter is guaranteed
	 * to exist because the CDK layer creates it with the initial value.
	 *
	 * @returns The current value.
	 * @throws {AppSettingErrors.ParameterNotFound} If the parameter does not exist in SSM (e.g., deleted out-of-band).
	 *
	 * @example
	 * ```typescript
	 * const retries = await maxRetries.get();
	 * ```
	 */
	async get(): Promise<T> {
		const result = await this.client.send(new GetParameterCommand({
			Name: getSdkIdentifiers(this).parameterName,
			WithDecryption: this.isSecret,
		}));

		this.client.config.customUserAgent = this.buildUserAgentChain();
		const raw = result.Parameter?.Value;
		if (raw === undefined || raw === null) {
			throw blocksError(AppSettingErrors.ParameterNotFound, `Parameter "${getSdkIdentifiers(this).parameterName}" has no value`);
		}

		let value: T;
		try {
			value = JSON.parse(raw) as T;
		} catch {
			// fallback for old-format values
			value = raw as T;
		}

		if (this.isSecret && value === ('' as unknown as T)) {
			throw blocksError(AppSettingErrors.ParameterNotFound, `Secret parameter "${getSdkIdentifiers(this).parameterName}" has an empty value — secrets must not be empty`);
		}

		return value;
	}

	/**
	 * Update the value at runtime.
	 *
	 * Overwrites the current SSM parameter value. When a schema is configured,
	 * the value is validated before writing.
	 *
	 * @param value - The new value to store.
	 * @throws {AppSettingErrors.ValidationFailed} If schema validation fails or value exceeds 4 KB.
	 *
	 * @example
	 * ```typescript
	 * await maxRetries.put('5');
	 * await config.put({ maxRetries: 5, timeout: 10000 });
	 * ```
	 */
	async put(value: T): Promise<void> {
		await validateSchema(this.schema, value);

		const serialized = JSON.stringify(value);

		await this.client.send(new PutParameterCommand({
			Name: getSdkIdentifiers(this).parameterName,
			Value: serialized,
			Type: this.isSecret ? 'SecureString' : 'String',
			Overwrite: true,
		}));
	}
}
