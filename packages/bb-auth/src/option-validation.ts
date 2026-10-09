// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Construction-time rejection of unknown and misplaced `Auth` options (D1b).
 *
 * `Auth<const O extends AuthOptions>` infers `O` from the options literal, and
 * TypeScript performs no excess-property check on an inferred generic. Without
 * this check, `{ emailPasword: false }` (a typo) or a top-level
 * `{ preferredChallenge: 'EMAIL_OTP' }` (it belongs under `users`) compiles and
 * is silently ignored — a security setting the developer believes is on simply
 * does not apply. Plain JavaScript callers get no compile-time check at all.
 *
 * Every entry point (mock, AWS, CDK) calls {@link assertKnownAuthOptions} at
 * construction, so the same configuration fails the same way in `npm run dev`,
 * at synth and in Lambda.
 *
 * **Boolean options are type-checked too** (FX53, R85). Each layer reads a boolean
 * option by truthiness or by `!== false`, so a non-boolean value from an
 * untyped caller decided the setting by accident: `selfSignUp: 0` enabled
 * self-service sign-up (`0 !== false`), `passkeys: 'false'` enabled passkeys.
 * Every option typed `boolean` must be `true`, `false` or omitted; a group
 * with a boolean shorthand (`emailPassword`, `passkeys`) must be a boolean or
 * an options object. Other values (strings, numbers, references) are not
 * type-checked.
 *
 * **One source of truth.** The known keys are the {@link AUTH_OPTIONS_SHAPE}
 * tree below. Each node is declared with `satisfies ShapeOf<T>` against the
 * matching interface in `types.ts`, which requires exactly the keys of `T`: a
 * key added to or removed from `types.ts` without the same change here fails
 * the build (missing key → TS1360, stray key → TS1360 / excess property).
 *
 * Pure and dependency-free.
 *
 * @internal
 */

