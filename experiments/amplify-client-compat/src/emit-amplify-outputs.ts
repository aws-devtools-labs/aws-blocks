// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * emit-amplify-outputs — the experiment's core.
 *
 * Produces a schema-valid `amplify_outputs.json` (auth section) from the values
 * a Blocks `AuthCognito` construct exposes at synth time, so an app using the
 * `aws-amplify` client libraries can `Amplify.configure(outputs)` against a
 * Blocks-provisioned Cognito User Pool — with NO `ampx` / Amplify backend
 * toolchain involved.
 *
 * This is the write-side analogue of Blocks' native-platform spec exporter
 * (`@aws-blocks/core` `generate-spec` → `blocks.spec.json`): both dynamically
 * read the backend's shape and emit a config artefact for a client runtime.
 * Here the artefact is `amplify_outputs.json` and the client runtime is
 * `aws-amplify`.
 *
 * PURE + SIDE-EFFECT-FREE: takes plain values (the resolved User Pool ID,
 * Client ID, region and pool config that `AuthCognito` already computes), not
 * a CDK construct. In a real integration a thin CDK-side shim would read these
 * from `authCognito.userPool` / `authCognito.userPoolClient` (both public) and
 * a `CfnOutput`, then call this function. Keeping the mapping pure is what
 * makes it unit-testable with no CDK/AWS in the loop.
 */

import type {
	AmplifyAuthOutput,
	AmplifyMfaMethod,
	AmplifyOutputs,
	AmplifyStorageOutput,
	MfaConfiguration,
	UsernameAttribute,
} from './amplify-outputs-schema.js';

/**
 * The Blocks-side facts needed to describe a User Pool to the Amplify client.
 * Mirrors what `AuthCognito` (bb-auth-cognito) provisions and exposes:
 *  - `userPool.userPoolId` / `userPoolClient.userPoolClientId` (public readonly)
 *  - region from the enclosing CDK Stack
 *  - `signInWith`, `mfa`, `mfaTypes`, `passwordPolicy` from AuthCognitoOptions
 *
 * These are resolved TOKENS at synth; at deploy the CfnOutput carries concrete
 * values. The emitter treats them as opaque strings — it does not resolve them.
 */
export interface BlocksCognitoFacts {
	region: string;
	userPoolId: string;
	userPoolClientId: string;
	/** AuthCognitoOptions.signInWith — 'username' | 'email' | 'phone'. */
	signInWith?: Array<'username' | 'email' | 'phone'>;
	/** AuthCognitoOptions.mfa — 'off' | 'optional' | 'required'. */
	mfa?: 'off' | 'optional' | 'required';
	/** AuthCognitoOptions.mfaTypes — Blocks supports SMS | TOTP | EMAIL. */
	mfaTypes?: Array<'SMS' | 'TOTP' | 'EMAIL'>;
	passwordPolicy?: {
		minLength?: number;
		requireNumbers?: boolean;
		requireLowercase?: boolean;
		requireUppercase?: boolean;
		requireSymbols?: boolean;
	};
}

/** Optional extras the emitter can fold in. */
export interface EmitOptions {
	/** A Blocks JSON-RPC API URL to surface under `custom.blocks_api_url`. */
	blocksApiUrl?: string;
	/**
	 * Storage: only expressible if a bucket is reachable with the Amplify
	 * Storage client's model (Identity-Pool creds → direct S3). Blocks
	 * FileBucket does NOT fit that model (see gaps); passing this emits the
	 * section but ALSO records a gap.
	 */
	storage?: AmplifyStorageOutput;
}

/** A degraded-fidelity mapping the caller should be told about. */
export interface EmitGap {
	category: 'auth' | 'data' | 'storage' | 'oauth' | 'analytics' | 'functions';
	detail: string;
}

export interface EmitResult {
	outputs: AmplifyOutputs;
	gaps: EmitGap[];
}

const SIGNIN_MAP: Record<'username' | 'email' | 'phone', UsernameAttribute> = {
	username: 'username',
	email: 'email',
	phone: 'phone_number',
};

function mapMfaConfiguration(mfa: BlocksCognitoFacts['mfa']): MfaConfiguration {
	switch (mfa) {
		case 'required':
			return 'REQUIRED';
		case 'optional':
			return 'OPTIONAL';
		default:
			return 'NONE';
	}
}

/**
 * Emit `amplify_outputs.json` from Blocks Cognito facts.
 *
 * The auth section is the reliable Tier-1 mapping: User Pool ID, Client ID and
 * region map 1:1, and the Blocks client (no secret, USER_PASSWORD_AUTH,
 * disableOAuth) is exactly the shape the Amplify browser SDK expects.
 *
 * Everything the Amplify schema can express but Blocks does not model is
 * recorded in `gaps` rather than silently omitted or faked.
 */
