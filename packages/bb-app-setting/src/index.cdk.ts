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
import { isCopyFromSource } from './types.js';
import type { AppSettingOptions, InternalAppSettingOptions, CopyFromSource } from './types.js';

export { AppSettingErrors } from './errors.js';
export { copyFrom } from './types.js';
export type { AppSettingOptions, CopyFromSource } from './types.js';

/**
 * CDK construct for AppSetting. Creates a single SSM parameter (String or
 * SecureString) and grants the shared Lambda handler read/write permissions.
 *
 * - String parameters use `aws-cdk-lib/aws-ssm.StringParameter` directly.
 * - SecureString parameters use a Custom Resource Lambda because
 *   CloudFormation cannot natively create SecureString parameters.
 * - SecureString parameters are encrypted with the default `aws/ssm` KMS key.
 * - When `value` is a {@link copyFrom} source, a Custom Resource copies the value
 *   from a staging parameter into this (stack-owned) parameter during deploy, so
 *   the value is seeded atomically with the stack and never enters the template.
 */
export class AppSetting<T = string> extends Scope {
	/**
	 * Reference an SSM parameter that is created and owned **outside this stack**
	 * (e.g. a connection string seeded by your own tooling out-of-band). The
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
	 * so an out-of-band writer can discover and seed it. Pass `name` only when
	 * referencing a parameter whose name is fixed by something outside this stack.
	 *
	 * To have the framework seed the value *during* deploy (atomically, inside the
	 * CloudFormation transaction) instead of out-of-band, use {@link copyFrom} on
	 * a regular `new AppSetting(...)` rather than `fromExisting`.
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

		// A copyFrom() source seeds the value at deploy time from a staging
		// parameter (see registerCopyFrom). It is the only `value` form allowed
		// for a secret, because it never places the value in the template.
		const copyFromSource: CopyFromSource | undefined = isCopyFromSource(options.value)
			? (options.value as CopyFromSource)
			: undefined;

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

		if (options.secret && options.value !== undefined && !copyFromSource) {
			const err = new Error(
				`AppSetting '${id}': secrets should not have a literal value in source code. ` +
				`Remove the value — a random secret will be generated on first deploy, or use ` +
				`copyFrom(stagingRef) to seed it at deploy time. ` +
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

		// `external` settings and copyFrom-seeded settings are read-only from the
		// app's perspective: the value is owned/seeded out-of-band (external) or
		// by the in-stack copy custom resource (copyFrom). The app never put()s it.
		const readOnly = external || copyFromSource !== undefined;

		// Always JSON.stringify a literal value. Secrets without a value get a
		// random placeholder from the Custom Resource; copyFrom values are seeded
		// by the copy Custom Resource, so neither produces an initialValue here.
		const initialValue = (options.value !== undefined && !copyFromSource)
			? JSON.stringify(options.value)
			: undefined;

		const parameterArn = cdk.Stack.of(this).formatArn({
			service: 'ssm',
			resource: 'parameter',
			resourceName: parameterName.replace(/^\//, ''),
		});

		if (options.secret) {
			// ── SecureString ────────────────────────────────────────────────
			// Externally-owned secrets (e.g. a connection string seeded out-of-band)
			// are NOT enrolled in the bulk-init: it would PutParameter a random
			// placeholder over a parameter we don't own and then fail tagging it.
			// copyFrom secrets ARE created by us — but via the copy custom resource
			// (which seeds the real value), not the random bulk-init.
			if (copyFromSource) {
				registerCopyFrom(cdk.Stack.of(this), parameterName, copyFromSource.stagingParameterName, true);
			} else if (!external) {
				registerSecret(cdk.Stack.of(this), parameterName);
			}

			// Grant handler KMS access for the default aws/ssm key. Read-only
			// settings (external or copyFrom-seeded) only need Decrypt; a
			// stack-managed secret the app can write via put() also needs Encrypt.
			this.handler.addToRolePolicy(new iam.PolicyStatement({
				actions: readOnly ? ['kms:Decrypt'] : ['kms:Decrypt', 'kms:Encrypt'],
				resources: ['*'],
				conditions: {
					StringEquals: {
						'kms:ViaService': `ssm.${cdk.Stack.of(this).region}.amazonaws.com`,
					},
				},
			}));
		} else if (copyFromSource) {
			// ── Non-secret String, seeded by the copy custom resource ────────
			registerCopyFrom(cdk.Stack.of(this), parameterName, copyFromSource.stagingParameterName, false);
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

		// Grant handler SSM access on this parameter. Read-only settings (external
		// or copyFrom-seeded) only read; stack-managed settings also write via put().
		this.handler.addToRolePolicy(new iam.PolicyStatement({
			actions: readOnly ? ['ssm:GetParameter'] : ['ssm:GetParameter', 'ssm:PutParameter'],
			resources: [parameterArn],
		}));

		// Pass the parameter name to the runtime via config registry
		const envKey = `BLOCKS_SSM_PARAM_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
		registerConfig(this, envKey, parameterName);

		// External secrets are seeded out-of-band (by your own tooling) after the
		// parameter name is known. Expose the resolved, synth-time name as a
		// CfnOutput so that out-of-band writer can read it back from the stack
		// outputs and write to the exact same name. (For framework-seeded values
		// during deploy, prefer copyFrom — which needs no output.)
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

// ── copyFrom: staging → final copy (one CustomResource per stack) ───────────

const COPY_FROM_BULK_KEY = Symbol.for('BLOCKS_COPYFROM_BULK');

interface CopyFromEntry {
	/** Final, stack-scoped parameter name this stack owns. */
	finalName: string;
	/** Staging parameter to read the value from (minted by the orchestrator). */
	stagingName: string;
	/** Whether the final parameter is a SecureString. */
	secret: boolean;
}

