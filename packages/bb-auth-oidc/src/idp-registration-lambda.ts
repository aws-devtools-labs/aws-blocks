// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deploy-time custom-resource handler for Cognito federated IdP registration.
 *
 * Runs during `cdk deploy` (never at runtime). It reads and decrypts the IdP
 * credential SecureString parameters *by name* via the SDK and calls Cognito's
 * `CreateIdentityProvider` / `UpdateIdentityProvider` / `DeleteIdentityProvider`,
 * so the credential values reach Cognito without ever appearing in the
 * CloudFormation template. Bundled to `dist/idp-registration-lambda/` by the
 * `build:lambda` esbuild step and referenced with `Code.fromAsset`.
 *
 * `@aws-sdk/*` is provided by the Node.js Lambda runtime and marked external at
 * bundle time, so nothing SDK-related ships in the asset.
 */

import {
	SSMClient,
	GetParameterCommand,
	ParameterNotFound,
} from '@aws-sdk/client-ssm';
import {
	CognitoIdentityProviderClient,
	CreateIdentityProviderCommand,
	UpdateIdentityProviderCommand,
	DeleteIdentityProviderCommand,
	type IdentityProviderTypeType,
} from '@aws-sdk/client-cognito-identity-provider';

/** Minimal shapes so the handler can be unit-tested with fake clients. */
export interface SsmLike {
	send(command: GetParameterCommand): Promise<{ Parameter?: { Value?: string } }>;
}
export interface IdpLike {
	send(
		command: CreateIdentityProviderCommand | UpdateIdentityProviderCommand | DeleteIdentityProviderCommand,
	): Promise<unknown>;
}

export interface CfnEvent {
	RequestType: 'Create' | 'Update' | 'Delete';
	PhysicalResourceId?: string;
	ResourceProperties: {
		UserPoolId: string;
		ProviderName: string;
		ProviderType: string;
		ClientIdParam: string;
		ClientSecretParam: string;
		ProviderDetails?: Record<string, string>;
		AttributeMapping?: Record<string, string>;
	};
}

const DEFAULT_RETRIES = 6;
const DEFAULT_RETRY_DELAY_MS = 2000;

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** Retry knobs — overridable so tests don't wait real seconds. */
export interface HandlerOptions {
	retries?: number;
	retryDelayMs?: number;
}

/**
 * Build a handler bound to the given clients. Production uses the real SDK
 * clients; tests inject fakes.
 */
export function createHandler(ssm: SsmLike, idp: IdpLike, options: HandlerOptions = {}) {
	const retries = options.retries ?? DEFAULT_RETRIES;
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	// Read + decrypt a SecureString by name. Retries on a not-yet-present
	// parameter (the bulk secret-init resource may land slightly later) and on
	// transient errors; a terminal not-found surfaces an actionable message.
	async function readSecret(name: string, providerName: string): Promise<string> {
		let lastErr: unknown;
		for (let attempt = 0; attempt < retries; attempt++) {
			try {
				const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
				return r.Parameter?.Value ?? '';
			} catch (e) {
				lastErr = e;
				if (attempt < retries - 1) {
					await sleep(retryDelayMs);
				}
			}
		}
		if (lastErr instanceof ParameterNotFound || (lastErr as { name?: string })?.name === 'ParameterNotFound') {
			throw new Error(
				`AuthOIDC: IdP credential parameter "${name}" for provider "${providerName}" was not found. ` +
					`Set it before deploying — write the SSM SecureString directly ` +
					`(e.g. \`aws ssm put-parameter --name ${name} --type SecureString --value <secret> --overwrite\`) ` +
					`or via the AppSetting's runtime \`put()\`.`,
			);
		}
		throw lastErr;
	}

	return async function handler(event: CfnEvent): Promise<{ PhysicalResourceId: string }> {
		const p = event.ResourceProperties;
		// ProviderType is part of the identity so a type change forces a clean
		// replacement (Update cannot change an IdP's type).
		const physicalId = `${p.UserPoolId}|${p.ProviderName}|${p.ProviderType}`;

		if (event.RequestType === 'Delete') {
			try {
				await idp.send(
					new DeleteIdentityProviderCommand({ UserPoolId: p.UserPoolId, ProviderName: p.ProviderName }),
				);
			} catch (e) {
				if ((e as { name?: string })?.name !== 'ResourceNotFoundException') throw e;
			}
			return { PhysicalResourceId: physicalId };
		}

		const clientId = await readSecret(p.ClientIdParam, p.ProviderName);
		const clientSecret = await readSecret(p.ClientSecretParam, p.ProviderName);
		if (!clientId || !clientSecret) {
			throw new Error(
				`AuthOIDC: IdP credentials for provider "${p.ProviderName}" are empty. ` +
					`Set the SecureString values before deploying.`,
			);
		}

		const details = { ...(p.ProviderDetails ?? {}), client_id: clientId, client_secret: clientSecret };
		const attributeMapping = p.AttributeMapping ?? {};

		if (event.RequestType === 'Create') {
			try {
				await idp.send(
					new CreateIdentityProviderCommand({
						UserPoolId: p.UserPoolId,
						ProviderName: p.ProviderName,
						ProviderType: p.ProviderType as IdentityProviderTypeType,
						ProviderDetails: details,
						AttributeMapping: attributeMapping,
					}),
				);
			} catch (e) {
				// Idempotent create: an earlier failed run may have left the IdP behind.
				if ((e as { name?: string })?.name !== 'DuplicateProviderException') throw e;
				await idp.send(
					new UpdateIdentityProviderCommand({
						UserPoolId: p.UserPoolId,
						ProviderName: p.ProviderName,
						ProviderDetails: details,
						AttributeMapping: attributeMapping,
					}),
				);
			}
			return { PhysicalResourceId: physicalId };
		}

		// Update — same pool + provider name + type. Fall back to Create if the
		// IdP went missing out of band.
		try {
			await idp.send(
				new UpdateIdentityProviderCommand({
					UserPoolId: p.UserPoolId,
					ProviderName: p.ProviderName,
					ProviderDetails: details,
					AttributeMapping: attributeMapping,
				}),
			);
		} catch (e) {
			if ((e as { name?: string })?.name !== 'ResourceNotFoundException') throw e;
			await idp.send(
				new CreateIdentityProviderCommand({
					UserPoolId: p.UserPoolId,
					ProviderName: p.ProviderName,
					ProviderType: p.ProviderType as IdentityProviderTypeType,
					ProviderDetails: details,
					AttributeMapping: attributeMapping,
				}),
			);
		}
		return { PhysicalResourceId: physicalId };
	};
}

/** Production entry point wired to the real SDK clients. */
export const handler = createHandler(new SSMClient({}), new CognitoIdentityProviderClient({}));
