// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation and encoding of the {@link AdminUserFilter} that `auth.admin.scan`
 * hands to Cognito's `ListUsers` `Filter`, shared by both runtimes so the
 * local mock refuses exactly what the AWS layer refuses.
 *
 * Cognito's grammar (`ListUsers` API reference, `Filter` parameter):
 * `AttributeName Filter-Type "AttributeValue"`, where "quotation marks within
 * the filter string must be escaped using the backslash (\) character".
 * Cognito does not honour that escape: on AWS, `username = "u\" or username
 * ^= \""` matched user `u` (the comprehensive sandbox e2e), so an escaped
 * quote still ends the value. A value holding a `"` is therefore refused, as
 * one holding a backslash is (the reference documents no escape for it) — fail
 * closed rather than guess at the grammar.
 * Only the attributes the reference lists as searchable are accepted, so the
 * attribute name can never carry operators or quotes into the expression
 * (custom attributes are not searchable in Cognito).
 *
 * Runtime-agnostic.
 *
 * @internal
 */

import { ApiError } from '@aws-blocks/core';
import { AuthErrors } from './errors.js';
import type { AdminUserFilter } from './types.js';

/** The attributes Cognito's `ListUsers` `Filter` can search on. */
export const SEARCHABLE_USER_ATTRIBUTES: readonly string[] = [
	'username',
	'email',
	'phone_number',
	'name',
	'given_name',
	'family_name',
	'preferred_username',
	'cognito:user_status',
	'status',
	'sub',
];

/**
 * The longest `Filter` Cognito accepts ("Length Constraints: Maximum length of
 * 256", `ListUsers` API reference). Locally a longer filter would simply match
 * nothing while Cognito rejects it, so both runtimes refuse it up front.
 */
export const MAX_FILTER_LENGTH = 256;

/**
 * The `ListUsers` `Filter` expression for an already-validated filter. A
 * validated value holds no `"` and no backslash (see
 * {@link assertAdminUserFilter}); the escaping here (`\` before `"`, so an
 * escape it adds can never be undone by a later one) is defense in depth for a
 * caller that reaches it with unvalidated input.
 *
 * @internal
 */
export function encodeCognitoFilter(attribute: string, match: 'startsWith' | 'equals', value: string): string {
	const op = match === 'startsWith' ? '^=' : '=';
	return `${attribute} ${op} "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function invalid(message: string): ApiError {
	return new ApiError(message, 400, { name: AuthErrors.InvalidParameter });
}

/**
 * Refuse a filter that cannot be expressed safely: an attribute outside
 * {@link SEARCHABLE_USER_ATTRIBUTES}, a `match` other than `startsWith` /
 * `equals`, a value that isn't a string or contains a double quote, a
 * backslash or a control character, or an encoded expression longer than
 * {@link MAX_FILTER_LENGTH}.
 * Throws `InvalidParameterException` (400).
 *
 * Each field is read exactly once and the checks run on that snapshot, which is
 * what is returned: callers must use the returned filter, never `filter` again,
 * so a getter / Proxy (or a mutation after the check) cannot swap in a value
 * that was never validated.
 *
 * @internal
 */
export function assertAdminUserFilter(filter: AdminUserFilter): AdminUserFilter {
	const { attribute, match, value }: { attribute: unknown; match: unknown; value: unknown } = filter;
	if (typeof attribute !== 'string' || !SEARCHABLE_USER_ATTRIBUTES.includes(attribute)) {
		throw invalid(
			`admin.scan: '${String(attribute)}' is not a searchable attribute (one of: ${SEARCHABLE_USER_ATTRIBUTES.join(', ')})`,
		);
	}
	if (match !== 'startsWith' && match !== 'equals') {
		throw invalid(`admin.scan: match must be 'startsWith' or 'equals'`);
	}
	if (typeof value !== 'string') {
		throw invalid('admin.scan: value must be a string');
	}
	if (value.includes('"')) {
		// Cognito does not honour the documented `\"` escape (see the module doc).
		throw invalid('admin.scan: value must not contain a double quote');
	}
	if (value.includes('\\')) {
		throw invalid('admin.scan: value must not contain a backslash');
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
	if (/[\u0000-\u001f\u007f]/.test(value)) {
		throw invalid('admin.scan: value must not contain control characters');
	}
	const length = encodeCognitoFilter(attribute, match, value).length;
	if (length > MAX_FILTER_LENGTH) {
		throw invalid(
			`admin.scan: the filter is ${length} characters once encoded; Cognito accepts at most ${MAX_FILTER_LENGTH}`,
		);
	}
	return { attribute, match, value };
}

/**
 * An {@link AdminUserFilter} as a Cognito `ListUsers` `Filter` expression:
 * `^=` for a prefix match, `=` for an exact one, the value quoted. Validates
 * first ({@link assertAdminUserFilter}): a value with a `"` or a backslash is
 * refused, so no input can close the quoted value.
 *
 * @internal
 */
export function toCognitoFilter(filter: AdminUserFilter): string {
	const { attribute, match, value } = assertAdminUserFilter(filter);
	return encodeCognitoFilter(attribute, match, value);
}