interface CopyFromBulkState {
	entries: CopyFromEntry[];
}

/**
 * Register a copyFrom-seeded parameter. On first call, creates the shared Lambda,
 * Provider, and a single CustomResource that — during deployment — reads each
 * staging parameter and writes its value into the final, stack-owned parameter,
 * then deletes the staging parameter. Subsequent calls append to the list
 * (resolved lazily at synth).
 *
 * Properties hold only parameter **names** (references), never the secret value,
 * so nothing sensitive enters the CloudFormation template (readable via
 * `GetTemplate`). The custom resource reads the value from SSM at deploy time.
 *
 * Semantics: **copy-on-every-deploy**. The orchestrator mints a fresh staging
 * name per deploy, so the resource's properties change each deploy and
 * CloudFormation fires an Update → the value is re-synced from the source. The
 * Update handler is idempotent: if the staging parameter is already gone (e.g. a
 * sandbox `cdk watch` re-synth after a previous delete-after-copy) and the final
 * parameter already holds a value, it is a no-op. The final parameter is
 * stack-owned, so `cdk destroy` cleans it up via the Delete handler.
 */
function registerCopyFrom(stack: cdk.Stack, finalName: string, stagingName: string, secret: boolean): void {
	let state = (stack as any)[COPY_FROM_BULK_KEY] as CopyFromBulkState | undefined;
	if (state) {
		state.entries.push({ finalName, stagingName, secret });
		return;
	}

	state = { entries: [{ finalName, stagingName, secret }] };
	(stack as any)[COPY_FROM_BULK_KEY] = state;

	const copyFn = new lambda.Function(stack, 'BlocksCopyFromFn', {
		runtime: DEFAULT_NODE_RUNTIME,
		handler: 'index.handler',
		code: lambda.Code.fromInline(`
			const { SSMClient, GetParameterCommand, PutParameterCommand, DeleteParameterCommand, AddTagsToResourceCommand } = require('@aws-sdk/client-ssm');
			const client = new SSMClient({});
			async function exists(name) {
				try { await client.send(new GetParameterCommand({ Name: name })); return true; }
				catch (e) { if (e.name === 'ParameterNotFound') return false; throw e; }
			}
			exports.handler = async (event) => {
				const entries = event.ResourceProperties.Entries || [];
				const stackName = event.ResourceProperties.StackName || '';
				const tags = stackName ? [{ Key: 'aws-blocks-stack', Value: stackName }] : [];
				if (event.RequestType === 'Delete') {
					// Final parameter is stack-owned → delete it. Best-effort delete
					// any staging param that outlived the copy.
					for (const e of entries) {
						try { await client.send(new DeleteParameterCommand({ Name: e.finalName })); } catch {}
						try { await client.send(new DeleteParameterCommand({ Name: e.stagingName })); } catch {}
					}
					return { PhysicalResourceId: 'bb-copyfrom-bulk' };
				}
				// Create or Update: copy staging → final, then delete staging.
				for (const e of entries) {
					let value;
					try {
						const got = await client.send(new GetParameterCommand({ Name: e.stagingName, WithDecryption: true }));
						value = got.Parameter && got.Parameter.Value;
					} catch (err) {
						if (err.name === 'ParameterNotFound') {
							// Staging already consumed (delete-after-copy on a prior cycle).
							// No-op if the final value is already seeded; otherwise it's a real error.
							if (await exists(e.finalName)) continue;
							throw new Error('copyFrom: staging parameter ' + e.stagingName + ' not found and final ' + e.finalName + ' does not exist');
						}
						throw err;
					}
					if (value === undefined || value === null) {
						throw new Error('copyFrom: staging parameter ' + e.stagingName + ' has no value');
					}
					// CloudFormation stringifies custom-resource property scalars, so
					// e.secret arrives as "true"/"false" — coerce explicitly.
					const isSecret = e.secret === true || e.secret === 'true';
					await client.send(new PutParameterCommand({
						Name: e.finalName, Value: value, Type: isSecret ? 'SecureString' : 'String', Overwrite: true,
					}));
					if (tags.length) {
						try { await client.send(new AddTagsToResourceCommand({ ResourceType: 'Parameter', ResourceId: e.finalName, Tags: tags })); } catch {}
					}
					try { await client.send(new DeleteParameterCommand({ Name: e.stagingName })); } catch {}
				}
				return { PhysicalResourceId: 'bb-copyfrom-bulk' };
			};
		`),
	});

	// Scope IAM to the specific staging + final parameter ARNs (no wildcard).
	const arnFor = (name: string) => stack.formatArn({
		service: 'ssm', resource: 'parameter', resourceName: name.replace(/^\//, ''),
	});
	copyFn.addToRolePolicy(new iam.PolicyStatement({
		actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:AddTagsToResource'],
		resources: cdk.Lazy.list({
			produce: () => state!.entries.flatMap(e => [arnFor(e.finalName), arnFor(e.stagingName)]),
		}),
	}));
	// Decrypt to read the staging SecureString; Encrypt to write the final one.
	copyFn.addToRolePolicy(new iam.PolicyStatement({
		actions: ['kms:Decrypt', 'kms:Encrypt'],
		resources: ['*'],
		conditions: { StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` } },
	}));

	const provider = new cr.Provider(stack, 'BlocksCopyFromProvider', {
		onEventHandler: copyFn,
	});

	new cdk.CustomResource(stack, 'BlocksCopyFromBulk', {
		serviceToken: provider.serviceToken,
		properties: {
			Entries: cdk.Lazy.any({ produce: () => state!.entries }),
			StackName: (() => { let s = stack; while (s.nestedStackParent) s = s.nestedStackParent; return s.stackName; })(),
		},
	});
}
