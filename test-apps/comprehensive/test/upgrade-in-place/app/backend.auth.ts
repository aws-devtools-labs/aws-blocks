// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AFTER: the same backend switched to the unified `Auth` block — same scope
 * id, same block id, same API. The options are `backend.auth-cognito.ts.txt`'s
 * `{ groups: ['admins'] }` in `Auth`'s shape.
 *
 * Materialized as `aws-blocks/index.ts` in the PR checkout.
 */

import { Auth } from '@aws-blocks/bb-auth';
import { ApiNamespace, Scope } from '@aws-blocks/blocks';

const scope = new Scope('upgrade');

const auth = new Auth(scope, 'auth', { users: { groups: ['admins'] } });

export const api = new ApiNamespace(scope, 'api', (context) => ({
	/** Sign in with a password; sets the `auth_<fullId>` session cookie. */
	async signIn(username: string, password: string) {
		const result = await auth.signIn(username, password, context);
		return result.status === 'signedIn'
			? { status: result.status, userSub: result.user.userSub }
			: { status: result.status, nextStep: result.nextStep.name };
	},

	/** The signed-in user, or 401. */
	async whoAmI() {
		const user = await auth.requireAuth(context);
		return { userId: user.userId, userSub: user.userSub };
	},
}));
