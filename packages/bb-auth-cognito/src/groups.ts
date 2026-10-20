// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AuthCognitoOptions } from './types.js';

/**
 * Names declared in `options.groups`, or `undefined` when none are declared (in
 * which case `GroupOf<O>` is unconstrained `string`, so the raw membership list
 * is already sound and no filtering is needed).
 *
 * Both runtimes' `requireRole` narrow the **returned** `groups` to this set so
 * the field stays within the declared literal union `CognitoUser<O>.groups`
 * promises — the live source can hold group names never declared in
 * `options.groups` (Cognito: created out of band or via `fromExisting`; mock: a
 * stale `.bb-data` blob whose keys outlived a change to `options.groups`). Shared
 * so the mock and AWS filter identically and can't drift. The membership
 * *decision* still runs against the raw live read.
 */
export function declaredGroupNames(groups: AuthCognitoOptions['groups']): Set<string> | undefined {
	if (!groups || groups.length === 0) return undefined;
	return new Set(groups.map((g) => (typeof g === 'string' ? g : g.name)));
}
