// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import type { ScopeParent } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppSettingErrors } from './errors.js';
import type { AppSettingOptions, InternalAppSettingOptions } from './types.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';

// Re-export public types
export { AppSettingErrors } from './errors.js';
export type { AppSettingOptions } from './types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const MAX_VALUE_BYTES = 4096; // SSM standard-tier 4 KB limit

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

// ── AppSetting (mock) ───────────────────────────────────────────────────────

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
	 * Reference an SSM parameter created and owned outside this stack — the local
	 * dev mirror of the CDK `fromExisting`. In the mock there is no IAM or
	 * bulk-init, so it behaves like a normal setting keyed by its `fullId`; the
	 * factory exists so app code uses the same API in dev and deploy.
	 *
	 * Note: like any mock secret with no value, `get()` returns a random placeholder
	 * unless `.bb-data/settings.json` was already seeded for this `fullId` (e.g. by
	 * `db pull`). Local dev still depends on whatever seeds that value.
	 */
	static fromExisting<T = string>(
		scope: ScopeParent,
		id: string,
		options: { name?: string; secret?: boolean },
	): AppSetting<T> {
		const opts: InternalAppSettingOptions<T> = { ...options, external: true };
		return new AppSetting<T>(scope, id, opts);
	}

	private parameterName: string;
	private initialValue: T;
	private schema?: StandardSchemaV1<T>;
	private isSecret: boolean;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options: AppSettingOptions<T>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.parameterName = options.name ?? `/${this.fullId}`;
		this.schema = options.schema;
		this.isSecret = options.secret ?? false;

		// Determine initial value: use provided value, or generate random for secrets, or empty string
		if (options.value !== undefined) {
			this.initialValue = options.value;
		} else if (this.isSecret) {
			this.initialValue = randomBytes(32).toString('base64url') as T;
		} else {
			this.initialValue = '' as T;
		}
		registerSdkIdentifiers(this.fullId, { parameterName: this.parameterName });

		// Persist initial value to settings.json if not already present
		const settings = readSettings(this);
		if (!(this.fullId in settings)) {
			settings[this.fullId] = this.initialValue;
			writeSettings(this, settings);
		}
	}

	/**
	 * Retrieve the current value.
	 *
	 * Returns the stored value from `.bb-data/settings.json`.
	 *
	 * @returns The current value.
	 *
	 * @example
	 * ```typescript
	 * const retries = await maxRetries.get();
	 * ```
	 */
	async get(): Promise<T> {
		const settings = readSettings(this);
		const value = (this.fullId in settings ? settings[this.fullId] : this.initialValue) as T;

		if (this.isSecret && value === ('' as unknown as T)) {
			throw blocksError(AppSettingErrors.ParameterNotFound, `Secret parameter "${this.parameterName}" has an empty value — secrets must not be empty`);
		}

		return value;
	}

	/**
	 * Update the value at runtime.
	 *
	 * Writes the new value to `.bb-data/settings.json`. When a schema is
	 * configured, the value is validated before writing.
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
		if (!this.isSecret && Buffer.byteLength(serialized, 'utf8') > MAX_VALUE_BYTES) {
			throw blocksError(
				AppSettingErrors.ValidationFailed,
				`Value size ${Buffer.byteLength(serialized, 'utf8')} bytes exceeds the 4 KB (${MAX_VALUE_BYTES} bytes) limit`,
			);
		}

		const settings = readSettings(this);
		settings[this.fullId] = value;
		writeSettings(this, settings);
	}
}
