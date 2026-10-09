// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deploy-time custom-resource handler that registers one Cognito identity
 * provider (Google, Facebook, Login with Amazon, Sign in with Apple, or a
 * Cognito-federated OIDC IdP) on the `Auth` user pool.
 *
 * Runs during `cdk deploy`, never at request time. It reads and decrypts each
 * secret `ProviderDetails` value (`client_secret`, Apple's `private_key`) from
 * its SSM SecureString **by name** and calls `CreateIdentityProvider` /
 * `UpdateIdentityProvider` / `DeleteIdentityProvider`, so the secret reaches
 * Cognito without ever appearing in the CloudFormation template —
 * CloudFormation accepts no `ssm-secure` dynamic reference on
 * `AWS::Cognito::UserPoolIdentityProvider.ProviderDetails`, and none at all in
 * custom-resource properties.
 *
 * Ported from `bb-auth-oidc`'s deployed handler, generalized from a fixed
 * client-id/secret pair to any set of secret details, and hardened so that a
 * provider-type change (the old resource's Delete arriving after the new one's
 * Create, under the same provider name) cannot delete the new provider.
 *
 * Bundled to `dist/idp-registration-lambda/index.js` by `npm run build:lambda`
 * (esbuild); `@aws-sdk/*` is provided by the Node.js Lambda runtime and is
 * marked external.
 */

import {
	CognitoIdentityProviderClient,
	CreateIdentityProviderCommand,
	DeleteIdentityProviderCommand,
	DescribeIdentityProviderCommand,
	type IdentityProviderTypeType,
	UpdateIdentityProviderCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/** Minimal client shapes, so the handler can be tested with fakes. */
export interface SsmLike {
	send(command: GetParameterCommand): Promise<{ Parameter?: { Value?: string } }>;
}
export interface IdpLike {
	send(
		command:
			| CreateIdentityProviderCommand
			| UpdateIdentityProviderCommand
			| DeleteIdentityProviderCommand
			| DescribeIdentityProviderCommand,
	): Promise<{ IdentityProvider?: { ProviderType?: string } }>;
}

/** The resource properties `federation.ts` sets on each `idp-<id>` custom resource. */
export interface RegistrationProperties {
	UserPoolId: string;
	ProviderName: string;
	ProviderType: string;
	/** Non-secret `ProviderDetails`. */
	ProviderDetails?: Record<string, string>;
	/** `ProviderDetails` key → SSM SecureString parameter name. */
	SecretDetails?: Record<string, string>;
	AttributeMapping?: Record<string, string>;
}

export interface CfnEvent {
	RequestType: 'Create' | 'Update' | 'Delete';
	PhysicalResourceId?: string;
	ResourceProperties: RegistrationProperties;
}

/** Retry knobs — overridable so tests don't wait real seconds. */
export interface HandlerOptions {
	retries?: number;
	retryDelayMs?: number;
}

const DEFAULT_RETRIES = 6;
const DEFAULT_RETRY_DELAY_MS = 2000;

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

const PROVIDER_TYPES = ['Google', 'Facebook', 'LoginWithAmazon', 'SignInWithApple', 'OIDC', 'SAML'] as const;

/** Narrow a resource property to a Cognito provider type, rejecting anything else. */
function providerTypeOf(value: string): IdentityProviderTypeType {
	const found = PROVIDER_TYPES.find((t) => t === value);
	if (!found) throw new Error(`Auth: unsupported identity provider type "${value}".`);
	return found;
}

const errorName = (e: unknown): string | undefined =>
	typeof e === 'object' && e !== null && 'name' in e && typeof e.name === 'string' ? e.name : undefined;

/** `<pool>|<name>|<type>` — the type is part of the identity, so a type change is a replacement. */
function physicalIdOf(p: RegistrationProperties): string {
	return `${p.UserPoolId}|${p.ProviderName}|${p.ProviderType}`;
}

function parsePhysicalId(id: string | undefined): { pool: string; name: string; type: string } | undefined {
	const parts = id?.split('|');
	return parts?.length === 3 ? { pool: parts[0], name: parts[1], type: parts[2] } : undefined;
}

/**
 * Build a handler bound to the given clients. Production uses the real SDK
 * clients; tests inject fakes.
 */
export function createHandler(ssm: SsmLike, idp: IdpLike, options: HandlerOptions = {}) {
	const retries = options.retries ?? DEFAULT_RETRIES;
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

	// Read + decrypt a SecureString by name. Retries a not-yet-present parameter
	// (the bulk secret seeding may land slightly later) and transient errors; a
	// terminal not-found surfaces an actionable message naming the parameter.
	async function readSecret(name: string, providerName: string): Promise<string> {
		let lastErr: unknown;
		for (let attempt = 0; attempt < retries; attempt++) {
			try {
				const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
				return r.Parameter?.Value ?? '';
			} catch (e) {
				lastErr = e;
				if (attempt < retries - 1) await sleep(retryDelayMs);
			}
		}
		if (errorName(lastErr) === 'ParameterNotFound') {
			throw new Error(
				`Auth: secret parameter "${name}" for identity provider "${providerName}" was not found. ` +
					`Set it before deploying (e.g. \`aws ssm put-parameter --name ${name} --type SecureString --value <secret> --overwrite\`).`,
			);
		}
		throw lastErr;
	}

	async function resolveDetails(p: RegistrationProperties): Promise<Record<string, string>> {
		const details: Record<string, string> = { ...(p.ProviderDetails ?? {}) };
		for (const [key, parameter] of Object.entries(p.SecretDetails ?? {})) {
			const value = await readSecret(parameter, p.ProviderName);
			if (!value) {
				throw new Error(
					`Auth: secret parameter "${parameter}" (${key}) for identity provider "${p.ProviderName}" is empty. Set its value before deploying.`,
				);
			}
			details[key] = value;
		}
		return details;
	}

	/** The type of the provider currently registered under `name`, or `undefined` when there is none. */
	async function existingType(pool: string, name: string): Promise<string | undefined> {
		try {
			const r = await idp.send(new DescribeIdentityProviderCommand({ UserPoolId: pool, ProviderName: name }));
			return r.IdentityProvider?.ProviderType ?? '';
		} catch (e) {
			if (errorName(e) === 'ResourceNotFoundException') return undefined;
			throw e;
		}
	}

	async function upsert(p: RegistrationProperties): Promise<void> {
		const details = await resolveDetails(p);
		const attributeMapping = p.AttributeMapping ?? {};
		const current = await existingType(p.UserPoolId, p.ProviderName);
		if (current === undefined) {
			await idp.send(
				new CreateIdentityProviderCommand({
					UserPoolId: p.UserPoolId,
					ProviderName: p.ProviderName,
					ProviderType: providerTypeOf(p.ProviderType),
					ProviderDetails: details,
					AttributeMapping: attributeMapping,
				}),
			);
			return;
		}
		if (current !== p.ProviderType) {
			throw new Error(
				`Auth: identity provider "${p.ProviderName}" already exists on the pool with type ${current}, not ${p.ProviderType}. ` +
					'Cognito cannot change a provider type in place: remove the provider in one deploy and add it back with its new type in the next.',
			);
		}
		await idp.send(
			new UpdateIdentityProviderCommand({
				UserPoolId: p.UserPoolId,
				ProviderName: p.ProviderName,
				ProviderDetails: details,
				AttributeMapping: attributeMapping,
			}),
		);
	}

	return async function handler(event: CfnEvent): Promise<{ PhysicalResourceId: string }> {
		const p = event.ResourceProperties;
		if (event.RequestType === 'Delete') {
			const target = parsePhysicalId(event.PhysicalResourceId) ?? {
				pool: p.UserPoolId,
				name: p.ProviderName,
				type: p.ProviderType,
			};
			// Delete only the provider this resource created: after a type change the
			// name may already belong to the replacement resource.
			const current = await existingType(target.pool, target.name);
			if (current !== undefined && current === target.type) {
				try {
					await idp.send(
						new DeleteIdentityProviderCommand({ UserPoolId: target.pool, ProviderName: target.name }),
					);
				} catch (e) {
					if (errorName(e) !== 'ResourceNotFoundException') throw e;
				}
			}
			return { PhysicalResourceId: event.PhysicalResourceId ?? physicalIdOf(p) };
		}
		await upsert(p);
		return { PhysicalResourceId: physicalIdOf(p) };
	};
}

/** Production entry point wired to the real SDK clients. */
export const handler = createHandler(new SSMClient({}), new CognitoIdentityProviderClient({}));
