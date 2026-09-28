// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal local stand-in for the `aws-amplify` client surface exercised by the
 * experiment. The REAL types come from `aws-amplify` (v6); this file lets the
 * prototype type-check in a worktree without installing that dependency.
 *
 * Shapes match aws-amplify@6:
 *  - `Amplify.configure(config)` accepts the parsed `amplify_outputs.json`
 *    (the "ResourcesConfig | LegacyConfig | amplify_outputs" union — v6 accepts
 *    the outputs object directly).
 *  - `signUp` / `signIn` / `confirmSignUp` from `aws-amplify/auth`.
 *
 * If/when the prototype is promoted into a real test-app, delete this file and
 * import from `aws-amplify` — the client code (`amplify-client.ts`) is written
 * against these names and will bind to the real package unchanged.
 */
declare module 'aws-amplify' {
	// v6 Amplify.configure accepts the amplify_outputs object directly.
	export const Amplify: {
		configure(config: unknown, options?: unknown): void;
		getConfig(): unknown;
	};
}

declare module 'aws-amplify/auth' {
	export interface SignUpInput {
		username: string;
		password: string;
		options?: { userAttributes?: Record<string, string> };
	}
	export interface SignUpOutput {
		isSignUpComplete: boolean;
		nextStep: { signUpStep: string };
	}
	export interface SignInInput {
		username: string;
		password: string;
	}
	export interface SignInOutput {
		isSignedIn: boolean;
		nextStep: { signInStep: string };
	}
	export interface ConfirmSignUpInput {
		username: string;
		confirmationCode: string;
	}
	export interface ConfirmSignUpOutput {
		isSignUpComplete: boolean;
	}
	export function signUp(input: SignUpInput): Promise<SignUpOutput>;
	export function signIn(input: SignInInput): Promise<SignInOutput>;
	export function confirmSignUp(input: ConfirmSignUpInput): Promise<ConfirmSignUpOutput>;
	export function signOut(): Promise<void>;
}
