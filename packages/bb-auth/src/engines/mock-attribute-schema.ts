// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The local user pool's attribute schema: which user attributes a write may
 * name, with what values, through which call — checked the way Cognito checks
 * `SignUp`, `UpdateUserAttributes`, `AdminCreateUser` and a challenge's
 * `userAttributes` (FX39, R74). Without it the mock stored anything (an
 * attribute named `attributes` holding an object, R65 (c)) and returned it from
 * `getUserAttributes`, so local dev hid a bug that fails on AWS.
 *
 * The pool's schema is the one the CDK layer provisions: Cognito's standard
 * attributes plus the declared `users.attributes`, `custom:`-prefixed, with
 * their mutability (`mapCustomAttributes`). The app client sets no
 * `WriteAttributes`, so Cognito's default write permissions apply.
 *
 * Rules (sources: the Cognito developer guide, "Working with user attributes",
 * <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html>;
 * API reference `AttributeType` and `CreateUserPoolClient`):
 *
 * - **Unknown name** → `InvalidParameterException`: neither a standard
 *   attribute, a `*_verified` flag nor a declared `custom:` attribute. A
 *   declared custom attribute written without its prefix is prefixed by
 *   `AuthBase` first; an undeclared bare name stays bare and is unknown.
 * - **Non-string value** → `InvalidParameterException`: "you must pass the
 *   value as a string … A native number or boolean is rejected before the
 *   value is stored".
 * - **Value over 2,048 characters** → `InvalidParameterException`
 *   (`AttributeType.Value`: "Maximum length of 2048").
 * - **Not writable by the app client** → `NotAuthorizedException` ("If your
 *   app tries to set a value for an attribute that it isn't authorized to
 *   write, Amazon Cognito returns `NotAuthorizedException`"). With no
 *   `WriteAttributes` the client writes the standard and custom attributes,
 *   not `email_verified` / `phone_number_verified` (those are only in the
 *   default *read* set). Applies to the self-service calls only; the admin API
 *   is authorized by IAM, and an administrator may mark a contact verified.
 * - **Immutable attribute after creation** → `InvalidParameterException`: "You
 *   can only write a value to an immutable attribute when you create a user"
 *   (`SignUp`, `AdminCreateUser`). `sub` is Cognito-assigned and immutable, so
 *   no call writes it.
 *
 * **External pool** (`userPool` set, `Auth.fromExisting`): the mock cannot see
 * that pool's schema, so any `custom:` name is accepted (an attribute declared
 * `mutable: false` is still immutable); every other rule applies.
 *
 * The rules that need no schema (string value, length, the verified flags,
 * `sub`) live in `attribute-write-rules.ts`, which the Cognito engine applies
 * too before its SDK call (FX43, R78); this module adds the schema-dependent
 * ones (a known name, immutability) around them, in the order below.
 *
 * **Precedence** (FX44, R79): when one write breaks several rules, the
 * answer is the one the Cognito engine gives for the same write. The
 * schema-independent rules run first, over the whole write
 * (`checkAttributeValues`: string, length, verified flags, `sub`), then the
 * schema rules here (unknown name, immutable after creation), all
 * `InvalidParameterException`. Before FX44 this checked each attribute in
 * turn, so `{ 'custom:undeclared': 'x', email_verified: 'true' }` on `signUp`
 * was 400 here and 401 on AWS.
 *
 * Mock-only, never imported by the AWS or browser entries.
 *
 * @internal
 */

import { AuthErrors } from '../errors.js';
import type { UserAttribute } from '../types.js';
import {
	type AttributeWrite,
	checkAttributeValues,
	immutableAttributeError,
	VERIFIED_FLAGS,
} from './attribute-write-rules.js';
import { serviceError } from './native-mock-store.js';

export type { AttributeWrite } from './attribute-write-rules.js';

/** Cognito's standard user attributes (developer guide, "Standard attributes"). */
const STANDARD_ATTRIBUTES: ReadonlySet<string> = new Set([
	'address',
	'birthdate',
	'email',
	'family_name',
	'gender',
	'given_name',
	'locale',
	'middle_name',
	'name',
	'nickname',
	'phone_number',
	'picture',
	'preferred_username',
	'profile',
	'sub',
	'updated_at',
	'website',
	'zoneinfo',
]);

/**
 * The attribute schema of the local pool, built from the `Auth` options.
 *
 * @internal
 */
export class MockAttributeSchema {
	private readonly custom: ReadonlyMap<string, { mutable: boolean }>;
	private readonly externalPool: boolean;

	constructor(options: { attributes?: readonly UserAttribute[]; externalPool?: boolean }) {
		this.custom = new Map(
			(options.attributes ?? []).map((a) => [`custom:${a.name}`, { mutable: a.mutable ?? true }]),
		);
		this.externalPool = options.externalPool === true;
	}

	/**
	 * Throw the error Cognito answers `write` with for the first attribute it
	 * rejects; return normally when every attribute is accepted. `attributes`
	 * is the caller's input as received — an untyped client can send any JSON.
	 *
	 * "First" is in the shared precedence order (FX44): the
	 * schema-independent rules over the whole write, then the schema rules
	 * below, each in input order.
	 */
	check(attributes: Readonly<Record<string, unknown>>, write: AttributeWrite): void {
		// Non-string, too long, a verified flag through the app client, `sub`:
		// the rules the Cognito engine checks too (`attribute-write-rules.ts`).
		checkAttributeValues(attributes, write);
		for (const [name, value] of Object.entries(attributes)) {
			// Absent on the wire (JSON drops it; the SDK treats it as absent).
			if (value === undefined) continue;
			const custom = this.custom.get(name);
			const known =
				STANDARD_ATTRIBUTES.has(name) ||
				VERIFIED_FLAGS.has(name) ||
				custom !== undefined ||
				(this.externalPool && name.startsWith('custom:'));
			if (!known) {
				throw serviceError(
					AuthErrors.InvalidParameter,
					`Attributes did not conform to the schema: Type for attribute {${name}} could not be determined`,
				);
			}
			if (write === 'update' && custom?.mutable === false) throw immutableAttributeError(name);
		}
	}
}
