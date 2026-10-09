// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `users.signInWith` as Cognito models it: **username attributes** or **alias
 * attributes** (<https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html#user-pool-settings-aliases>).
 * The CDK layer (`mapSignInWith`) emits exactly this split, so the runtime
 * reads the same mode from the same option:
 *
 * - `signInWith` **without** `'username'` (e.g. `['email']`) → `UsernameAttributes`.
 *   The user signs up and in with their email / phone, but Cognito stores a
 *   **generated username equal to `sub`** ("The `SignUp` API populates the
 *   `username` attribute with a UUID for your user. This UUID has the same
 *   value as the `sub` claim in the user identity token."), and fills the
 *   `email` / `phone_number` attribute from the value given as the username.
 *   The email / phone is accepted in place of the username everywhere except
 *   `ListUsers`, verified or not.
 * - `signInWith` **with** `'username'` plus email / phone → `AliasAttributes`.
 *   The username is the one the user chose and is never in an alias's format;
 *   an email / phone signs in in its place only once **verified**.
 *
 * Runtime-agnostic: read by the local pool and by `AuthBase`.
 *
 * @internal
 */

/** A Cognito contact attribute that can be a sign-in attribute. */
export type ContactAttribute = 'email' | 'phone_number';

/** `users.signInWith`, resolved the way Cognito splits it. */
export interface SignInMode {
	/** Cognito `UsernameAttributes` (non-empty when `signInWith` omits `'username'`). */
	usernameAttributes: readonly ContactAttribute[];
	/** Cognito `AliasAttributes` (only when `signInWith` includes `'username'`). */
	aliasAttributes: readonly ContactAttribute[];
}

/** `signInWith`'s default — `mapSignInWith`'s (`AuthCognito`'s). */
const DEFAULT_SIGN_IN_WITH: readonly ('username' | 'email' | 'phone')[] = ['username', 'email'];

/**
 * Resolve `users.signInWith` (default `['username', 'email']`) to Cognito's
 * username-attribute / alias-attribute split.
 *
 * @internal
 */
export function resolveSignInMode(signInWith?: readonly ('username' | 'email' | 'phone')[]): SignInMode {
	const list = signInWith ?? DEFAULT_SIGN_IN_WITH;
	const contacts: ContactAttribute[] = [];
	if (list.includes('email')) contacts.push('email');
	if (list.includes('phone')) contacts.push('phone_number');
	return list.includes('username')
		? { usernameAttributes: [], aliasAttributes: contacts }
		: { usernameAttributes: contacts, aliasAttributes: [] };
}

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+$/;
const PHONE_FORMAT = /^\+\d+$/;

/** Whether `value` is in the format of `attribute` (an email address / an E.164 phone number). */
export function isInFormatOf(attribute: ContactAttribute, value: string): boolean {
	return attribute === 'email' ? EMAIL_FORMAT.test(value) : PHONE_FORMAT.test(value);
}

/**
 * Whether a user whose current claims / attributes are `attributes` signs in
 * with `login` through a sign-in attribute (not their username): on a
 * username-attribute pool any matching email / phone; on an alias pool only a
 * verified one. `*_verified` may be the string `'true'` (local pool) or the
 * boolean `true` (a Cognito ID token).
 *
 * @internal
 */
export function signsInWithAttribute(mode: SignInMode, attributes: Record<string, unknown>, login: string): boolean {
	for (const attr of mode.usernameAttributes) if (attributes[attr] === login) return true;
	for (const attr of mode.aliasAttributes) {
		const verified = attributes[`${attr}_verified`];
		if (attributes[attr] === login && (verified === true || verified === 'true')) return true;
	}
	return false;
}
