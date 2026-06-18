// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Scope, registerConfig, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import { AppSettingErrors } from './errors.js';
import type { AppSettingOptions, InternalAppSettingOptions } from './types.js';

export { AppSettingErrors } from './errors.js';
export type { AppSettingOptions } from './types.js';

/**
 * CDK construct for AppSetting. Creates a single SSM parameter (String or
 * SecureString) and grants the shared Lambda handler read/write permissions.
 *
 * - String parameters use `aws-cdk-lib/aws-ssm.StringParameter` directly.
 * - SecureString parameters use a Custom Resource Lambda because
 *   CloudFormation cannot natively create SecureString parameters.
 * - SecureString parameters are encrypted with the default `aws/ssm` KMS key.
 */
export class AppSetting<T = string> extends Scope {
	/**
	 * Reference an SSM parameter that is created and owned **outside this stack**
	 * (e.g. a connection string seeded by `ensureSecrets` before deploy). The
	 * construct does not create, seed, tag, or delete it — it only grants the app
	 * **read-only** access (`ssm:GetParameter`, plus `kms:Decrypt` when `secret`)
	 * and registers the name for config resolution.
	 *
	 * The parameter MUST already exist at deploy time, otherwise the app fails at
	 * runtime with `ParameterNotFound`.
	 *
	 * `name` is optional. When omitted, the parameter is named with the
	 * framework default `/${fullId}` (stack-scoped, so it never collides across
	 * apps in one account/region). The resolved name is exposed as a `CfnOutput`
	 * so an out-of-band writer (`ensureSecrets`, post-deploy) can discover and
	 * seed it. Pass `name` only when referencing a parameter whose name is fixed
	 * by something outside this stack.
	 *
	 * @example
	 * // self-named, stack-scoped (preferred for app-owned external secrets):
	 * const dbUrl = AppSetting.fromExisting(scope, 'db-url', { secret: true });
	 */
	static fromExisting<T = string>(
		scope: ScopeParent,
		id: string,
		options: { name?: string; secret?: boolean },
	): AppSetting<T> {
		const opts: InternalAppSettingOptions<T> = { ...options, external: true };
		return new AppSetting<T>(scope, id, opts);
	}