export function emitAmplifyOutputs(facts: BlocksCognitoFacts, opts: EmitOptions = {}): EmitResult {
	const gaps: EmitGap[] = [];

	if (!facts.region) throw new Error('emitAmplifyOutputs: region is required');
	if (!facts.userPoolId) throw new Error('emitAmplifyOutputs: userPoolId is required');
	if (!facts.userPoolClientId) throw new Error('emitAmplifyOutputs: userPoolClientId is required');

	const auth: AmplifyAuthOutput = {
		aws_region: facts.region,
		user_pool_id: facts.userPoolId,
		user_pool_client_id: facts.userPoolClientId,
	};

	// username_attributes — Blocks signInWith → Amplify username_attributes.
	if (facts.signInWith?.length) {
		auth.username_attributes = facts.signInWith.map((s) => SIGNIN_MAP[s]);
	}

	// password_policy — snake_case remap.
	if (facts.passwordPolicy) {
		const p = facts.passwordPolicy;
		auth.password_policy = {
			...(p.minLength !== undefined ? { min_length: p.minLength } : {}),
			...(p.requireNumbers !== undefined ? { require_numbers: p.requireNumbers } : {}),
			...(p.requireLowercase !== undefined ? { require_lowercase: p.requireLowercase } : {}),
			...(p.requireUppercase !== undefined ? { require_uppercase: p.requireUppercase } : {}),
			...(p.requireSymbols !== undefined ? { require_symbols: p.requireSymbols } : {}),
		};
	}

	// MFA. Amplify's mfa_methods enum is SMS | TOTP only — EMAIL has no
	// representation, so a Blocks pool using Email OTP loses that method in the
	// client config (Cognito still enforces it server-side; the Amplify UI just
	// won't offer it). Record the gap rather than dropping it silently.
	auth.mfa_configuration = mapMfaConfiguration(facts.mfa);
	if (facts.mfaTypes?.length) {
		const mapped: AmplifyMfaMethod[] = [];
		for (const t of facts.mfaTypes) {
			if (t === 'SMS' || t === 'TOTP') {
				mapped.push(t);
			} else if (t === 'EMAIL') {
				gaps.push({
					category: 'auth',
					detail:
						"Blocks mfaType 'EMAIL' has no amplify_outputs mfa_methods representation " +
						'(schema enum is SMS | TOTP). Cognito still enforces it; the Amplify client UI cannot surface it.',
				});
			}
		}
		if (mapped.length) auth.mfa_methods = mapped;
	}

	// Blocks AuthCognito is a User-Pool-only, server-mediated (BFF) design:
	// no Identity Pool, no unauthenticated identities, no hosted UI / OAuth.
	// Be explicit so the Amplify client does not attempt Identity-Pool creds.
	auth.unauthenticated_identities_enabled = false;
	// identity_pool_id intentionally omitted — see one-way-door decision in doc.

	const outputs: AmplifyOutputs = {
		$schema: 'https://amplify.aws/2024-02/outputs-schema.json',
		version: '1',
		auth,
	};

	// A Blocks app's real API is JSON-RPC over a single endpoint, NOT AppSync.
	// The Amplify `data` client (generateClient/GraphQL) cannot talk to it, so
	// the URL goes under `custom` (matching the existing amplify-gen2 interop),
	// and we record that `data` is unsatisfiable.
	if (opts.blocksApiUrl) {
		outputs.custom = { blocks_api_url: opts.blocksApiUrl };
		gaps.push({
			category: 'data',
			detail:
				'Blocks exposes a JSON-RPC ApiNamespace at a single endpoint, not an AppSync GraphQL API. ' +
				'The Amplify data client (generateClient) cannot consume it; the URL is surfaced under custom.blocks_api_url ' +
				'for a Blocks typed client instead.',
		});
	}

	if (opts.storage) {
		outputs.storage = opts.storage;
		gaps.push({
			category: 'storage',
			detail:
				'Amplify Storage (uploadData/getUrl) authorizes browser→S3 calls with Identity-Pool credentials. ' +
				'Blocks FileBucket grants only the backend Lambda role and vends presigned URLs through the API. ' +
				'Emitting a storage.bucket_name does not make the Amplify Storage client work without an Identity Pool.',
		});
	}

	return { outputs, gaps };
}

/**
 * Minimal structural validation against the required fields of schema v1.
 * (Not a full JSON-Schema validator — checks the invariants the client relies
 * on: version, and auth's three required keys when auth is present.)
 */
export function validateAmplifyOutputs(o: AmplifyOutputs): string[] {
	const errors: string[] = [];
	if (o.version !== '1') errors.push(`version must be "1", got ${JSON.stringify(o.version)}`);
	if (o.auth) {
		if (!o.auth.aws_region) errors.push('auth.aws_region is required');
		if (!o.auth.user_pool_id) errors.push('auth.user_pool_id is required');
		if (!o.auth.user_pool_client_id) errors.push('auth.user_pool_client_id is required');
		if (o.auth.oauth) {
			const oa = o.auth.oauth;
			if (!oa.domain) errors.push('auth.oauth.domain is required when oauth is present');
			if (!oa.redirect_sign_in_uri?.length) errors.push('auth.oauth.redirect_sign_in_uri must be non-empty');
			if (!oa.redirect_sign_out_uri?.length) errors.push('auth.oauth.redirect_sign_out_uri must be non-empty');
		}
	}
	if (o.storage) {
		if (!o.storage.aws_region) errors.push('storage.aws_region is required');
		if (!o.storage.bucket_name) errors.push('storage.bucket_name is required');
	}
	return errors;
}