import type { ChildLogger } from '@aws-blocks/bb-logger';
import type {
	AdminOptions,
	AppleCredentials,
	AppSettingRef,
	AuthMockOptions,
	CognitoOidcProviderOptions,
	DirectOidcProviderOptions,
	EmailPasswordOptions,
	ExternalUserPoolRef,
	HostedUiOptions,
	MfaOptions,
	OAuth2ProviderOptions,
	OAuthCredentials,
	OidcProviderBase,
	PasskeyOptions,
	PasswordPolicy,
	ProviderCommon,
	RedirectOptions,
	SamlProviderOptions,
	SessionOptions,
	SocialProviders,
	StubIdpSettings,
	StubOidcProviderOptions,
	StubUser,
	UserAttribute,
	UserPoolOptions,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shape tree
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How the validator treats one option's value.
 *
 * - `'value'` — not inspected: primitives, functions, string arrays, and
 *   reference objects (`AppSettingRef`, `Auth.fromExisting()`'s
 *   `ExternalUserPoolRef`, a `Logger`) whose own members are not options.
 * - `'boolean'` — must be `true`, `false` or `undefined`.
 * - `{ object }` — when the value is a plain object, its keys must be in the
 *   shape. Any other value (`true`, `'optional'`, `false`) is left alone, so
 *   `emailPassword: true`, `mfa: 'required'` and `passkeys: false` pass.
 *   `otherwise` is the hint for an unknown key with no close match. With
 *   `orBoolean`, a value that is not an object must be a boolean (or
 *   `undefined`): the group's shorthand.
 * - `{ record }` — user-chosen keys (provider ids): each *value* is checked.
 * - `{ array }` — each element is checked.
 * - `{ variants }` — the shape depends on the value (an OIDC provider's
 *   `federateVia` selects its engine and so its accepted keys).
 */
type Spec =
	| 'value'
	| 'boolean'
	| { readonly object: Shape; readonly otherwise?: string; readonly orBoolean?: true }
	| { readonly record: Spec }
	| { readonly array: Spec }
	| { readonly variants: Variants };

interface Shape {
	readonly [key: string]: Spec;
}

interface Variant {
	/** Completes "is not accepted …", e.g. "with `federateVia: 'cognito'`". */
	readonly label: string;
	readonly shape: Shape;
}

interface Variants {
	readonly select: (value: object) => string;
	readonly cases: { readonly [name: string]: Variant };
}

/** Every key of every member of `T`. */
type KeysOf<T> = T extends unknown ? keyof T : never;

/** `T[K]` across every member of `T` that has `K`. */
type PropOf<T, K> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;

/** Values whose members are not options: references and callbacks. (Branded strings such as `RelayOrigin` are primitives.) */
type Opaque = AppSettingRef | ExternalUserPoolRef | ChildLogger | ((...args: never[]) => unknown);

/**
 * `true` (possibly as part of `boolean`) when `V` is, or contains, an options
 * group whose keys must be checked: an object type, an array of one, or a
 * record of one. Free-form records (`attributeMapping`, `StubUser.extra`) and
 * {@link Opaque} references are not groups.
 */
type IsGroup<V> = V extends Opaque | string | number | boolean | bigint | symbol
	? false
	: V extends readonly (infer E)[]
		? IsGroup<E>
		: V extends object
			? string extends keyof V
				? IsGroup<V[string]>
				: true
			: false;

/** A group whose shorthand is a boolean (`emailPassword: true`, `passkeys: false`). */
interface GroupOrBooleanSpec {
	readonly object: Shape;
	readonly otherwise?: string;
	readonly orBoolean: true;
}

/**
 * An options group must be walked (not `'value'`), so its own keys are checked
 * too; a group that also accepts a boolean must type-check it (`orBoolean`).
 * A `boolean` option must be `'boolean'`, so its value is type-checked.
 */
type SpecFor<V> =
	true extends IsGroup<NonNullable<V>>
		? [Extract<NonNullable<V>, boolean>] extends [never]
			? Exclude<Spec, 'value' | 'boolean'>
			: GroupOrBooleanSpec
		: [NonNullable<V>] extends [boolean]
			? 'boolean'
			: Exclude<Spec, 'boolean'>;

/**
 * Exactly the keys of `T`, each required, a walked spec for every key whose
 * type is an options group, and `'boolean'` for every `boolean` option. Used
 * with `satisfies`, so the shape literal must list every option of `T`,
 * nothing else, must descend into every group and must type-check every
 * boolean.
 */
type ShapeOf<T> = { readonly [K in KeysOf<T>]-?: SpecFor<PropOf<T, K>> };

const PROVIDER_COMMON = {
	scopes: 'value',
	attributeMapping: 'value',
	label: 'value',
} as const satisfies ShapeOf<ProviderCommon>;

const OAUTH_SOCIAL = {
	...PROVIDER_COMMON,
	clientId: 'value',
	clientSecret: 'value',
} as const satisfies ShapeOf<OAuthCredentials & ProviderCommon>;

const APPLE_SOCIAL = {
	...PROVIDER_COMMON,
	clientId: 'value',
	teamId: 'value',
	keyId: 'value',
	privateKey: 'value',
} as const satisfies ShapeOf<AppleCredentials & ProviderCommon>;

const SOCIAL_PROVIDERS = {
	google: { object: OAUTH_SOCIAL },
	facebook: { object: OAUTH_SOCIAL },
	amazon: { object: OAUTH_SOCIAL },
	apple: { object: APPLE_SOCIAL },
} as const satisfies ShapeOf<SocialProviders>;

const OIDC_ENDPOINTS = {
	authorization: 'value',
	token: 'value',
	userInfo: 'value',
	jwks: 'value',
} as const satisfies ShapeOf<NonNullable<OidcProviderBase['endpoints']>>;

const OIDC_BASE = {
	...PROVIDER_COMMON,
	issuer: 'value',
	clientId: 'value',
	endpoints: { object: OIDC_ENDPOINTS },
} as const satisfies ShapeOf<OidcProviderBase>;

const OAUTH2_ENDPOINTS = {
	authorization: 'value',
	token: 'value',
	userInfo: 'value',
} as const satisfies ShapeOf<OAuth2ProviderOptions['oauth2']['endpoints']>;

const OAUTH2 = {
	endpoints: { object: OAUTH2_ENDPOINTS },
	mapClaims: 'value',
} as const satisfies ShapeOf<OAuth2ProviderOptions['oauth2']>;

const STUB_USER = {
	sub: 'value',
	email: 'value',
	name: 'value',
	extra: 'value',
} as const satisfies ShapeOf<StubUser>;

const STUB_IDP = {
	users: { array: { object: STUB_USER } },
	onAuthorize: 'value',
	unsafeAllowDeployed: 'boolean',
} as const satisfies ShapeOf<StubIdpSettings>;

/** A directly federated provider: plain OIDC, `github()` / `customOauth2()`, or `stubIdp()`. */
const DIRECT_OIDC = {
	...OIDC_BASE,
	federateVia: 'value',
	clientSecret: 'value',
	groupsClaim: 'value',
	oauth2: { object: OAUTH2 },
	stubIdp: { object: STUB_IDP },
} as const satisfies ShapeOf<DirectOidcProviderOptions | OAuth2ProviderOptions | StubOidcProviderOptions>;

const COGNITO_OIDC = {
	...OIDC_BASE,
	federateVia: 'value',
	clientSecret: 'value',
	attributesRequestMethod: 'value',
} as const satisfies ShapeOf<CognitoOidcProviderOptions>;

const OIDC_PROVIDER: Spec = {
	variants: {
		select: (value) => (Reflect.get(value, 'federateVia') === 'cognito' ? 'cognito' : 'direct'),
		cases: {
			direct: {
				label: "on a directly federated provider (`federateVia: 'direct'`, the default)",
				shape: DIRECT_OIDC,
			},
			cognito: { label: "with `federateVia: 'cognito'`", shape: COGNITO_OIDC },
		},
	},
};

const SAML_PROVIDER = {
	...PROVIDER_COMMON,
	metadataUrl: 'value',
	metadataFile: 'value',
	signRequest: 'boolean',
} as const satisfies ShapeOf<SamlProviderOptions>;

const PASSWORD_POLICY = {
	minLength: 'value',
	requireUppercase: 'boolean',
	requireLowercase: 'boolean',
	requireDigits: 'boolean',
	requireSymbols: 'boolean',
} as const satisfies ShapeOf<PasswordPolicy>;

const EMAIL_PASSWORD = {
	selfSignUp: 'boolean',
	passwordPolicy: { object: PASSWORD_POLICY },
	autoSignIn: 'boolean',
	revealExistingUsers: 'boolean',
} as const satisfies ShapeOf<EmailPasswordOptions>;

const MFA = {
	mode: 'value',
	types: 'value',
} as const satisfies ShapeOf<MfaOptions>;

const PASSKEYS = {
	relyingPartyId: 'value',
	origins: 'value',
	userVerification: 'value',
} as const satisfies ShapeOf<PasskeyOptions>;

const USER_ATTRIBUTE = {
	name: 'value',
	type: 'value',
	mutable: 'boolean',
	required: 'boolean',
} as const satisfies ShapeOf<UserAttribute>;

const USER_GROUP = {
	name: 'value',
	description: 'value',
	precedence: 'value',
} as const satisfies ShapeOf<Exclude<NonNullable<UserPoolOptions['groups']>[number], string>>;

const DEVICE_TRACKING = {
	challengeRequiredOnNewDevice: 'boolean',
	deviceOnlyRememberedOnUserPrompt: 'boolean',
} as const satisfies ShapeOf<NonNullable<UserPoolOptions['deviceTracking']>>;

const USERS = {
	signInWith: 'value',
	attributes: { array: { object: USER_ATTRIBUTE } },
	// A string entry is a group name; an object entry is checked.
	groups: { array: { object: USER_GROUP } },
	authFlow: 'value',
	preferredChallenge: 'value',
	deviceTracking: { object: DEVICE_TRACKING },
} as const satisfies ShapeOf<UserPoolOptions>;

const SESSION = {
	ttlSeconds: 'value',
	crossDomain: 'boolean',
	freshAgeSeconds: 'value',
} as const satisfies ShapeOf<SessionOptions>;

const REDIRECTS = {
	callbackPath: 'value',
	signOutPath: 'value',
	postSignInPath: 'value',
	postSignOutPath: 'value',
	allowedRelayOrigins: 'value',
} as const satisfies ShapeOf<RedirectOptions>;

const HOSTED_UI = {
	domainPrefix: 'value',
} as const satisfies ShapeOf<HostedUiOptions>;

const ADMIN = {
	actions: 'value',
} as const satisfies ShapeOf<AdminOptions>;

/**
 * Every option `Auth` accepts, at every nesting level. `codeDelivery` is
 * mock-only ({@link AuthMockOptions}) but known to every entry: the backend
 * module type-checks against the mock's types and runs unchanged under the AWS
 * and CDK entries, which ignore it.
 *
 * @internal
 */
export const AUTH_OPTIONS_SHAPE = {
	emailPassword: { object: EMAIL_PASSWORD, orBoolean: true },
	socialProviders: {
		object: SOCIAL_PROVIDERS,
		otherwise:
			'socialProviders supports google, facebook, amazon and apple. Configure any other IdP under `oidcProviders` (`github()` for GitHub).',
	},
	oidcProviders: { record: OIDC_PROVIDER },
	samlProviders: { record: { object: SAML_PROVIDER } },
	mfa: { object: MFA },
	passkeys: { object: PASSKEYS, orBoolean: true },
	users: { object: USERS },
	validateUser: 'value',
	session: { object: SESSION },
	redirects: { object: REDIRECTS },
	hostedUi: { object: HOSTED_UI },
	admin: { object: ADMIN },
	allowBearerAuth: 'boolean',
	userPool: 'value',
	onSignIn: 'value',
	onSignOut: 'value',
	removalPolicy: 'value',
	deletionProtection: 'boolean',
	featurePlan: 'value',
	logger: 'value',
	codeDelivery: 'value',
} as const satisfies ShapeOf<AuthMockOptions>;

// ─────────────────────────────────────────────────────────────────────────────
// Walk
// ─────────────────────────────────────────────────────────────────────────────

/** One unknown option found in a configuration. */
export interface UnknownOption {
	/** Where it was found, e.g. `oidcProviders.okta.clientSecrt`. */
	readonly path: string;
	/** The offending key. */
	readonly key: string;
	/** A human-readable hint (`did you mean …?`), when one is available. */
	readonly hint?: string;
}

/** One option whose value has the wrong type (FX53). */
export interface InvalidOption {
	/** Where it was found, e.g. `emailPassword.selfSignUp`. */
	readonly path: string;
	/** What is wrong, e.g. ``must be `true` or `false`, got the number 0``. */
	readonly message: string;
}

/** Everything one walk finds. */
interface Findings {
	readonly unknown: UnknownOption[];
	readonly invalid: InvalidOption[];
}

function isPlainObject(value: unknown): value is object {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function join(path: string, key: string): string {
	if (IDENTIFIER.test(key)) return path ? `${path}.${key}` : key;
	return `${path}[${JSON.stringify(key)}]`;
}

/**
 * Where each key name is accepted, as display paths (`users.preferredChallenge`,
 * `oidcProviders.<id>.clientId`, `users.attributes[].name`). Built once from
 * the shape tree, for misplaced-option suggestions.
 */
function indexKnownPaths(): ReadonlyMap<string, readonly string[]> {
	const index = new Map<string, string[]>();
	const add = (key: string, path: string) => {
		const paths = index.get(key) ?? [];
		if (!paths.includes(path)) paths.push(path);
		index.set(key, paths);
	};
	const visitSpec = (spec: Spec, path: string): void => {
		if (spec === 'value' || spec === 'boolean') return;
		if ('object' in spec) visitShape(spec.object, path);
		else if ('record' in spec) visitSpec(spec.record, `${path}.<id>`);
		else if ('array' in spec) visitSpec(spec.array, `${path}[]`);
		else for (const variant of Object.values(spec.variants.cases)) visitShape(variant.shape, path);
	};
	const visitShape = (shape: Shape, path: string): void => {
		for (const [key, spec] of Object.entries(shape)) {
			const keyPath = path ? `${path}.${key}` : key;
			add(key, keyPath);
			visitSpec(spec, keyPath);
		}
	};
	visitShape(AUTH_OPTIONS_SHAPE, '');
	return index;
}

let knownPaths: ReadonlyMap<string, readonly string[]> | undefined;

/**
 * Edit distance counting an insertion, deletion, substitution or adjacent
 * transposition (`mdoe` → `mode`) as one edit (optimal string alignment).
 * Returns `max + 1` once the distance is known to exceed `max`.
 */
function editDistance(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
		Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i <= a.length; i++) {
		let rowMin = Number.POSITIVE_INFINITY;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let value = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				value = Math.min(value, d[i - 2][j - 2] + 1);
			}
			d[i][j] = value;
			rowMin = Math.min(rowMin, value);
		}
		if (rowMin > max) return max + 1;
	}
	return d[a.length][b.length];
}