	constructor(scope: ScopeParent, id: string, options: AppSettingOptions<T>) {
		super(id, { parent: scope });

		// `external` is package-internal (set only by fromExisting), not on the
		// public AppSettingOptions — read it via the internal options type.
		const external = (options as InternalAppSettingOptions<T>).external ?? false;

		// ── Validation ──────────────────────────────────────────────────────
		if (options.secret && options.schema) {
			const err = new Error(
				`AppSetting '${id}': 'secret' and 'schema' cannot be used together. ` +
				`Secrets are always plain strings. Remove the schema or the secret flag.`
			);
			err.name = AppSettingErrors.ValidationFailed;
			throw err;
		}

		if (options.schema && options.value === undefined) {
			const err = new Error(
				`AppSetting '${id}': a schema is provided but no value. ` +
				`Provide a value that conforms to the schema so the SSM parameter is valid on first deploy.`
			);
			err.name = AppSettingErrors.ValidationFailed;
			throw err;
		}

		if (options.secret && options.value !== undefined) {
			const err = new Error(
				`AppSetting '${id}': secrets should not have a value in source code. ` +
				`Remove the value — a random secret will be generated on first deploy. ` +
				`Set the real value at runtime via AppSetting.put().`
			);
			err.name = AppSettingErrors.ValidationFailed;
			throw err;
		}

		if (external && options.value !== undefined) {
			const err = new Error(
				`AppSetting '${id}': 'external' settings are owned elsewhere and must not have a value. ` +
				`Remove the value — the parameter is created and seeded outside this stack.`
			);
			err.name = AppSettingErrors.ValidationFailed;
			throw err;
		}

		if (!options.secret && !external && options.value === undefined) {
			const err = new Error(
				`AppSetting '${id}': non-secret settings require a value. ` +
				`Provide an initial value for the SSM parameter.`
			);
			err.name = AppSettingErrors.ValidationFailed;
			throw err;
		}

		const parameterName = options.name ?? `/${this.fullId}`;

		// Always JSON.stringify
		// For secrets without a value, the Custom Resource Lambda generates a random string
		const initialValue = options.value !== undefined
			? JSON.stringify(options.value)
			: undefined;

		const parameterArn = cdk.Stack.of(this).formatArn({
			service: 'ssm',
			resource: 'parameter',
			resourceName: parameterName.replace(/^\//, ''),
		});

		if (options.secret) {
			// ── SecureString ────────────────────────────────────────────────
			// Externally-owned secrets (e.g. the connection string seeded by
			// ensureSecrets) are NOT enrolled in the bulk-init: it would
			// PutParameter a random placeholder over a parameter we don't own and
			// then fail tagging it (AddTagsToResource needs ssm:GetParameters).
			// We only need runtime read access, granted below.
			if (!external) {
				registerSecret(cdk.Stack.of(this), parameterName);
			}

			// Grant handler KMS access for the default aws/ssm key. External secrets
			// are read-only (Decrypt only); stack-managed secrets also need Encrypt
			// so the app can write the value via put().
			this.handler.addToRolePolicy(new iam.PolicyStatement({
				actions: external ? ['kms:Decrypt'] : ['kms:Decrypt', 'kms:Encrypt'],
				resources: ['*'],
				conditions: {
					StringEquals: {
						'kms:ViaService': `ssm.${cdk.Stack.of(this).region}.amazonaws.com`,
					},
				},
			}));
		} else if (!external) {
			// ── String parameter via CDK construct ──────────────────────────
			const param = new ssm.StringParameter(this, 'Param', {
				parameterName,
				stringValue: initialValue ?? '',
			});
			let tagStack = cdk.Stack.of(this);
			while (tagStack.nestedStackParent) tagStack = tagStack.nestedStackParent;
			cdk.Tags.of(param).add('aws-blocks-stack', tagStack.stackName);
		}
		// (external non-secret: parameter exists already; nothing to create.)

		// Grant handler SSM access on this parameter. External parameters are owned
		// elsewhere, so the app only reads them (no ssm:PutParameter).
		this.handler.addToRolePolicy(new iam.PolicyStatement({
			actions: external ? ['ssm:GetParameter'] : ['ssm:GetParameter', 'ssm:PutParameter'],
			resources: [parameterArn],
		}));

		// Pass the parameter name to the runtime via config registry
		const envKey = `BLOCKS_SSM_PARAM_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
		registerConfig(this, envKey, parameterName);

		// External secrets are seeded out-of-band AFTER deploy (e.g. the DB
		// connection string written by `ensureSecrets`). Expose the resolved,
		// synth-time name as a CfnOutput so the deploy script can read it back
		// from the stack outputs and write to the exact same name — making the
		// written name == the stamped name == the name the Lambda reads, with no
		// pre-synth recomputation (see db-connection-param multi-app design).
		if (external) {
			const outputId = `BlocksSsmParam${id.split(/[^a-zA-Z0-9]+/).filter(Boolean)
				.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('')}`;
			new cdk.CfnOutput(cdk.Stack.of(this), outputId, {
				value: parameterName,
				description: `SSM parameter name for external AppSetting '${id}' (seeded out-of-band post-deploy).`,
			});
		}
	}
}

// ── Bulk Secret Initialization (one CustomResource per stack) ───────────────

const SECRET_BULK_KEY = Symbol.for('BLOCKS_SECRET_BULK_INIT');

interface SecretBulkState {
	parameterNames: string[];
}

/**
 * Register a secret parameter name. On first call, creates the shared Lambda,
 * Provider, and a single CustomResource. All subsequent calls just append to
 * the parameter list (resolved lazily at synth time).
 */
function registerSecret(stack: cdk.Stack, parameterName: string): void {
	let state = (stack as any)[SECRET_BULK_KEY] as SecretBulkState | undefined;
	if (state) {
		state.parameterNames.push(parameterName);
		return;
	}

	// First secret in this stack — create all shared infrastructure
	state = { parameterNames: [parameterName] };
	(stack as any)[SECRET_BULK_KEY] = state;

	const secretInitFn = new lambda.Function(stack, 'BlocksSecretInitFn', {
		runtime: DEFAULT_NODE_RUNTIME,
		handler: 'index.handler',
		code: lambda.Code.fromInline(`
			const { SSMClient, PutParameterCommand, DeleteParameterCommand, AddTagsToResourceCommand } = require('@aws-sdk/client-ssm');
			const crypto = require('crypto');
			const client = new SSMClient({});
			exports.handler = async (event) => {
				const names = event.ResourceProperties.ParameterNames || [];
				const stackName = event.ResourceProperties.StackName || '';
				const tags = stackName ? [{ Key: 'aws-blocks-stack', Value: stackName }] : [];
				const oldNames = (event.OldResourceProperties || {}).ParameterNames || [];
				if (event.RequestType === 'Delete') {
					for (const name of names) {
						try { await client.send(new DeleteParameterCommand({ Name: name })); } catch {}
					}
					return { PhysicalResourceId: 'bb-secrets-bulk' };
				}
				if (event.RequestType === 'Create') {
					for (const name of names) {
						const secret = crypto.randomBytes(32).toString('base64url');
						try {
							await client.send(new PutParameterCommand({
								Name: name, Value: secret, Type: 'SecureString', Overwrite: false, Tags: tags,
							}));
						} catch (e) {
							if (e.name !== 'ParameterAlreadyExists') throw e;
							if (tags.length) {
								await client.send(new AddTagsToResourceCommand({ ResourceType: 'Parameter', ResourceId: name, Tags: tags }));
							}
						}
					}
					return { PhysicalResourceId: 'bb-secrets-bulk' };
				}
				if (event.RequestType === 'Update') {
					const added = names.filter(n => !oldNames.includes(n));
					const removed = oldNames.filter(n => !names.includes(n));
					for (const name of added) {
						const secret = crypto.randomBytes(32).toString('base64url');
						try {
							await client.send(new PutParameterCommand({
								Name: name, Value: secret, Type: 'SecureString', Overwrite: false, Tags: tags,
							}));
						} catch (e) {
							if (e.name !== 'ParameterAlreadyExists') throw e;
							if (tags.length) {
								await client.send(new AddTagsToResourceCommand({ ResourceType: 'Parameter', ResourceId: name, Tags: tags }));
							}
						}
					}
					for (const name of removed) {
						try { await client.send(new DeleteParameterCommand({ Name: name })); } catch {}
					}
					return { PhysicalResourceId: 'bb-secrets-bulk' };
				}
				return { PhysicalResourceId: 'bb-secrets-bulk' };
			};
		`),
	});

	secretInitFn.addToRolePolicy(new iam.PolicyStatement({
		actions: ['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:AddTagsToResource'],
		resources: cdk.Lazy.list({
			produce: () => state!.parameterNames.map(name =>
				stack.formatArn({
					service: 'ssm',
					resource: 'parameter',
					resourceName: name.replace(/^\//, ''),
				})
			),
		}),
	}));

	secretInitFn.addToRolePolicy(new iam.PolicyStatement({
		actions: ['kms:Encrypt'],
		resources: ['*'],
		conditions: {
			StringEquals: {
				'kms:ViaService': `ssm.${stack.region}.amazonaws.com`,
			},
		},
	}));

	const provider = new cr.Provider(stack, 'BlocksSecretProvider', {
		onEventHandler: secretInitFn,
	});

	new cdk.CustomResource(stack, 'BlocksSecretsBulk', {
		serviceToken: provider.serviceToken,
		properties: {
			ParameterNames: cdk.Lazy.list({ produce: () => state!.parameterNames }),
			StackName: (() => { let s = stack; while (s.nestedStackParent) s = s.nestedStackParent; return s.stackName; })(),
		},
	});
}
