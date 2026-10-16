// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { BuildingBlockScope, registerConfig, synthGuard } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import { RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { ExternalSecretRef, SecretOptions } from './types.js';

// Re-export public types and errors (no runtime dependencies)
export { SecretErrors } from './errors.js';
export type { ExternalSecretRef, SecretOptions, SecretReadOptions, SecretVersion, SecretVersionInfo } from './types.js';

/**
 * CDK construct for a single application secret backed by AWS Secrets Manager.
 *
 * Creates one `secretsmanager.Secret` (encrypted with the default
 * `aws/secretsmanager` KMS key), grants the shared execution role read/write
 * access to it, and registers the secret ARN for the runtime via
 * `registerConfig()`. When wrapping an existing secret via
 * {@link Secret.fromExisting}, no new resource is created — the construct imports
 * the secret by ARN and grants access to it.
 *
 * The removal policy follows the stack-wide `defaults` (production retains,
 * sandbox destroys) unless overridden per-instance with `options.removalPolicy`.
 */
export class Secret extends BuildingBlockScope {
	/** The ARN of the underlying Secrets Manager secret. */
	public readonly secretArn: string;
	private readonly secret: secretsmanager.ISecret;

	/**
	 * Reference an AWS Secrets Manager secret created and owned **outside** this
	 * stack. The construct does not create, seed, or delete it — it only grants
	 * the app access and registers the name for config resolution. Mirrors the
	 * same factory on the runtime build so the same app code works in both
	 * contexts.
	 *
	 * @param secretArn - The ARN of the existing Secrets Manager secret.
	 */
	static fromExisting(secretArn: string): ExternalSecretRef {
		return { __brand: 'ExternalSecretRef' as const, secretArn };
	}

	constructor(scope: ScopeParent, id: string, options?: SecretOptions<unknown>) {
		super(id, { parent: scope, vpc: { interfaceEndpoints: [ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER] } });

		if (options?.secret) {
			// `fromExisting`: bind to the pre-existing secret by ARN; do not
			// provision, seed, delete, OR tag it — it is owned outside this stack
			// (often shared across many deployments), so stamping it with this
			// stack's resource-group tag would be mutating a resource we don't own.
			this.secret = secretsmanager.Secret.fromSecretCompleteArn(this, 'secret', options.secret.secretArn);
		} else {
			const removalPolicy =
				options?.removalPolicy === 'destroy'
					? RemovalPolicy.DESTROY
					: options?.removalPolicy === 'retain'
						? RemovalPolicy.RETAIN
						: this.defaults.removalPolicy;

			const l2 = new secretsmanager.Secret(this, 'secret', {
				// Use the caller's explicit, well-known name when provided (so a
				// team/CI pipeline can target it with `aws secretsmanager …`); else
				// derive a unique name from the scope tree.
				secretName: (options?.name ?? this.fullId).substring(0, 255),
				removalPolicy,
			});

			// Default: an EMPTY secret, so an unset secret reads back as `null`
			// (`GetSecretValue` returns no `SecretString`), matching the mock and the
			// "configure after deploy" contract. The L2 construct otherwise emits
			// `GenerateSecretString: {}`, which seeds a random 32-char value — so a
			// never-set `get()` would return that string instead of `null`. Opt into
			// that generator only when `generate: true` (signing/HMAC keys that just
			// need to exist). CloudFormation treats a secret with neither
			// `GenerateSecretString` nor `SecretString` as empty.
			if (options?.generate !== true) {
				const cfn = l2.node.defaultChild as secretsmanager.CfnSecret;
				cfn.addPropertyDeletionOverride('GenerateSecretString');
			}
			this.secret = l2;

			// Tag the BB-created secret so it joins the stack's `-settings` resource
			// group alongside AppSetting parameters (the group matches
			// `aws-blocks-stack=<stackName>`). Walk to the non-nested parent stack,
			// mirroring AppSetting. Only stack-managed secrets are tagged —
			// `fromExisting` secrets are intentionally excluded above.
			let tagStack = cdk.Stack.of(this);
			while (tagStack.nestedStackParent) tagStack = tagStack.nestedStackParent;
			cdk.Tags.of(this.secret).add('aws-blocks-stack', tagStack.stackName);
		}

		// Grant the shared execution role read on this specific secret (not a
		// wildcard): secretsmanager:GetSecretValue + ListSecretVersionIds (the
		// latter for listVersions(), which grantRead does NOT include).
		this.secret.grantRead(this.executionRole);
		this.executionRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: ['secretsmanager:ListSecretVersionIds'],
				resources: [this.secret.secretArn],
			}),
		);
		// Writes are opt-in and least-privilege: grant PutSecretValue (plus the KMS
		// grants Secrets Manager attaches) ONLY when the app will write at runtime.
		// By default the role has read-only access, matching the runtime object,
		// which has no `put()` unless `allowRuntimeWrite: true`.
		if (options?.allowRuntimeWrite === true) {
			this.secret.grantWrite(this.executionRole);
		}

		this.secretArn = this.secret.secretArn;

		// Pass the ARN to the runtime via the config registry (never
		// handler.addEnvironment — the 4 KB Lambda env cap is managed centrally).
		// Key on the scoped `fullId`, not the bare construct `id`: two secrets with
		// the same `id` in different scopes (e.g. per-tenant) would otherwise
		// normalize to one config key and the last registration would silently win,
		// so both instances would read/write a single secret. `fullId` is unique
		// within the stack, and the runtime derives the identical key from its own
		// `fullId`.
		registerConfig(this, configKey(this.fullId), this.secret.secretArn);
	}

	// ── Runtime methods are not available during CDK synth ────────────────
	// Under `--conditions=cdk` a Secret resolves to this construct, which only
	// provisions infrastructure. The data methods (get/put) live in the runtime
	// build; calling them during synth throws an actionable message instead of a
	// cryptic "X is not a function".
	get(..._args: unknown[]): never {
		return synthGuard('Secret', 'get');
	}
	put(..._args: unknown[]): never {
		return synthGuard('Secret', 'put');
	}
	listVersions(..._args: unknown[]): never {
		return synthGuard('Secret', 'listVersions');
	}
}

/**
 * The config key used to pass a Secret's ARN to the runtime. Derived from the
 * scoped `fullId` (same derivation as the runtime layer, so the two agree
 * without handing a value between them) — unique within the stack, so same-`id`
 * secrets in different scopes get distinct keys. The `BLOCKS_` prefix is
 * framework-reserved.
 */
function configKey(fullId: string): string {
	return `BLOCKS_SECRET_ARN_${fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}