const normalize = (key: string) => key.toLowerCase().replace(/[-_]/g, '');

/** How far a key may be from a known one to count as a likely typo. */
const typoBudget = (key: string) => (key.length <= 4 ? 1 : key.length <= 8 ? 2 : 3);

/** The closest of `candidates` to `key` within the typo budget, if any. */
function closest(key: string, candidates: Iterable<string>): string | undefined {
	const budget = typoBudget(key);
	let best: string | undefined;
	let bestDistance = budget + 1;
	for (const candidate of candidates) {
		const distance = normalize(candidate) === normalize(key) ? 0 : editDistance(key, candidate, budget);
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return best;
}

function formatPaths(paths: readonly string[]): string {
	const shown = paths.slice(0, 3).map((p) => `\`${p}\``);
	if (paths.length > 3) shown.push('…');
	return shown.length === 1 ? shown[0] : `one of ${shown.join(', ')}`;
}

/**
 * The hint for `key`, unknown under `parentPath` (whose known keys are `shape`'s).
 *
 * Order: a case-only or separator-only typo of a sibling; then the same key
 * where it does belong (a misplaced option); then a close sibling typo; then a
 * close key elsewhere (misplaced *and* misspelled).
 */
function hintFor(key: string, parentPath: string, shape: Shape): string | undefined {
	const siblingPath = (sibling: string) => join(parentPath, sibling);
	const siblings = Object.keys(shape);
	const sameButCase = siblings.find((s) => normalize(s) === normalize(key));
	if (sameButCase) return `did you mean \`${siblingPath(sameButCase)}\`?`;

	knownPaths ??= indexKnownPaths();
	const elsewhere = knownPaths.get(key);
	if (elsewhere) return `it is not an option here; did you mean ${formatPaths(elsewhere)}?`;

	const sibling = closest(key, siblings);
	if (sibling) return `did you mean \`${siblingPath(sibling)}\`?`;

	const near = closest(key, knownPaths.keys());
	const nearPaths = near === undefined ? undefined : knownPaths.get(near);
	if (nearPaths) return `did you mean ${formatPaths(nearPaths)}?`;
	return undefined;
}

/** The wrong value, for a message: ``the number 0``, ``the string "false"``, `` `null` ``, ``an array``. */
function describeValue(value: unknown): string {
	if (value === null) return '`null`';
	if (Array.isArray(value)) return 'an array';
	switch (typeof value) {
		case 'string':
			return `the string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`;
		case 'number':
		case 'bigint':
			return `the number ${String(value)}`;
		case 'function':
			return 'a function';
		case 'symbol':
			return 'a symbol';
		default:
			return 'an object';
	}
}

function walkSpec(spec: Spec, value: unknown, path: string, out: Findings): void {
	if (spec === 'value') return;
	if (spec === 'boolean') {
		if (value !== undefined && typeof value !== 'boolean') {
			out.invalid.push({ path, message: `must be \`true\` or \`false\`, got ${describeValue(value)}` });
		}
		return;
	}
	if ('object' in spec) {
		if (isPlainObject(value)) walkShape(spec.object, value, path, out, spec.otherwise);
		else if (spec.orBoolean && value !== undefined && typeof value !== 'boolean') {
			out.invalid.push({
				path,
				message: `must be \`true\`, \`false\` or an options object, got ${describeValue(value)}`,
			});
		}
		return;
	}
	if ('record' in spec) {
		if (!isPlainObject(value)) return;
		for (const [id, entry] of Object.entries(value)) walkSpec(spec.record, entry, join(path, id), out);
		return;
	}
	if ('array' in spec) {
		if (!Array.isArray(value)) return;
		for (const [i, entry] of value.entries()) walkSpec(spec.array, entry, `${path}[${i}]`, out);
		return;
	}
	if (!isPlainObject(value)) return;
	const { select, cases } = spec.variants;
	const selected = cases[select(value)];
	if (!selected) return;
	const before = out.unknown.length;
	walkShape(selected.shape, value, path, out);
	// A key another variant accepts is not a typo: say which variant it needs.
	for (let i = before; i < out.unknown.length; i++) {
		const issue = out.unknown[i];
		if (issue.path !== join(path, issue.key)) continue;
		const other = Object.values(cases).some((c) => c !== selected && Object.hasOwn(c.shape, issue.key));
		if (other) out.unknown[i] = { ...issue, hint: `\`${issue.key}\` is not accepted ${selected.label}` };
	}
}

function walkShape(shape: Shape, value: object, path: string, out: Findings, otherwise?: string): void {
	for (const [key, entry] of Object.entries(value)) {
		const keyPath = join(path, key);
		const spec = Object.hasOwn(shape, key) ? shape[key] : undefined;
		if (spec === undefined) {
			const hint = hintFor(key, path, shape) ?? otherwise;
			out.unknown.push(hint === undefined ? { path: keyPath, key } : { path: keyPath, key, hint });
			continue;
		}
		walkSpec(spec, entry, keyPath, out);
	}
}

/**
 * Every unknown or misplaced option in `options`, in declaration order.
 * Provider records are keyed by user-chosen ids, so their *values* are
 * checked, never their keys.
 *
 * @internal
 */
export function findUnknownAuthOptions(options: unknown): UnknownOption[] {
	return findAll(options).unknown;
}

/**
 * Every known option whose value has the wrong type, in declaration order: a
 * `boolean` option set to anything but `true` / `false`, or a group with a
 * boolean shorthand set to anything but a boolean or an object (FX53). Values
 * under an unknown key are not checked (the key is reported instead).
 *
 * @internal
 */
export function findInvalidAuthOptions(options: unknown): InvalidOption[] {
	return findAll(options).invalid;
}

function findAll(options: unknown): Findings {
	const out: Findings = { unknown: [], invalid: [] };
	if (isPlainObject(options)) walkShape(AUTH_OPTIONS_SHAPE, options, '', out);
	return out;
}

/**
 * Throw if `options` contains a key `Auth` does not know, at any nesting
 * level. Called by every entry's constructor before anything is registered.
 * Also throws if a boolean option has a non-boolean value (FX53; see
 * {@link findInvalidAuthOptions}).
 *
 * @param id - The block id, for the message.
 * @throws Error listing each unknown option with its path and, where one is
 *   close, a "did you mean …?" suggestion, then each wrong-typed value with
 *   its path and what it must be.
 * @internal
 */
export function assertKnownAuthOptions(id: string, options: unknown): void {
	if (options !== undefined && !isPlainObject(options)) {
		throw new Error(
			`Auth '${id}': options must be an object, got ${Array.isArray(options) ? 'an array' : typeof options}.`,
		);
	}
	const { unknown, invalid } = findAll(options);
	if (unknown.length === 0 && invalid.length === 0) return;
	const sections: string[] = [];
	const reasons: string[] = [];
	if (unknown.length > 0) {
		const lines = unknown.map((u) => `  - \`${u.path}\`${u.hint ? `: ${u.hint}` : ''}`);
		sections.push(`unknown option${unknown.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
		reasons.push(
			'Auth rejects options it does not recognise, so a misspelled or misplaced setting cannot be silently ignored.',
		);
	}
	if (invalid.length > 0) {
		const lines = invalid.map((v) => `  - \`${v.path}\` ${v.message}`);
		sections.push(`invalid option value${invalid.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
		reasons.push(
			"Auth checks the type of each boolean option, so a value such as `0` or `'false'` cannot silently turn a setting on or off.",
		);
	}
	throw new Error(
		`Auth '${id}': ${sections.join('\n')}\n${reasons.join(' ')} See AuthOptions for the supported options.`,
	);
}
