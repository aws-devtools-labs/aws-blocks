// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AppSettingErrors } from './errors.js';
import type { InternalAppSettingOptions } from './types.js';

function blocksError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

/**
 * Validate the synchronous option combinations for an AppSetting.
 *
 * These checks depend only on which options are set together (not on the
 * supplied value against a schema, which can be async), so they must behave
 * identically in local mock and CDK. Async Standard Schema value validation
 * stays in each variant's own `put()` path.
 *
 * Throws {@link AppSettingErrors.ValidationFailed} on the first invalid
 * combination. `external` is package-internal (set only by `fromExisting`).
 */
export function validateAppSettingOptions<T>(
	id: string,
	options: InternalAppSettingOptions<T>,
): void {
	const external = options.external ?? false;

	if (options.secret && options.schema) {
		throw blocksError(
			AppSettingErrors.ValidationFailed,
			`AppSetting '${id}': 'secret' and 'schema' cannot be used together. ` +
			`Secrets are always plain strings. Remove the schema or the secret flag.`,
		);
	}

	if (options.schema && options.value === undefined) {
		throw blocksError(
			AppSettingErrors.ValidationFailed,
			`AppSetting '${id}': a schema is provided but no value. ` +
			`Provide a value that conforms to the schema so the SSM parameter is valid on first deploy.`,
		);
	}

	if (options.kmsKeyArn !== undefined) {
		if (!options.secret) {
			throw blocksError(
				AppSettingErrors.ValidationFailed,
				`AppSetting '${id}': 'kmsKeyArn' is only valid with 'secret: true'. ` +
				`Non-secret String parameters are not encrypted.`,
			);
		}
		if (options.kmsKeyArn.trim() === '') {
			throw blocksError(
				AppSettingErrors.ValidationFailed,
				`AppSetting '${id}': 'kmsKeyArn' must be a non-empty KMS key ARN. ` +
				`Omit it to use the default aws/ssm key.`,
			);
		}
	}

	if (options.secret && options.value !== undefined) {
		throw blocksError(
			AppSettingErrors.ValidationFailed,
			`AppSetting '${id}': secrets should not have a value in source code. ` +
			`Remove the value — a random secret will be generated on first deploy. ` +
			`Set the real value at runtime via AppSetting.put().`,
		);
	}

	if (external && options.value !== undefined) {
		throw blocksError(
			AppSettingErrors.ValidationFailed,
			`AppSetting '${id}': 'external' settings are owned elsewhere and must not have a value. ` +
			`Remove the value — the parameter is created and seeded outside this stack.`,
		);
	}

	if (external && !options.name) {
		throw blocksError(
			AppSettingErrors.ValidationFailed,
			`AppSetting '${id}': 'external' requires an explicit 'name' referencing the existing parameter.`,
		);
	}

	if (!options.secret && !external && options.value === undefined) {
		throw blocksError(
			AppSettingErrors.ValidationFailed,
			`AppSetting '${id}': non-secret settings require a value. ` +
			`Provide an initial value for the SSM parameter.`,
		);
	}
}
