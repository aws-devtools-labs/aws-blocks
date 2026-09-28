// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Types for `amplify_outputs.json` (Amplify Gen 2 client configuration file).
 *
 * Faithful subset of the official schema, version "1":
 *   https://github.com/aws-amplify/amplify-backend/blob/main/packages/client-config/src/client-config-schema/schema_v1.json
 *
 * This is what `Amplify.configure(outputs)` and `parseAmplifyConfig(outputs)`
 * consume. Only the sections relevant to the Blocks-backed experiment are
 * modelled (auth, storage, custom). `data`/`geo`/`analytics`/`notifications`
 * are declared as opaque so a full document still type-checks, but the
 * experiment does not emit them (see the gap table in the findings doc).
 */

/** Cognito standard attributes (subset used for `standard_required_attributes`). */
export type CognitoStandardAttribute =
	| 'address' | 'birthdate' | 'email' | 'family_name' | 'gender'
	| 'given_name' | 'locale' | 'middle_name' | 'name' | 'nickname'
	| 'phone_number' | 'picture' | 'preferred_username' | 'profile'
	| 'sub' | 'updated_at' | 'website' | 'zoneinfo';

export type UsernameAttribute = 'email' | 'phone_number' | 'username';
export type UserVerificationType = 'email' | 'phone_number';
export type MfaConfiguration = 'NONE' | 'OPTIONAL' | 'REQUIRED';

/** NOTE: Amplify's schema restricts client-facing MFA methods to SMS | TOTP. */
export type AmplifyMfaMethod = 'SMS' | 'TOTP';

export interface AmplifyAuthPasswordPolicy {
	min_length: number;
	require_numbers: boolean;
	require_lowercase: boolean;
	require_uppercase: boolean;
	require_symbols: boolean;
}

export interface AmplifyAuthOutput {
	/** REQUIRED */
	aws_region: string;
	/** REQUIRED */
	user_pool_id: string;
	/** REQUIRED */
	user_pool_client_id: string;
	/** Optional — only present when an Identity Pool exists (AWS-credential vending). */
	identity_pool_id?: string;
	password_policy?: AmplifyAuthPasswordPolicy;
	/** HostedUI/federated config. Requires a domain + redirect URIs. */
	oauth?: {
		identity_providers: Array<'GOOGLE' | 'FACEBOOK' | 'LOGIN_WITH_AMAZON' | 'SIGN_IN_WITH_APPLE'>;
		domain: string;
		scopes: string[];
		redirect_sign_in_uri: string[];
		redirect_sign_out_uri: string[];
		response_type: 'code' | 'token';
	};
	standard_required_attributes?: CognitoStandardAttribute[];
	username_attributes?: UsernameAttribute[];
	user_verification_types?: UserVerificationType[];
	unauthenticated_identities_enabled?: boolean;
	mfa_configuration?: MfaConfiguration;
	mfa_methods?: AmplifyMfaMethod[];
}

export interface AmplifyStorageOutput {
	aws_region: string;
	bucket_name: string;
}

/** Full document. `version` is the only globally-required field. */
export interface AmplifyOutputs {
	$schema?: string;
	version: '1';
	auth?: AmplifyAuthOutput;
	storage?: AmplifyStorageOutput;
	/** Free-form; where a Blocks JSON-RPC API URL naturally lives. */
	custom?: Record<string, unknown>;
	// Sections the Blocks backend cannot currently satisfy (see gap table).
	// Typed `never` so the emitter cannot produce them by accident; a loose
	// Record here is NOT assignable to aws-amplify@6's real AmplifyOutputs.
	data?: never;
	geo?: never;
	analytics?: never;
	notifications?: never;
}
