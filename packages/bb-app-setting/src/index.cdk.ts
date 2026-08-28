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
 * - SecureString parameters are encrypted with the default `aws/ssm` KMS key,
 *   or with a customer-managed key when `kmsKeyArn` is provided (the handler is
 *   then granted `kms:Decrypt`/`Encrypt` on that specific key ARN).
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
	 * @example
	 * const dbUrl = AppSetting.fromExisting(scope, 'db-url', { name: dbParameterName, secret: true });
	 */
	static fromExisting<T = string>(
		scope: ScopeParent,
		id: string,
		options: { name: string; secret?: boolean },
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

		if (options.kmsKeyArn && !options.secret) {
			const err = new Error(
				`AppSetting '${id}': 'kmsKeyArn' is only valid with 'secret: true'. ` +
				`Non-secret String parameters are not encrypted.`
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

		if (external && !options.name) {
			const err = new Error(
				`AppSetting '${id}': 'external' requires an explicit 'name' referencing the existing parameter.`
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
				registerSecret(cdk.Stack.of(this), parameterName, options.kmsKeyArn);
			}

			// Grant the handler KMS access. External secrets are read-only (Decrypt
			// only); stack-managed secrets also need Encrypt/GenerateDataKey* so the
			// app can write the value via put().
			if (options.kmsKeyArn) {
				// Customer-managed key: grant on the specific key ARN. NOTE: the key's
				// own key policy must also allow this role (we can't edit a BYO key's
				// policy from here) — see the README.
				this.executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
					actions: external
						? ['kms:Decrypt']
						: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey*'],
					resources: [options.kmsKeyArn],
				}));
			} else {
				// Default aws/ssm key: scope the wildcard with a ViaService condition.
				this.executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
					actions: external ? ['kms:Decrypt'] : ['kms:Decrypt', 'kms:Encrypt'],
					resources: ['*'],
					conditions: {
						StringEquals: {
							'kms:ViaService': `ssm.${cdk.Stack.of(this).region}.amazonaws.com`,
						},
					},
				}));
			}
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
		this.executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
			actions: external ? ['ssm:GetParameter'] : ['ssm:GetParameter', 'ssm:PutParameter'],
			resources: [parameterArn],
		}));

		// Pass the parameter name to the runtime via config registry
		const envKey = `BLOCKS_SSM_PARAM_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
		registerConfig(this, envKey, parameterName);
	}
}

// ── Bulk Secret Initialization (one CustomResource per stack) ───────────────

const SECRET_BULK_KEY = Symbol.for('BLOCKS_SECRET_BULK_INIT');

interface SecretParam {
	name: string;
	/** Customer-managed KMS key ARN, or undefined for the default aws/ssm key. */
	keyId?: string;
}

interface SecretBulkState {
	params: SecretParam[];
}

/**
 * Register a secret parameter (and its optional customer-managed KMS key). On
 * first call, creates the shared Lambda, Provider, and a single CustomResource.
 * All subsequent calls just append to the parameter list (resolved lazily at
 * synth time).
 */
function registerSecret(stack: cdk.Stack, parameterName: string, keyId?: string): void {
	let state = (stack as any)[SECRET_BULK_KEY] as SecretBulkState | undefined;
	if (state) {
		state.params.push({ name: parameterName, keyId });
		return;
	}

	// First secret in this stack — create all shared infrastructure
	state = { params: [{ name: parameterName, keyId }] };
	(stack as any)[SECRET_BULK_KEY] = state;

	const secretInitFn = new lambda.Function(stack, 'BlocksSecretInitFn', {
		runtime: DEFAULT_NODE_RUNTIME,
		handler: 'index.handler',
		code: lambda.Code.fromInline(`
			const { SSMClient, PutParameterCommand, DeleteParameterCommand, AddTagsToResourceCommand } = require('@aws-sdk/client-ssm');
			const crypto = require('crypto');
			const client = new SSMClient({});
			async function putSecret(p, tags) {
				const secret = crypto.randomBytes(32).toString('base64url');
				const input = { Name: p.name, Value: secret, Type: 'SecureString', Overwrite: false, Tags: tags };
				// A CMK ARN pins the SecureString to a customer-managed key; omit for the default aws/ssm key.
				if (p.keyId) input.KeyId = p.keyId;
				try {
					await client.send(new PutParameterCommand(input));
				} catch (e) {
					if (e.name !== 'ParameterAlreadyExists') throw e;
					if (tags.length) {
						await client.send(new AddTagsToResourceCommand({ ResourceType: 'Parameter', ResourceId: p.name, Tags: tags }));
					}
				}
			}
			exports.handler = async (event) => {
				const params = event.ResourceProperties.Parameters || [];
				const stackName = event.ResourceProperties.StackName || '';
				const tags = stackName ? [{ Key: 'aws-blocks-stack', Value: stackName }] : [];
				const oldParams = (event.OldResourceProperties || {}).Parameters || [];
				const names = params.map(p => p.name);
				const oldNames = oldParams.map(p => p.name);
				if (event.RequestType === 'Delete') {
					for (const name of names) {
						try { await client.send(new DeleteParameterCommand({ Name: name })); } catch {}
					}
					return { PhysicalResourceId: 'bb-secrets-bulk' };
				}
				if (event.RequestType === 'Create') {
					for (const p of params) await putSecret(p, tags);
					return { PhysicalResourceId: 'bb-secrets-bulk' };
				}
				if (event.RequestType === 'Update') {
					for (const p of params) { if (!oldNames.includes(p.name)) await putSecret(p, tags); }
					for (const name of oldNames) {
						if (!names.includes(name)) { try { await client.send(new DeleteParameterCommand({ Name: name })); } catch {} }
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
			produce: () => state!.params.map(p =>
				stack.formatArn({
					service: 'ssm',
					resource: 'parameter',
					resourceName: p.name.replace(/^\//, ''),
				})
			),
		}),
	}));

	// SSM SecureString encryption goes through KMS via the SSM service. Scoping to
	// `kms:ViaService = ssm.<region>` covers both the default aws/ssm key and any
	// customer-managed key used above (the CMK's own key policy must also allow
	// this role). `GenerateDataKey*` is required when a CMK is in play.
	secretInitFn.addToRolePolicy(new iam.PolicyStatement({
		actions: ['kms:Encrypt', 'kms:GenerateDataKey*'],
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
			Parameters: cdk.Lazy.any({ produce: () => state!.params }),
			StackName: (() => { let s = stack; while (s.nestedStackParent) s = s.nestedStackParent; return s.stackName; })(),
		},
	});
}
