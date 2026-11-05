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
 * **Per-store rules.** A provider entry's accepted keys depend on its `type`
 * *and* the block's `store`: a `type: 'oidc'` entry takes `groupsClaim` only
 * with `store: 'builtin'`, `attributesRequestMethod` only on the default
 * Cognito store, and needs a `clientSecret` there. A key the same `type`
 * accepts on the other store is reported as a store conflict naming the store
 * it needs. A removed key (`socialProviders`, `oidcProviders`, `samlProviders`,
 * `federateVia`) is reported as unknown, with what replaced it as the hint.
 * The store value itself, a `type` the store does not accept and the
 * user-pool options a `'builtin'` block refuses are `resolveOptions()`'s to
 * reject (it runs right after this check, in every layer); the walk skips an
 * entry whose `type` its store does not accept, so the resolver's message is
 * the one reported.
 *
 * Pure and dependency-free.
 *
 * @internal
 */

import type { ChildLogger } from '@aws-blocks/bb-logger';
import type {
	AdminOptions,
	AmazonProvider,
	AppleProvider,
	AppSettingRef,
	AuthMockOptions,
	AuthStore,
	BearerAuthOptions,
	BuiltinProvider,
	CognitoOidcProvider,
	CognitoProvider,
	DirectOidcProvider,
	EmailPasswordOptions,
	EmailSenderOptions,
	ExternalUserPoolRef,
	FacebookProvider,
	GoogleProvider,
	HostedUiOptions,
	MfaOptions,
	OAuth2Provider,
	OidcProviderBase,
	PasskeyOptions,
	PasswordPolicy,
	ProviderCommon,
	RedirectOptions,
	SamlProvider,
	SecretRef,
	SessionOptions,
	StubIdpSettings,
	StubProvider,
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
 *   reference objects (`AppSettingRef`, `SecretRef`, `Auth.fromExisting()`'s
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
 * - `{ variants }` — the shape depends on the value: a provider's `type`,
 *   on the block's `store`, selects its accepted keys. An entry whose `type`
 *   the store does not accept is not walked (the resolver rejects it).
 */
type Spec =
	| 'value'
	| 'boolean'
	| { readonly object: Shape; readonly otherwise?: string; readonly orBoolean?: true }
	| { readonly record: Spec }
	| { readonly array: Spec }
	| { readonly variants: { readonly [S in AuthStore]: ShapesByType } };

interface Shape {
	readonly [key: string]: Spec;
}

/** The accepted keys of each provider `type` one store accepts. */
interface ShapesByType {
	readonly [type: string]: Shape;
}

/** Every key of every member of `T`. */
type KeysOf<T> = T extends unknown ? keyof T : never;

/** `T[K]` across every member of `T` that has `K`. */
type PropOf<T, K> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;

/**
 * Values whose members are not options: references, callbacks, and the option
 * error brands (`ERROR_needs_store_cognito<K>`). (Branded strings such as
 * `RelayOrigin` are primitives.)
 */
type Opaque =
	| AppSettingRef
	| SecretRef
	| ExternalUserPoolRef
	| ChildLogger
	| ((...args: never[]) => unknown)
	| { readonly __blocksOptionError: string };

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
 * Exactly the keys of `T` (except removed ones, see {@link IsRemovedOption}), each required, a walked spec for every key whose
 * type is an options group, and `'boolean'` for every `boolean` option. Used
 * with `satisfies`, so the shape literal must list every option of `T`,
 * nothing else, must descend into every group and must type-check every
 * boolean.
 */
type ShapeOf<T> = {
	readonly [K in KeysOf<T> as IsRemovedOption<PropOf<T, K>> extends true ? never : K]-?: SpecFor<PropOf<T, K>>;
};

/**
 * `true` for a key typed only as an option error (`ERROR_replaced_by_providers`,
 * `ERROR_federateVia_replaced_by_store`): declared so a leftover is a compile
 * error, but not an option, so the shape leaves it out and the walk reports it
 * as unknown.
 */
type IsRemovedOption<V> = [NonNullable<V>] extends [{ readonly __blocksOptionError: string }] ? true : false;

const PROVIDER_COMMON = {
	scopes: 'value',
	attributeMapping: 'value',
	label: 'value',
} as const satisfies ShapeOf<ProviderCommon>;

const OAUTH_SOCIAL = {
	...PROVIDER_COMMON,
	type: 'value',
	clientId: 'value',
	clientSecret: 'value',
} as const satisfies ShapeOf<GoogleProvider | FacebookProvider | AmazonProvider>;

const APPLE_SOCIAL = {
	...PROVIDER_COMMON,
	type: 'value',
	clientId: 'value',
	teamId: 'value',
	keyId: 'value',
	privateKey: 'value',
} as const satisfies ShapeOf<AppleProvider>;

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
} as const satisfies ShapeOf<OAuth2Provider['oauth2']['endpoints']>;

const OAUTH2 = {
	endpoints: { object: OAUTH2_ENDPOINTS },
	mapClaims: 'value',
} as const satisfies ShapeOf<OAuth2Provider['oauth2']>;

const STUB_USER = {
	sub: 'value',
	email: 'value',
	name: 'value',
	extra: 'value',
} as const satisfies ShapeOf<StubUser>;

const STUB_IDP = {
	users: { array: { object: STUB_USER } },
	onAuthorize: 'value',
} as const satisfies ShapeOf<StubIdpSettings>;

/** A `type: 'oidc'` provider of a `'cognito'` block: federated through the user pool. */
const COGNITO_OIDC = {
	...OIDC_BASE,
	type: 'value',
	clientSecret: 'value',
	attributesRequestMethod: 'value',
} as const satisfies ShapeOf<CognitoOidcProvider>;

/** A `type: 'oidc'` provider of a `store: 'builtin'` block: federated directly. */
const DIRECT_OIDC = {
	...OIDC_BASE,
	type: 'value',
	clientSecret: 'value',
	groupsClaim: 'value',
} as const satisfies ShapeOf<DirectOidcProvider>;

const OAUTH2_PROVIDER = {
	...OIDC_BASE,
	type: 'value',
	clientSecret: 'value',
	groupsClaim: 'value',
	oauth2: { object: OAUTH2 },
} as const satisfies ShapeOf<OAuth2Provider>;

const STUB_PROVIDER = {
	...OIDC_BASE,
	type: 'value',
	clientSecret: 'value',
	groupsClaim: 'value',
	stubIdp: { object: STUB_IDP },
} as const satisfies ShapeOf<StubProvider>;

const SAML_PROVIDER = {
	...PROVIDER_COMMON,
	type: 'value',
	metadataUrl: 'value',
	metadataFile: 'value',
	signRequest: 'boolean',
} as const satisfies ShapeOf<SamlProvider>;

/**
 * One `providers` entry: its `type`, on the block's store, selects the accepted
 * keys. Each store's map lists exactly the `type`s that store accepts; a `type`
 * it does not (or an unknown one) is the resolver's to reject.
 */
const PROVIDER: Spec = {
	variants: {
		cognito: {
			google: OAUTH_SOCIAL,
			facebook: OAUTH_SOCIAL,
			amazon: OAUTH_SOCIAL,
			apple: APPLE_SOCIAL,
			saml: SAML_PROVIDER,
			oidc: COGNITO_OIDC,
		} satisfies { readonly [T in CognitoProvider['type']]: Shape },
		builtin: {
			oidc: DIRECT_OIDC,
			oauth2: OAUTH2_PROVIDER,
			stub: STUB_PROVIDER,
		} satisfies { readonly [T in BuiltinProvider['type']]: Shape },
	},
};

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
	totpIssuer: 'value',
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
	caseSensitive: 'boolean',
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

const BEARER_AUTH = {
	clientIds: 'value',
} as const satisfies ShapeOf<BearerAuthOptions>;

const EMAIL_SENDER = {
	fromAddress: 'value',
	fromName: 'value',
	replyTo: 'value',
	sesRegion: 'value',
	sesVerifiedDomain: 'value',
	configurationSetName: 'value',
} as const satisfies ShapeOf<EmailSenderOptions>;

/**
 * Every option `Auth` accepts, at every nesting level. `codeDelivery` and
 * `totpVerification` are mock-only ({@link AuthMockOptions}) but known to every entry: the backend
 * module type-checks against the mock's types and runs unchanged under the AWS
 * and CDK entries, which ignore it.
 *
 * @internal
 */
export const AUTH_OPTIONS_SHAPE = {
	store: 'value',
	emailPassword: { object: EMAIL_PASSWORD, orBoolean: true },
	providers: { record: PROVIDER },
	mfa: { object: MFA },
	passkeys: { object: PASSKEYS, orBoolean: true },
	users: { object: USERS },
	validateUser: 'value',
	session: { object: SESSION },
	redirects: { object: REDIRECTS },
	hostedUi: { object: HOSTED_UI },
	admin: { object: ADMIN },
	allowBearerAuth: { object: BEARER_AUTH, orBoolean: true },
	userPool: 'value',
	onSignIn: 'value',
	onSignOut: 'value',
	removalPolicy: 'value',
	deletionProtection: 'boolean',
	featurePlan: 'value',
	email: { object: EMAIL_SENDER },
	logger: 'value',
	codeDelivery: 'value',
	totpVerification: 'value',
} as const satisfies ShapeOf<AuthMockOptions>;

// ─────────────────────────────────────────────────────────────────────────────
// Walk
// ─────────────────────────────────────────────────────────────────────────────

/** One unknown option found in a configuration. */
export interface UnknownOption {
	/** Where it was found, e.g. `providers.okta.clientSecrt`. */
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

/** One option the block's `store` does not allow (or requires): a provider key the other store accepts, a missing `clientSecret`. */
export interface StoreConflict {
	/** Where it was found, e.g. `providers.okta.groupsClaim`. */
	readonly path: string;
	/** What is wrong and the fix, e.g. ``needs `store: 'builtin'` …``. */
	readonly message: string;
}

/** Everything one walk finds. */
interface Findings {
	/** The block's store; `undefined` for a value the resolver rejects (provider entries are then not walked). */
	readonly store: AuthStore | undefined;
	readonly unknown: UnknownOption[];
	readonly invalid: InvalidOption[];
	readonly conflicts: StoreConflict[];
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
 * `providers.<id>.clientId`, `users.attributes[].name`). Built once from
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
		else
			for (const shapes of Object.values(spec.variants))
				for (const shape of Object.values(shapes)) visitShape(shape, path);
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
 * The hint for a removed option (typed only as an option error in `types.ts`,
 * so the shape leaves it out and the walk reports it as unknown): what replaced it.
 */
const REPLACED_OPTIONS: { readonly [key: string]: string } = {
	socialProviders:
		"replaced by `providers`: move each entry there, keyed as before, with its `type` (`'google'`, `'facebook'`, `'amazon'`, `'apple'`).",
	oidcProviders:
		"replaced by `providers`: move each entry there, keyed as before, with `type: 'oidc'`. A directly federated provider, `github()`, `customOauth2()` and `stubIdp()` go in a block with `store: 'builtin'`.",
	samlProviders: "replaced by `providers`: move each entry there, keyed as before, with `type: 'saml'`.",
	federateVia:
		"replaced by the block's `store`: remove it. `'cognito'` (the default) federates through Cognito; `store: 'builtin'` federates directly.",
};

/**
 * The hint for `key`, unknown under `parentPath` (whose known keys are `shape`'s).
 *
 * Order: a case-only or separator-only typo of a sibling; then a close sibling
 * typo; then the same key where it does belong (a misplaced option); then a
 * close key elsewhere (misplaced *and* misspelled). Siblings rank first
 * because a key under the right parent is far more often misspelled than
 * misplaced: `mfa: { type: [...] }` means `mfa.types`, not the unrelated
 * `users.attributes[].type`.
 */
function hintFor(key: string, parentPath: string, shape: Shape): string | undefined {
	if (Object.hasOwn(REPLACED_OPTIONS, key)) return REPLACED_OPTIONS[key];
	const siblingPath = (sibling: string) => join(parentPath, sibling);
	const siblings = Object.keys(shape);
	const sameButCase = siblings.find((s) => normalize(s) === normalize(key));
	if (sameButCase) return `did you mean \`${siblingPath(sameButCase)}\`?`;

	const sibling = closest(key, siblings);
	if (sibling) return `did you mean \`${siblingPath(sibling)}\`?`;

	knownPaths ??= indexKnownPaths();
	const elsewhere = knownPaths.get(key);
	if (elsewhere) return `it is not an option here; did you mean ${formatPaths(elsewhere)}?`;

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
	if (!isPlainObject(value) || out.store === undefined) return;
	const type = String(Reflect.get(value, 'type'));
	const shapes = spec.variants[out.store];
	const shape = Object.hasOwn(shapes, type) ? shapes[type] : undefined;
	if (!shape) return;
	const before = out.unknown.length;
	walkShape(shape, value, path, out);
	const otherStore: AuthStore = out.store === 'cognito' ? 'builtin' : 'cognito';
	const twin = Object.hasOwn(spec.variants[otherStore], type) ? spec.variants[otherStore][type] : undefined;
	const all = [...Object.values(shapes), ...Object.values(spec.variants[otherStore])];
	const found = out.unknown.splice(before);
	for (const issue of found) {
		if (issue.path !== join(path, issue.key)) out.unknown.push(issue);
		// A key the same `type` accepts on the other store: name the store it needs.
		else if (twin && Object.hasOwn(twin, issue.key)) {
			out.conflicts.push({ path: issue.path, message: NEEDS_STORE[otherStore] });
		}
		// A key another `type` accepts is not a typo: say which `type` it is not accepted on.
		else if (all.some((s) => s !== shape && Object.hasOwn(s, issue.key))) {
			out.unknown.push({ ...issue, hint: `\`${issue.key}\` is not accepted on a \`type: '${type}'\` provider` });
		} else out.unknown.push(issue);
	}
}

/** The message for a provider key only the other store accepts. */
const NEEDS_STORE: { readonly [S in AuthStore]: string } = {
	builtin:
		"needs `store: 'builtin'` (a directly federated provider). Remove it, or move the provider to a `store: 'builtin'` block.",
	cognito:
		"needs `store: 'cognito'`, the default (a provider federated through Cognito). Remove it, or move the provider to a block without `store: 'builtin'`.",
};

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

/**
 * Every option the block's `store` does not allow or requires, in walk order:
 * a provider key only the same `type` on the other store accepts
 * (`groupsClaim` on a `'cognito'` block's `type: 'oidc'` entry,
 * `attributesRequestMethod` on a `'builtin'` one), a `'cognito'` block's
 * `type: 'oidc'` entry without `clientSecret`, and `allowBearerAuth` as an
 * object on a `'builtin'` block. Empty for a `store` value the resolver rejects.
 *
 * @internal
 */
export function findStoreConflicts(options: unknown): StoreConflict[] {
	return findAll(options).conflicts;
}

function findAll(options: unknown): Findings {
	const storeValue = field(options, 'store');
	const store =
		storeValue === undefined
			? 'cognito'
			: storeValue === 'cognito' || storeValue === 'builtin'
				? storeValue
				: undefined;
	const out: Findings = { store, unknown: [], invalid: [], conflicts: [] };
	if (!isPlainObject(options)) return out;
	walkShape(AUTH_OPTIONS_SHAPE, options, '', out);
	// The store rules the shapes cannot express: a key the store requires, a form it does not take.
	const providers = field(options, 'providers');
	if (store === 'cognito' && isPlainObject(providers)) {
		for (const [id, entry] of Object.entries(providers)) {
			if (field(entry, 'type') === 'oidc' && field(entry, 'clientSecret') === undefined) {
				out.conflicts.push({
					path: join(join('providers', id), 'clientSecret'),
					message:
						"is required with `store: 'cognito'` (the default): Cognito federates OIDC as a confidential client. " +
						"Add one, or move the provider to a `store: 'builtin'` block for a public (PKCE-only) client.",
				});
			}
		}
	} else if (store === 'builtin' && isPlainObject(field(options, 'allowBearerAuth'))) {
		out.conflicts.push({
			path: 'allowBearerAuth',
			message:
				"as an object (extra Cognito app clients) needs `store: 'cognito'`. A `store: 'builtin'` block takes `true` or `false`.",
		});
	}
	return out;
}

/**
 * Throw if `options` contains a key `Auth` does not know, at any nesting
 * level. Called by every entry's constructor before anything is registered.
 * Also throws if a boolean option has a non-boolean value (FX53; see
 * {@link findInvalidAuthOptions}), and, once every key and value is valid, if
 * `emailPassword: false` is combined with an option only email + password
 * users can use (see {@link findPasswordOnlyOptions}).
 *
 * @param id - The block id, for the message.
 * @throws Error listing each unknown option with its path and, where one is
 *   close, a "did you mean …?" suggestion, then each wrong-typed value with
 *   its path and what it must be, then each option the block's `store` does
 *   not allow or requires (see {@link findStoreConflicts}).
 * @throws Error naming `emailPassword: false` and each option that needs
 *   email + password (`mfa` other than `'off'`, `passkeys`,
 *   `users.deviceTracking`).
 * @throws Error when `passkeys` is set without `users.authFlow: 'USER_AUTH'`.
 * @internal
 */
export function assertKnownAuthOptions(id: string, options: unknown): void {
	if (options !== undefined && !isPlainObject(options)) {
		throw new Error(
			`Auth '${id}': options must be an object, got ${Array.isArray(options) ? 'an array' : typeof options}.`,
		);
	}
	const { unknown, invalid, conflicts, store } = findAll(options);
	if (unknown.length === 0 && invalid.length === 0 && conflicts.length === 0) {
		assertConsistentOptions(id, options);
		return;
	}
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
	if (conflicts.length > 0) {
		const lines = conflicts.map((c) => `  - \`${c.path}\` ${c.message}`);
		sections.push(
			`${conflicts.length === 1 ? 'option conflicts' : 'options conflict'} with \`store: '${store}'\`:\n${lines.join('\n')}`,
		);
		reasons.push(
			"A `'cognito'` block (the default) federates through a Cognito user pool and a `store: 'builtin'` block verifies its providers itself, so each accepts different provider options.",
		);
	}
	throw new Error(
		`Auth '${id}': ${sections.join('\n')}\n${reasons.join(' ')} See AuthOptions for the supported options.`,
	);
}

/**
 * The options set in `options` that need email + password sign-in while
 * `emailPassword: false` disables it, in declaration order: `mfa` (other than
 * `'off'`), `passkeys` and `users.deviceTracking`. Cognito hands a federated
 * user's authentication entirely to their IdP, so these settings would apply
 * to nobody. Empty unless `emailPassword` is literally `false`.
 *
 * Before this check ran at construction, the contradiction passed in `npm run
 * dev` and surfaced at the call site as a mode-gate error naming the wrong
 * cause (`ERROR_mfa_is_off_on_this_Auth_instance` while the options say
 * `mfa: 'required'`); only synth rejected it.
 *
 * @internal
 */
export function findPasswordOnlyOptions(options: unknown): string[] {
	if (field(options, 'emailPassword') !== false) return [];
	const found: string[] = [];
	const mfa = field(options, 'mfa');
	const mode = isPlainObject(mfa) ? field(mfa, 'mode') : mfa;
	if (mode !== undefined && mode !== 'off') found.push(`mfa: '${String(mode)}'`);
	if (field(options, 'passkeys')) found.push('passkeys');
	if (field(field(options, 'users'), 'deviceTracking')) found.push('users.deviceTracking');
	return found;
}

/** `value[key]` when `value` is a plain object, else `undefined`. */
function field(value: unknown, key: string): unknown {
	return isPlainObject(value) ? Object.entries(value).find(([k]) => k === key)?.[1] : undefined;
}

function assertConsistentOptions(id: string, options: unknown): void {
	const found = findPasswordOnlyOptions(options);
	if (found.length > 0) {
		const list = found.map((f) => `\`${f}\``).join(', ');
		throw new Error(
			`Auth '${id}': ${list} ${found.length === 1 ? 'needs' : 'need'} email + password sign-in, which \`emailPassword: false\` disables. ` +
				'MFA, passkeys and device tracking apply only to email + password users; federated users get them from their identity provider. ' +
				'Remove the option, or re-enable email + password.',
		);
	}
	// The CDK layer's rule too, so the mock and AWS runtimes refuse it at construction rather than at sign-in.
	if (field(options, 'passkeys') && field(field(options, 'users'), 'authFlow') !== 'USER_AUTH') {
		throw new Error(
			`Auth '${id}': passkeys requires \`users.authFlow: 'USER_AUTH'\`. Passkeys ride on the USER_AUTH choice-based flow.`,
		);
	}
}
