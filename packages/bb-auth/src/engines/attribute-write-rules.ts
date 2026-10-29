// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The user-attribute write rules that need **no pool schema**, shared by the
 * local engine (through `mock-attribute-schema.ts`) and the Cognito engine
 * (`native-cognito.ts`, `native-cognito-admin.ts`,
 * `native-cognito-challenges.ts`), so both runtimes reject the same writes
 * with the same canonical error (FX43, R78).
 *
 * Why the Cognito engine checks these itself: an untyped client (JSON-RPC, a
 * native app) can send any JSON as a value, and the AWS JS SDK validates
 * nothing. It serializes a number, boolean, object or array `Value` as-is and
 * drops a `null` one, so Cognito's JSON protocol answers with
 * `SerializationException`, which is outside the `AuthErrors` vocabulary, and
 * the client would see a 500 `InternalErrorException` where the local engine
 * answers 400 `InvalidParameterException`. Checking before the SDK call gives
 * the canonical answer on both runtimes, and no call is made.
 *
 * Rules (sources as in `mock-attribute-schema.ts`):
 *
 * - **Non-string value** → `InvalidParameterException`.
 * - **Value over 2,048 characters** → `InvalidParameterException`
 *   (`AttributeType.Value`: "Maximum length of 2048").
 * - **`email_verified` / `phone_number_verified` through the app client**
 *   (`signUp`, `update`) → `NotAuthorizedException`: the client sets no
 *   `WriteAttributes`, and the verified flags are not in the default write
 *   set. `AdminCreateUser` is IAM-authorized and may write them.
 * - **`sub`** → `InvalidParameterException`: Cognito-assigned and immutable,
 *   so no call writes it.
 *
 * The schema-dependent rules — an unknown name, an undeclared `custom:`
 * attribute, an immutable custom attribute after creation — are left to the
 * caller: the local engine knows the schema it provisions
 * (`MockAttributeSchema`), and on AWS Cognito knows the deployed one and
 * answers `InvalidParameterException`, which reaches the client as is.
 *
 * **Precedence** (FX44, R79). When one write breaks several rules, both
 * engines answer with the same error because they apply the rules in the same
 * order, each over the **whole write** before the next:
 *
 * 1. every value is a string (`InvalidParameterException`);
 * 2. every value is within 2,048 characters (`InvalidParameterException`);
 * 3. the app client may write every name: no verified flag on `signUp` /
 *    `update` (`NotAuthorizedException`);
 * 4. the pool schema: `sub` here, then the caller's schema rules (unknown
 *    name, undeclared `custom:`, immutable after creation), all
 *    `InvalidParameterException`.
 *
 * Cognito documents no order, so this one follows how its JSON API processes
 * a request: a wrong-typed member fails deserialization before anything
 * reads it, a model length constraint is checked next, and authorization
 * comes before the work it authorizes. It is also the only order in which
 * the AWS engine's answer never depends on the schema, which it cannot see
 * (an external pool's least of all): the schema rules all give the same
 * error, and come last. Before FX44 each attribute was checked in turn, so a
 * write naming an undeclared `custom:` attribute before `email_verified` was
 * 400 locally and 401 on AWS. Before any attribute rule, `signUp` checks that
 * the pool allows self-service sign-up at all ({@link signUpNotPermitted}).
 *
 * Pure: imports only `../errors.js`, so it is safe in the AWS import graph.
 *
 * @internal
 */

import { AuthErrors } from '../errors.js';

/**
 * Which call writes the attributes:
 *
 * - `signUp` — `SignUp`: a new user, through the app client.
 * - `adminCreateUser` — `AdminCreateUser`: a new user, IAM-authorized.
 * - `update` — `UpdateUserAttributes`, or a challenge answer's
 *   `userAttributes`: an existing user, through the app client.
 *
 * @internal
 */
export type AttributeWrite = 'signUp' | 'adminCreateUser' | 'update';

/**
 * In the schema, but outside an app client's default write permissions.
 *
 * @internal
 */
export const VERIFIED_FLAGS: ReadonlySet<string> = new Set(['email_verified', 'phone_number_verified']);

/** `AttributeType.Value`: "Maximum length of 2048". */
const MAX_VALUE_LENGTH = 2048;

/** A Cognito-shaped service error (`name` = the exception name), for `AuthBase` to map. */
function rejection(name: string, message: string): Error {
	const e = new Error(message);
	e.name = name;
	return e;
}

/**
 * Cognito's answer to `SignUp` on a pool that allows no self-service sign-up
 * (`AllowAdminCreateUserOnly`, which the CDK layer sets for
 * `emailPassword: { selfSignUp: false }`; see `selfSignUpEnabled` in
 * `cdk/contract.ts`). The operation itself is refused, so both engines
 * throw this before any attribute rule (FX44, R79): "If you do not enable
 * self-registration, new users must be created by administrative API
 * actions" (developer guide, "Creating user accounts as administrator").
 *
 * @internal
 */
export function signUpNotPermitted(): Error {
	return rejection(AuthErrors.NotAuthorized, 'SignUp is not permitted for this user pool');
}

/**
 * Cognito's answer to writing an immutable attribute (`sub`, or a
 * `mutable: false` custom attribute after creation).
 *
 * @internal
 */
export function immutableAttributeError(name: string): Error {
	return rejection(
		AuthErrors.InvalidParameter,
		`Invalid user attributes: user.${name}: Attribute cannot be updated. (changing an immutable attribute)`,
	);
}

/**
 * Throw the error Cognito answers `write` with when the write breaks a
 * schema-independent rule; return normally otherwise. `attributes` is the
 * caller's input as received (an untyped client can send any JSON); an
 * `undefined` value is skipped: it is absent on the wire.
 *
 * The rules apply in the module's precedence order, each over every
 * attribute before the next (FX44): a non-string value anywhere wins over a
 * value over 2,048 characters, which wins over a verified flag through the
 * app client (`signUp`, `update`; `adminCreateUser` may write them), which
 * wins over `sub`. Within one rule, the first attribute in input order is
 * reported. The Cognito engine calls this before it sends the write: a
 * rejected write sends nothing. The local engine calls it first too, then
 * applies its schema rules (`MockAttributeSchema`).
 *
 * @internal
 */
export function checkAttributeValues(attributes: Readonly<Record<string, unknown>>, write: AttributeWrite): void {
	const values: [name: string, value: string][] = [];
	// 1. The wire shape: every value a string.
	for (const [name, value] of Object.entries(attributes)) {
		if (value === undefined) continue;
		if (typeof value !== 'string') {
			throw rejection(
				AuthErrors.InvalidParameter,
				`Attributes did not conform to the schema: ${name}: the value must be a string`,
			);
		}
		values.push([name, value]);
	}
	// 2. `AttributeType.Value`'s length constraint.
	for (const [name, value] of values) {
		if (value.length > MAX_VALUE_LENGTH) {
			throw rejection(
				AuthErrors.InvalidParameter,
				`Attributes did not conform to the schema: ${name}: String must be no longer than ${MAX_VALUE_LENGTH} characters`,
			);
		}
	}
	// 3. The app client's write permissions (the admin API is IAM-authorized).
	if (write !== 'adminCreateUser') {
		for (const [name] of values) {
			if (VERIFIED_FLAGS.has(name)) {
				throw rejection(AuthErrors.NotAuthorized, 'A client attempted to write unauthorized attribute');
			}
		}
	}
	// 4. The schema rule that needs no schema: `sub` is Cognito-assigned.
	for (const [name] of values) {
		if (name === 'sub') throw immutableAttributeError(name);
	}
}
