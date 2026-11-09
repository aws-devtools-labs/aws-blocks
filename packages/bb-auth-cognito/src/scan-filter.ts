// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ApiError } from '@aws-blocks/core';
import { type AdminUserFilter, AuthCognitoErrors } from './types.js';

/**
 * Refuse an `admin.scan()` filter value that contains `"` or `\`.
 *
 * Cognito `ListUsers` unescapes its `Filter` string more than once, so no
 * escaping makes such a value match literally: an escaped quote ends the value
 * early, an escaped backslash does not match, and a doubled backslash matches a
 * single one. Rejecting the value up front (in the mock too) keeps local and AWS
 * results the same and keeps the value from reshaping the filter expression.
 *
 * @throws ApiError 400 `AuthCognitoErrors.InvalidParameter`.
 * @internal
 */
export function assertScanFilterValue(filter?: AdminUserFilter): void {
	if (filter && /["\\]/.test(filter.value)) {
		throw new ApiError('admin.scan filter values cannot contain a double quote or a backslash', 400, {
			name: AuthCognitoErrors.InvalidParameter,
		});
	}
}
