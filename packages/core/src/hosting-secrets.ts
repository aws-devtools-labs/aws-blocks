// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolution glue between the dependency-free `secret()` marker (defined in
 * `@aws-blocks/hosting`) and the `Hosting` CDK block. The marker is inert; this
 * module is where it actually gets wired into infrastructure.
 *
 * Two resolution strategies, chosen by where the marker appears:
 *
 *   • `compute.environment` (runtime, the secure default) — we inject the SSM
 *     parameter NAME (never the value) as `BLOCKS_SECRET_PARAM_<KEY>` and grant
 *     the compute role `ssm:GetParameter` + `kms:Decrypt`. The value is fetched
 *     and decrypted on first use at runtime via `getSecret()`. The secret stays
 *     encrypted at rest; it never enters the CloudFormation template.
 *
 *   • `domain.domainName` and `exposeAsEnv` env vars (synth time) — resolved by
 *     an SDK `GetParameter(WithDecryption)` call DURING `cdk synth` and inlined
 *     as a literal. A SecureString dynamic reference (`{{resolve:ssm-secure}}`)
 *     can't be used in CloudFront Aliases (CloudFormation restricts ssm-secure
 *     to an allowlist of properties), so synth-time SDK resolution is the
 *     correct mechanism. A domain is public the moment the site is live, so
 *     inlining the literal loses no confidentiality.
 *
 * Synth-time resolution is async, which is why callers that use domain secrets
 * or `exposeAsEnv` must construct via the async `Hosting.create()`.
 *
 * @module
 */

import { isSecret, type SecretValue, secretEnvVarName } from '@aws-blocks/hosting';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { blocksSecretParameterName } from './secret-naming.js';

/** A `compute.environment` value: a literal, or a deferred secret reference. */
export type EnvValue = string | SecretValue;

/** A custom-domain name: a literal, a secret, or a mix in an array. */
export type DomainNameInput = string | SecretValue | Array<string | SecretValue>;

/**
 * Split an environment map into the three handling buckets.
 * - `plain` — literal strings, injected verbatim (today's behavior).
 * - `runtimeSecrets` — `secret('K')`, resolved lazily at runtime.
 * - `exposeSecrets` — `secret('K', { exposeAsEnv: true })`, resolved at synth.
 */
export function partitionEnvironment(environment: Record<string, EnvValue> | undefined): {
	plain: Record<string, string>;
	runtimeSecrets: SecretValue[];
	exposeSecrets: SecretValue[];
} {
	const plain: Record<string, string> = {};
	const runtimeSecrets: SecretValue[] = [];
	const exposeSecrets: SecretValue[] = [];

	for (const [key, value] of Object.entries(environment ?? {})) {
		if (isSecret(value)) {
			// The env-var key the customer wrote IS the secret's logical key.
			// (Reject a mismatch so `STRIPE_KEY: secret('OTHER')` can't silently
			// resolve to the wrong parameter at runtime.)
			if (value.key !== key) {
				throw new Error(
					`Hosting environment '${key}': secret key '${value.key}' must match ` +
						`the environment variable name. Use ${key}: secret('${key}').`,
				);
			}
			(value.exposeAsEnv ? exposeSecrets : runtimeSecrets).push(value);
		} else {
			plain[key] = value;
		}
	}
	return { plain, runtimeSecrets, exposeSecrets };
}

/** Every secret key that requires a synth-time SDK fetch (domain + exposeAsEnv). */
export function collectSynthSecretKeys(
	domainName: DomainNameInput | undefined,
	exposeSecrets: SecretValue[],
): string[] {
	const keys = new Set<string>();
	for (const name of toDomainArray(domainName)) {
		if (isSecret(name)) keys.add(name.key);
	}
	for (const s of exposeSecrets) keys.add(s.key);
	return [...keys];
}

/** Normalize the domain input into an array (without resolving markers). */
function toDomainArray(domainName: DomainNameInput | undefined): Array<string | SecretValue> {
	if (domainName === undefined) return [];
	return Array.isArray(domainName) ? domainName : [domainName];
}

/**
 * Resolve a set of secret keys to plaintext via the SSM SDK at synth time.
 * Each parameter is fetched with decryption. Throws a clear, actionable error
 * if a referenced secret was never set with `blocks secret set`.
 */
export async function resolveSecretsAtSynth(
	keys: string[],
	fetcher: SsmGetParameter = defaultSsmGetParameter,
): Promise<Map<string, string>> {
	const resolved = new Map<string, string>();
	await Promise.all(
		keys.map(async (key) => {
			const name = blocksSecretParameterName(key);
			try {
				resolved.set(key, await fetcher(name));
			} catch (error: unknown) {
				const e = error as { name?: string };
				if (e?.name === 'ParameterNotFound') {
					throw new Error(
						`Hosting: secret '${key}' is referenced (domain or exposeAsEnv) but ` +
							`not set. Set it before deploying:\n  blocks secret set ${key} <value>`,
					);
				}
				throw error;
			}
		}),
	);
	return resolved;
}

/** Resolve domain markers to literals using the synth-resolved secret map. */
export function resolveDomainNames(domainName: DomainNameInput, resolved: Map<string, string>): string | string[] {
	const arr = toDomainArray(domainName).map((name) => {
		if (!isSecret(name)) return name;
		const value = resolved.get(name.key);
		if (value === undefined) {
			// Marker present but not resolved → caller used `new Hosting()` instead
			// of the async `Hosting.create()`.
			throw new Error(
				`Hosting: domain secret('${name.key}') requires async resolution. ` +
					`Construct with: await Hosting.create(scope, id, props).`,
			);
		}
		return value;
	});
	return Array.isArray(domainName) ? arr : arr[0];
}

/**
 * Inject the SSM parameter NAME (not the value) for a runtime secret and grant
 * the compute role read+decrypt access scoped to that one parameter.
 */
export function wireRuntimeSecret(fn: cdk.aws_lambda.Function, key: string): void {
	const parameterName = blocksSecretParameterName(key);
	fn.addEnvironment(secretEnvVarName(key), parameterName);

	const parameterArn = cdk.Stack.of(fn).formatArn({
		service: 'ssm',
		resource: 'parameter',
		// SSM ARNs omit the leading slash of the parameter name.
		resourceName: parameterName.replace(/^\//, ''),
	});

	fn.addToRolePolicy(
		new iam.PolicyStatement({
			actions: ['ssm:GetParameter'],
			resources: [parameterArn],
		}),
	);
	// SecureStrings are encrypted with the default `aws/ssm` KMS key. Grant
	// Decrypt scoped via `kms:ViaService` so the role can only use the key
	// through SSM — the same scoping the AppSetting block uses.
	fn.addToRolePolicy(
		new iam.PolicyStatement({
			actions: ['kms:Decrypt'],
			resources: ['*'],
			conditions: {
				StringEquals: {
					'kms:ViaService': `ssm.${cdk.Stack.of(fn).region}.amazonaws.com`,
				},
			},
		}),
	);
}

// ── SDK seam (overridable for tests) ────────────────────────────────────────

export type SsmGetParameter = (parameterName: string) => Promise<string>;

async function defaultSsmGetParameter(parameterName: string): Promise<string> {
	const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
	const client = new SSMClient({});
	const result = await client.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
	const value = result.Parameter?.Value;
	if (value === undefined || value === null) {
		throw new Error(`Secret parameter "${parameterName}" has no value.`);
	}
	return value;
}
