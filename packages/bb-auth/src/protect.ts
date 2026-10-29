// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `auth.protect(scope, name, { public, methods }, { role, compute })`: a
 * deny-by-default `ApiNamespace` (shared by the mock and AWS runtimes through
 * `AuthBase`).
 *
 * The dispatcher calls a namespace's handler with the request context and then
 * resolves the method name on what it returns. Here that is a proxy over the
 * `public` methods:
 *
 * - a **public** name (one of the `public` factory's methods) resolves to that
 *   method, unchanged — no check, as in a plain `ApiNamespace`;
 * - **any other name** resolves to a function that first awaits the guard
 *   (`requireAuth`, or `requireRole` with `role`), then calls the `methods`
 *   factory — once, with the signed-in user — and only then looks the name up.
 *   A name `methods` doesn't define is answered "method not found", like an
 *   unknown name anywhere else.
 *
 * So nothing of `methods`, its factory body included, runs for an anonymous
 * caller, and an anonymous caller gets the same 401 for an existing protected
 * method and for a made-up name: the protected surface can't be enumerated
 * without a session. A name in both factories is refused (`NoSharedMethodNames`
 * at compile time; at every protected call at runtime, and in spec generation).
 *
 * The spec generator lists the methods through the namespace's discovery
 * handler (`API_NAMESPACE_DISCOVER`, from `@aws-blocks/core/bb-utils`): only it calls
 * `methods` without a session, with a placeholder user, and it is never called
 * to serve a request.
 *
 * @internal
 */

import type { ApiNamespaceOptions, BlocksContext, ScopeParent } from '@aws-blocks/core';
import { ApiError, ApiNamespace } from '@aws-blocks/core';
// Core's discovery-handler key: read by the spec generator only.
import { API_NAMESPACE_DISCOVER } from '@aws-blocks/core/bb-utils';
import type {
	ApiMethods,
	AuthenticatedUser,
	AuthOptions,
	ProtectedApi,
	ProtectHandlers,
	ProtectOptions,
} from './types.js';

/** JSON-RPC 2.0 "Method not found": the code core's dispatchers answer an unknown name with. */
const METHOD_NOT_FOUND = -32601;

/**
 * Names that never resolve to a protected method: a `then` would make the
 * method map a thenable to anything that awaits it, and `toJSON` would change
 * how it serializes. (`Object.prototype` names are excluded separately.)
 */
const NEVER_PROTECTED: ReadonlySet<string> = new Set(['then', 'toJSON']);

/**
 * The `ApiNamespace` options in `protect`'s options: everything but `role`
 * (protect's own), passed on as is — so an `ApiNamespace` option added later
 * reaches the namespace with no change here. `undefined` when no options were
 * given, as `new ApiNamespace(scope, name, handler)` would get. Shared by the
 * runtime and CDK entries.
 */
export function apiNamespaceOptionsOf<O extends AuthOptions>(
	options: ProtectOptions<O> | undefined,
): ApiNamespaceOptions | undefined {
	if (!options) return undefined;
	const { role: _role, ...namespaceOptions } = options;
	return namespaceOptions;
}

/**
 * The callable API methods of a handler's returned object, as the RPC
 * dispatcher sees them: its own enumerable function properties and, for a
 * class instance, functions on its prototype chain (never `constructor` or a
 * name `Object.prototype` defines).
 */
export function apiMethodNames(methods: object): string[] {
	const names = new Set<string>();
	for (const [key, value] of Object.entries(methods)) {
		if (typeof value === 'function') names.add(key);
	}
	for (
		let proto = Object.getPrototypeOf(methods);
		proto && proto !== Object.prototype;
		proto = Object.getPrototypeOf(proto)
	) {
		for (const key of Object.getOwnPropertyNames(proto)) {
			if (key === 'constructor' || key in Object.prototype || Object.hasOwn(methods, key)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(proto, key);
			if (typeof descriptor?.value === 'function') names.add(key);
		}
	}
	return [...names];
}

/**
 * `source`'s callable methods as a plain object. With `bind`, each keeps
 * `source` as `this` (for a class instance); without, the functions are the
 * originals, as the spec generator needs to read their source.
 */
function methodMap(source: object, bind: boolean): ApiMethods {
	const map: ApiMethods = {};
	for (const key of apiMethodNames(source)) {
		// `apiMethodNames` lists functions only.
		const fn = Reflect.get(source, key) as ApiMethods[string];
		map[key] = bind ? fn.bind(source) : fn;
	}
	return map;
}

/** Throw when a name is both a public and a protected method. */
function assertNoSharedNames(namespace: string, publicNames: ReadonlySet<string>, protectedNames: string[]): void {
	const shared = protectedNames.filter((n) => publicNames.has(n));
	if (shared.length > 0) {
		throw new Error(
			`Auth.protect('${namespace}'): ${shared.map((n) => `'${n}'`).join(', ')} ` +
				`${shared.length === 1 ? 'is' : 'are'} defined in both \`public\` and \`methods\`. ` +
				'Define each method in one of them: in `public` it needs no session, in `methods` it does.',
		);
	}
}

/**
 * The user `methods` receives during spec generation only (see the module
 * comment): empty values of the right shape, never a real identity.
 */
function discoveryUser<O extends AuthOptions>(): AuthenticatedUser<O> {
	return { userId: '', username: '', userSub: '', groups: [], attributes: {}, signInProvider: 'password' };
}

/**
 * Build the namespace `auth.protect(scope, name, handlers, options)` returns.
 *
 * @param guard - Resolves the signed-in user or throws (401 / 403). Awaited once
 * per protected call, before the `methods` factory runs.
 */
export function protectNamespace<M extends ApiMethods, P extends ApiMethods, O extends AuthOptions>(
	guard: (context: BlocksContext, role: ProtectOptions<O>['role']) => Promise<AuthenticatedUser<O>>,
	scope: ScopeParent,
	name: string,
	handlers: ProtectHandlers<P, M, O>,
	options?: ProtectOptions<O>,
): ProtectedApi<P & M> {
	// The backend module is plain JavaScript once compiled: check the shape.
	if (typeof handlers?.methods !== 'function') {
		throw new Error(`Auth.protect('${name}'): \`methods\` must be a function \`(context, user) => ({ ... })\`.`);
	}
	if (handlers.public !== undefined && typeof handlers.public !== 'function') {
		throw new Error(`Auth.protect('${name}'): \`public\` must be a function \`(context) => ({ ... })\`.`);
	}
	const role = options?.role;
	const namespaceOptions = apiNamespaceOptionsOf(options);

	const publicMethods = (context: BlocksContext, bind: boolean): ApiMethods =>
		handlers.public ? methodMap(handlers.public(context), bind) : {};

	const notFound = (method: string) =>
		new ApiError(`Method not found: '${method}' on API '${name}'`, METHOD_NOT_FOUND);

	/** A protected call: the guard, then `methods` (once), then the name. */
	const protectedMethod =
		(context: BlocksContext, method: string, publicNames: ReadonlySet<string>) =>
		async (...args: unknown[]): Promise<unknown> => {
			const user = await guard(context, role);
			const methods = handlers.methods(context, user);
			const names = apiMethodNames(methods);
			assertNoSharedNames(name, publicNames, names);
			const fn: unknown = names.includes(method) ? Reflect.get(methods, method) : undefined;
			if (typeof fn !== 'function') throw notFound(method);
			return Reflect.apply(fn, methods, args);
		};

	const guarded = (context: BlocksContext): ApiMethods => {
		const target = publicMethods(context, true);
		const publicNames: ReadonlySet<string> = new Set(Object.keys(target));
		return new Proxy(target, {
			get(t, key, receiver) {
				if (
					typeof key !== 'string' ||
					Object.hasOwn(t, key) ||
					key in Object.prototype ||
					NEVER_PROTECTED.has(key)
				) {
					return Reflect.get(t, key, receiver);
				}
				return protectedMethod(context, key, publicNames);
			},
		});
	};

	const namespace = new ApiNamespace(scope, name, guarded, namespaceOptions);
	// Spec generation only (see the module comment): every method, public and protected.
	Reflect.set(namespace, API_NAMESPACE_DISCOVER, (context: BlocksContext): ApiMethods => {
		const pub = publicMethods(context, false);
		const prot = methodMap(handlers.methods(context, discoveryUser<O>()), false);
		assertNoSharedNames(name, new Set(Object.keys(pub)), Object.keys(prot));
		return { ...pub, ...prot };
	});
	// The proxy resolves exactly the methods `ProtectedApi<P & M>` describes:
	// `P`'s directly, `M`'s after the guard.
	return namespace as unknown as ProtectedApi<P & M>;
}
