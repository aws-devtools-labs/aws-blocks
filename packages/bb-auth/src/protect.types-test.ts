// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compile-time proof that `auth.protect(...)` is typed with no cast: the
 * `methods` factory's `user` is `AuthenticatedUser<O>` of the block's own
 * options, the namespace's client type merges the `public` and `methods`
 * methods (the same mapping `new ApiNamespace(...)` returns), a name in both
 * factories is an error, and `role` is checked against the declared groups.
 *
 * The compile is the test — nothing here runs. Every `@ts-expect-error`
 * asserts that the next line is a type error (TS2578 fails the build if it
 * stops being one); `Expect<Equal<…>>` pins exact resolutions.
 *
 * @internal
 */

import { ApiNamespace, type BlocksContext, type ScopeParent } from '@aws-blocks/core';
import type { AuthenticatedUser } from './index.mock.js';
import { Auth } from './index.mock.js';

declare const scope: ScopeParent;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
/** The client view of a namespace, flattened, to compare two with `Equal`. */
type Client<N> = { [K in keyof N]: N[K] };

const auth = new Auth(scope, 'auth', { users: { groups: ['admin', 'editor'] } });
type Options = typeof auth extends Auth<infer O> ? O : never;

// ── The injected user is the block's typed user; `public` gets none ─────────

export const notesApi = auth.protect(scope, 'notesApi', {
	public: (context) => {
		type _context = Expect<Equal<typeof context, BlocksContext>>;
		return {
			async health() {
				return { ok: true };
			},
		};
	},
	methods: (_context, user) => {
		type _user = Expect<Equal<typeof user, AuthenticatedUser<Options>>>;
		return {
			async whoAmI() {
				// Groups narrow to the declared `users.groups`, with no cast.
				type _groups = Expect<Equal<typeof user.groups, ('admin' | 'editor')[]>>;
				return { userSub: user.userSub, groups: user.groups };
			},
			async rename(id: string, title: string) {
				return { id, title, by: user.userSub };
			},
		};
	},
});

// ── The client type merges both factories, as `new ApiNamespace(...)` types them ──

const plain = new ApiNamespace(scope, 'plain', () => ({
	async health() {
		return { ok: true };
	},
	async whoAmI() {
		return { userSub: '', groups: ['admin' as 'admin' | 'editor'] };
	},
	async rename(id: string, title: string) {
		return { id, title, by: '' };
	},
}));
type _merged = Expect<Equal<Client<typeof notesApi>, Client<typeof plain>>>;
type _whoAmI = Expect<
	Equal<Awaited<ReturnType<typeof notesApi.whoAmI>>, { userSub: string; groups: ('admin' | 'editor')[] }>
>;
type _rename = Expect<Equal<Parameters<typeof notesApi.rename>, [id: string, title: string]>>;
type _health = Expect<Equal<ReturnType<typeof notesApi.health>, Promise<{ ok: boolean }>>>;

// ── `public` is optional; every method is then protected ────────────────────

const allProtected = auth.protect(scope, 'allProtected', {
	methods: () => ({
		async a() {
			return 1;
		},
	}),
});
type _onlyA = Expect<Equal<keyof typeof allProtected, 'a'>>;

// ── A name in both factories is an error ────────────────────────────────────

auth.protect(scope, 'clash', {
	public: () => ({ async health() {} }),
	// @ts-expect-error — `health` is already a public method
	methods: () => ({ async health() {}, async other() {} }),
});

// ── `role` is checked against the declared groups ───────────────────────────

auth.protect(scope, 'admins', { methods: () => ({ async listUsers() {} }) }, { role: 'admin' });
auth.protect(
	scope,
	'badRole',
	{ methods: () => ({ async listUsers() {} }) },
	// @ts-expect-error — 'root' is not a declared group
	{ role: 'root' },
);

// ── `methods` is required ───────────────────────────────────────────────────

// @ts-expect-error — a namespace with only public methods is a plain `ApiNamespace`
auth.protect(scope, 'noMethods', { public: () => ({ async a() {} }) });

// ── A block without declared groups: any group name, plain string groups ────

const open = new Auth(scope, 'open', {});
open.protect(
	scope,
	'openApi',
	{
		methods: (_context, user) => ({
			async me() {
				type _groups = Expect<Equal<typeof user.groups, string[]>>;
				return user.userId;
			},
		}),
	},
	{ role: 'anything' },
);

// ── The `ApiNamespace` options pass through ─────────────────────────────────

declare const compute: { resolve(): { readonly type: 'serverless' } };
auth.protect(scope, 'computed', { methods: () => ({ async a() {} }) }, { compute });
