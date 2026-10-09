// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The local user pool's persisted state: `.bb-data/<fullId>/state.json`, plus
 * verification codes (`last-code.json`, the `codeDelivery` hook), sign-in
 * challenges and the synthetic tokens the mock mints.
 *
 * ## On-disk format — `AuthCognito`'s, read as-is
 *
 * `state.json` is exactly the file `AuthCognito`'s mock writes:
 * `{ users, groups, codes, challenges, sessionSecret }`, each user
 * `{ userSub, password, confirmed, disabled, attributes, mfaPreference,
 * totpSharedSecret?, totpVerified, devices, passkeys?, forcePasswordChange? }`.
 * An app that switches `AuthCognito` → `Auth` with the same id therefore keeps
 * its local users, groups, MFA enrolments, devices and passkeys — and, because
 * `sessionSecret` is the same field `AuthBase` signs cookies with, its
 * signed-in sessions. `Auth` adds two optional user fields
 * (`passwordResetRequired`, `tokenRevision`) that `AuthCognito` ignores, and
 * keeps any top-level key it does not recognise, so the file stays readable by
 * `AuthCognito` (rollback).
 *
 * ## Usernames
 *
 * `users` is keyed by the Cognito `Username`. On a username-attribute pool
 * (`signInWith` without `'username'`) that is a generated id equal to
 * `userSub`, as Cognito generates it; elsewhere it is the username the user
 * chose. Callers' `Username` values are resolved the way Cognito resolves
 * them ({@link MockStore.resolve}). Users written by `AuthCognito`'s mock or an
 * earlier `Auth` on a username-attribute pool are keyed by their email / phone:
 * they are kept and sign in unchanged (see `DESIGN.md`, "Mock vs AWS").
 *
 * ## Tolerant loading
 *
 * Loading never throws. A file that does not parse, or is not a JSON object,
 * is moved aside to `state.json.corrupt-<ISO>` (never deleted) and the pool
 * starts empty; a field or record of the wrong shape is dropped. Both are
 * logged.
 *
 * Mock-only, never imported by the AWS or browser entries.
 *
 * @internal
 */

import crypto from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { WRONG_CODE_MESSAGE } from '../enumeration.js';
import { AuthErrors } from '../errors.js';
import { decodeJwtPayload } from '../sessions.js';
import { type ContactAttribute, type SignInMode, signsInWithAttribute } from '../sign-in-mode.js';
import type {
	CodeDeliveryFn,
	CodeDeliveryPurpose,
	DeviceRecord,
	MfaFactor,
	PasswordPolicy,
	SignInNextStep,
} from '../types.js';
import type { PoolTokens } from './types.js';

/** Verification-code lifetime (`AuthCognito`'s mock): 10 minutes. */
export const CODE_TTL_MS = 600_000;
/** Sign-in challenge lifetime (Cognito's): 3 minutes. */
export const CHALLENGE_TTL_MS = 180_000;
/** ID / access token lifetime (Cognito's default): 1 hour. Expired tokens are refreshed through the engine. */
export const TOKEN_TTL_SECONDS = 3600;
/** Access-token claim carrying the user's token revision (see {@link MockUserRecord.tokenRevision}). */
export const REVISION_CLAIM = 'mock_token_revision';

/** A registered passkey (mock). `createdAt` is ms since the epoch, as `AuthCognito` stores it. */
export interface MockPasskeyRecord {
	credentialId: string;
	friendlyName?: string;
	createdAt: number;
	/**
	 * `Auth` only (L22) — the registration credential's `response.transports`,
	 * which Cognito records as `AuthenticatorTransports`. Absent in
	 * `AuthCognito`'s files.
	 */
	transports?: string[];
	/** `Auth` only (L22) — the registration credential's `authenticatorAttachment` (Cognito's `AuthenticatorAttachment`). */
	authenticatorAttachment?: string;
}

/** One local user, in `AuthCognito`'s format plus two optional `Auth` fields. */
export interface MockUserRecord {
	userSub: string;
	/** Plain text: local development only (documented in `DESIGN.md` and the README). */
	password: string;
	confirmed: boolean;
	disabled: boolean;
	/** `email`, `phone_number`, `custom:department`, … — stored as Cognito stores them. */
	attributes: Record<string, string>;
	mfaPreference: { enabled: MfaFactor[]; preferred?: MfaFactor | 'NOMFA' };
	totpSharedSecret?: string;
	totpVerified: boolean;
	devices: Record<string, DeviceRecord>;
	/**
	 * The mock does not run COSE signature verification on assertions: sign-in
	 * accepts any well-formed WebAuthn JSON whose `id` matches a registered
	 * `credentialId` (the "loose mock", chosen to avoid a runtime dependency on
	 * `@simplewebauthn/server`).
	 */
	passkeys?: MockPasskeyRecord[];
	/** Admin-created or temporary password: the next sign-in must choose a new one (`FORCE_CHANGE_PASSWORD`). */
	forcePasswordChange?: boolean;
	/** `Auth` only — `admin.resetUserPassword`: sign-in fails with `PasswordResetRequiredException` (`RESET_REQUIRED`). */
	passwordResetRequired?: boolean;
	/**
	 * `Auth` only — bumped by a global sign-out; tokens minted under an older
	 * revision are revoked (access-token calls fail, refresh returns `null`).
	 * Absent means 0, which is also the revision of `AuthCognito`'s tokens.
	 */
	tokenRevision?: number;
}

/** A pending verification code. */
export interface CodeRecord {
	code: string;
	/** Expiry, ms since the epoch. */
	exp: number;
}

/** A pending sign-in challenge, keyed by the `session` token handed to the client. */
export interface ChallengeRecord {
	username: string;
	step: SignInNextStep['name'];
	/** The secret offered by a `CONTINUE_SIGN_IN_WITH_TOTP_SETUP` challenge. */
	sharedSecret?: string;
	/** An EMAIL code challenge spawned by EMAIL MFA enrolment: success also enrols EMAIL. */
	isEmailSetup?: boolean;
	/** `'USER_AUTH'` when part of a choice-based sign-in. */
	flow?: 'USER_AUTH';
	/**
	 * A stand-in challenge for an unknown user (Cognito's
	 * `PreventUserExistenceErrors` behaviour): it can never succeed, and every
	 * answer fails exactly as a real user's wrong answer would.
	 */
	decoy?: boolean;
	/** Expiry, ms since the epoch. */
	exp: number;
}

/** The whole `state.json`. */
export interface MockState {
	users: Record<string, MockUserRecord>;
	/** Group name → member usernames. */
	groups: Record<string, string[]>;
	/** `<purpose>:<username>` (attribute codes: `attribute:<name>:<username>`) → code. */
	codes: Record<string, CodeRecord>;
	challenges: Record<string, ChallengeRecord>;
	/** The session-signing secret `AuthBase` reads (`readMockSessionSecret`). */
	sessionSecret: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service-shaped errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An error shaped like the Cognito SDK's: `name` is the exception name. The
 * mock throws these (not `ApiError`s) so `AuthBase` maps them through the very
 * same `toAuthApiError` path — status, `retriable` and enumeration masking —
 * as the Cognito engine's errors.
 *
 * @internal
 */
export function serviceError(name: string, message: string): Error {
	const e = new Error(message);
	e.name = name;
	return e;
}

/** @internal */
export const userNotFound = (): Error => serviceError(AuthErrors.UserNotFound, 'User does not exist.');

// ─────────────────────────────────────────────────────────────────────────────
// Parsing (tolerant)
// ─────────────────────────────────────────────────────────────────────────────

const MFA_FACTORS: ReadonlySet<string> = new Set(['SMS', 'TOTP', 'EMAIL']);

/** Define `key` as an own, enumerable property — safe for keys such as `__proto__` read from a file. */
function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringRecord(v: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!isRecord(v)) return out;
	for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
	return out;
}

function isMfaFactor(v: unknown): v is MfaFactor {
	return typeof v === 'string' && MFA_FACTORS.has(v);
}

function optionalString(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}

function parseDevice(v: unknown): DeviceRecord | null {
	if (!isRecord(v) || typeof v.deviceKey !== 'string') return null;
	const device: DeviceRecord = { deviceKey: v.deviceKey, attributes: stringRecord(v.attributes) };
	const group = optionalString(v.deviceGroupKey);
	if (group !== undefined) device.deviceGroupKey = group;
	const created = optionalString(v.createDate);
	if (created !== undefined) device.createDate = created;
	const modified = optionalString(v.lastModifiedDate);
	if (modified !== undefined) device.lastModifiedDate = modified;
	const authenticated = optionalString(v.lastAuthenticatedDate);
	if (authenticated !== undefined) device.lastAuthenticatedDate = authenticated;
	return device;
}

function parsePasskey(v: unknown): MockPasskeyRecord | null {
	if (!isRecord(v) || typeof v.credentialId !== 'string' || !v.credentialId) return null;
	const createdAt =
		typeof v.createdAt === 'number' ? v.createdAt : typeof v.createdAt === 'string' ? Date.parse(v.createdAt) : 0;
	const passkey: MockPasskeyRecord = {
		credentialId: v.credentialId,
		createdAt: Number.isFinite(createdAt) ? createdAt : 0,
	};
	const name = optionalString(v.friendlyName);
	if (name !== undefined) passkey.friendlyName = name;
	if (Array.isArray(v.transports)) {
		const transports = v.transports.filter((t): t is string => typeof t === 'string');
		if (transports.length > 0) passkey.transports = transports;
	}
	const attachment = optionalString(v.authenticatorAttachment);
	if (attachment) passkey.authenticatorAttachment = attachment;
	return passkey;
}

/**
 * One user record, or `null` when it is not one (`userSub` and `password` are
 * required; everything else defaults the way `AuthCognito` initialises it).
 *
 * @internal
 */
export function parseUser(v: unknown): MockUserRecord | null {
	if (!isRecord(v) || typeof v.userSub !== 'string' || !v.userSub || typeof v.password !== 'string') return null;
	const pref = isRecord(v.mfaPreference) ? v.mfaPreference : {};
	const enabled = Array.isArray(pref.enabled) ? pref.enabled.filter(isMfaFactor) : [];
	const preferred = pref.preferred === 'NOMFA' || isMfaFactor(pref.preferred) ? pref.preferred : undefined;
	const devices: Record<string, DeviceRecord> = {};
	if (isRecord(v.devices)) {
		for (const [key, raw] of Object.entries(v.devices)) {
			const device = parseDevice(raw);
			if (device) devices[key] = device;
		}
	}
	const user: MockUserRecord = {
		userSub: v.userSub,
		password: v.password,
		confirmed: v.confirmed === true,
		disabled: v.disabled === true,
		attributes: stringRecord(v.attributes),
		mfaPreference: { enabled, ...(preferred !== undefined ? { preferred } : {}) },
		totpVerified: v.totpVerified === true,
		devices,
	};
	const secret = optionalString(v.totpSharedSecret);
	if (secret !== undefined) user.totpSharedSecret = secret;
	if (Array.isArray(v.passkeys)) {
		user.passkeys = v.passkeys.map(parsePasskey).filter((p): p is MockPasskeyRecord => p !== null);
	}
	if (v.forcePasswordChange === true) user.forcePasswordChange = true;
	if (v.passwordResetRequired === true) user.passwordResetRequired = true;
	if (typeof v.tokenRevision === 'number' && Number.isInteger(v.tokenRevision) && v.tokenRevision > 0) {
		user.tokenRevision = v.tokenRevision;
	}
	return user;
}

const CHALLENGE_STEPS: ReadonlySet<string> = new Set<SignInNextStep['name']>([
	'CONFIRM_SIGN_IN_WITH_SMS_CODE',
	'CONFIRM_SIGN_IN_WITH_TOTP_CODE',
	'CONFIRM_SIGN_IN_WITH_EMAIL_CODE',
	'CONTINUE_SIGN_IN_WITH_MFA_SELECTION',
	'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION',
	'CONTINUE_SIGN_IN_WITH_TOTP_SETUP',
	'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP',
	'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED',
	'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION',
	'CONFIRM_SIGN_IN_WITH_PASSWORD',
	'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP',
	'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP',
	'CONFIRM_SIGN_IN_WITH_WEB_AUTHN',
	'RESET_PASSWORD',
	'CONFIRM_SIGN_UP',
]);

function isChallengeStep(v: unknown): v is SignInNextStep['name'] {
	return typeof v === 'string' && CHALLENGE_STEPS.has(v);
}

function parseChallenge(v: unknown): ChallengeRecord | null {
	if (!isRecord(v) || typeof v.username !== 'string' || !isChallengeStep(v.step) || typeof v.exp !== 'number') {
		return null;
	}
	const c: ChallengeRecord = { username: v.username, step: v.step, exp: v.exp };
	const secret = optionalString(v.sharedSecret);
	if (secret !== undefined) c.sharedSecret = secret;
	if (v.isEmailSetup === true) c.isEmailSetup = true;
	if (v.flow === 'USER_AUTH') c.flow = 'USER_AUTH';
	return c;
}

/** The keys of {@link MockState}; anything else in the file is preserved verbatim. */
const STATE_KEYS: ReadonlySet<string> = new Set(['users', 'groups', 'codes', 'challenges', 'sessionSecret']);

/**
 * Parse a decoded `state.json`. Never throws; `dropped` counts the records and
 * fields that were not of the expected shape.
 *
 * @internal
 */
export function parseState(raw: Record<string, unknown>): {
	state: MockState;
	extras: Record<string, unknown>;
	dropped: number;
} {
	let dropped = 0;
	const users: Record<string, MockUserRecord> = {};
	if (raw.users !== undefined && !isRecord(raw.users)) dropped++;
	for (const [username, value] of Object.entries(isRecord(raw.users) ? raw.users : {})) {
		const user = parseUser(value);
		if (user) setOwn(users, username, user);
		else dropped++;
	}
	const groups: Record<string, string[]> = {};
	for (const [name, members] of Object.entries(isRecord(raw.groups) ? raw.groups : {})) {
		if (Array.isArray(members)) {
			setOwn(
				groups,
				name,
				members.filter((m): m is string => typeof m === 'string'),
			);
		} else dropped++;
	}
	const codes: Record<string, CodeRecord> = {};
	for (const [key, value] of Object.entries(isRecord(raw.codes) ? raw.codes : {})) {
		if (isRecord(value) && typeof value.code === 'string' && typeof value.exp === 'number') {
			setOwn(codes, key, { code: value.code, exp: value.exp });
		} else dropped++;
	}
	const challenges: Record<string, ChallengeRecord> = {};
	for (const [token, value] of Object.entries(isRecord(raw.challenges) ? raw.challenges : {})) {
		const challenge = parseChallenge(value);
		if (challenge) setOwn(challenges, token, challenge);
		else dropped++;
	}
	const sessionSecret =
		typeof raw.sessionSecret === 'string' && raw.sessionSecret ? raw.sessionSecret : newSessionSecret();
	const extras: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) if (!STATE_KEYS.has(key)) setOwn(extras, key, value);
	return { state: { users, groups, codes, challenges, sessionSecret }, extras, dropped };
}

function newSessionSecret(): string {
	return crypto.randomBytes(32).toString('hex');
}

function emptyState(): MockState {
	return { users: {}, groups: {}, codes: {}, challenges: {}, sessionSecret: newSessionSecret() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokens
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A JWT-shaped string with `alg: 'none'` and a fixed placeholder signature —
 * `AuthCognito`'s mock token format. Nothing verifies it: the token is minted
 * here and stored in a session row reached only through the HMAC-signed
 * cookie, which is the whole trust chain (`AuthBase` decodes rows, it never
 * verifies them). `decodeJwtPayload` parses it like a real Cognito token.
 *
 * @internal
 */
export function mockJwt(payload: Record<string, unknown>): string {
	const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
	return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.mock-signature`;
}

/** The contact-verification flags, stored as the strings `'true'` / `'false'`. */
const VERIFIED_FLAGS = ['email_verified', 'phone_number_verified'] as const;

/**
 * A user's stored attributes as Cognito puts them in an ID token: every
 * attribute is a string claim except the `*_verified` flags, which are JSON
 * booleans there. So — as on AWS — they reach `getAuthSession`'s ID token and
 * `validateUser`'s `claims` as booleans and are not `requireAuth().attributes`
 * (which are the string claims); `getUserAttributes` reports them as strings
 * on both runtimes, as Cognito's `GetUser` does.
 *
 * Likewise `updated_at` (a `Number` attribute in Cognito's schema) is a JSON
 * number and `address` the OIDC address object `{ formatted }` (OIDC Core
 * §5.1; Cognito types these four claims itself — a pre-token-generation
 * trigger can't make any of them a complex object), so neither is a string
 * attribute either (FX31).
 */
function idTokenAttributeClaims(attributes: Record<string, string>): Record<string, unknown> {
	const claims: Record<string, unknown> = { ...attributes };
	for (const flag of VERIFIED_FLAGS) {
		const value = attributes[flag];
		if (value !== undefined) claims[flag] = value === 'true';
	}
	const updatedAt = attributes.updated_at;
	if (updatedAt !== undefined && /^\d+$/.test(updatedAt)) claims.updated_at = Number(updatedAt);
	const address = attributes.address;
	if (address !== undefined) claims.address = { formatted: address };
	return claims;
}

// ─────────────────────────────────────────────────────────────────────────────
// The store
// ─────────────────────────────────────────────────────────────────────────────

/** What the store needs from its host. */
export interface MockStoreOptions {
	/** `getMockDataDir(auth)` — `.bb-data/<fullId>/`. */
	dataDir: string;
	/** The `Auth` instance's `fullId` (token issuer / audience). */
	fullId: string;
	log: ChildLogger;
	/** The mock-only `codeDelivery` hook. */
	codeDelivery?: CodeDeliveryFn;
	/** `emailPassword.passwordPolicy`. */
	passwordPolicy?: PasswordPolicy;
	/** Group names to create (declared `users.groups`). */
	groups: readonly string[];
	/** `users.signInWith`, as Cognito splits it (`resolveSignInMode`). */
	signInMode: SignInMode;
}

/**
 * The persisted local user pool. Holds `state.json` in memory and writes it
 * back atomically (write-then-rename) after every mutation, so a restarted dev
 * server resumes where it was — including in-flight MFA challenges.
 *
 * @internal
 */
export class MockStore {
	readonly state: MockState;
	private readonly extras: Record<string, unknown>;
	private readonly file: string;
	private readonly lastCodeFile: string;

	constructor(private readonly opts: MockStoreOptions) {
		this.file = join(opts.dataDir, 'state.json');
		this.lastCodeFile = join(opts.dataDir, 'last-code.json');
		const { state, extras } = this.load();
		this.state = state;
		this.extras = extras;
		for (const name of opts.groups) this.state.groups[name] ??= [];
		this.warnLegacyUsernames();
		// Persist now: the session secret must be on disk before `AuthBase`
		// first reads it, and the declared groups must exist.
		this.flush();
	}

	private load(): { state: MockState; extras: Record<string, unknown> } {
		if (!existsSync(this.file)) return { state: emptyState(), extras: {} };
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(this.file, 'utf8'));
		} catch (e) {
			this.setAside('does not parse', e);
			return { state: emptyState(), extras: {} };
		}
		if (!isRecord(raw)) {
			this.setAside('is not a JSON object');
			return { state: emptyState(), extras: {} };
		}
		const { state, extras, dropped } = parseState(raw);
		if (dropped > 0) {
			this.opts.log.warn(
				`[bb-auth] ${dropped} malformed record(s) in '${this.file}' were ignored; the rest of the local user pool loaded`,
			);
		}
		return { state, extras };
	}

	/**
	 * On a username-attribute pool (`signInWith` without `'username'`), users
	 * written before the local pool generated usernames — by `AuthCognito`'s mock
	 * or an earlier `Auth` — are keyed by their email / phone. They are kept
	 * as-is (never re-keyed: `AuthCognito` must still read the file after a
	 * rollback) and still sign in, but their `username` / `userId` is that email
	 * / phone, where Cognito would have generated one equal to `userSub`. Say so
	 * once, so the difference is not a surprise.
	 */
	private warnLegacyUsernames(): void {
		if (this.opts.signInMode.usernameAttributes.length === 0) return;
		const legacy = Object.entries(this.state.users).filter(([username, u]) => username !== u.userSub);
		if (legacy.length === 0) return;
		this.opts.log.warn(
			`[bb-auth] ${legacy.length} local user(s) in '${this.file}' predate generated usernames: their username / userId stays the email or phone they signed up with, while on AWS Cognito generates one equal to userSub. They still sign in; delete and re-create them to match AWS.`,
		);
	}

	/** Move an unreadable state file aside (never delete it) and log where it went. */
	private setAside(reason: string, e?: unknown): void {
		const backup = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
		try {
			renameSync(this.file, backup);
			this.opts.log.warn(
				`[bb-auth] local user pool '${this.file}' ${reason}; preserved as '${backup}' and starting with an empty pool`,
				{ error: e instanceof Error ? e.message : undefined },
			);
		} catch {
			this.opts.log.warn(`[bb-auth] local user pool '${this.file}' ${reason}; starting with an empty pool`);
		}
	}

	/** Write `state.json` atomically. */
	flush(): void {
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, JSON.stringify({ ...this.extras, ...this.state }, null, 2));
		renameSync(tmp, this.file);
	}

	// ── Users & groups ──────────────────────────────────────────────────────

	/** The user stored under exactly `username` (the Cognito `Username`) — for internal keys such as a token's `username` claim. */
	user(username: string): MockUserRecord | undefined {
		return Object.hasOwn(this.state.users, username) ? this.state.users[username] : undefined;
	}

	/**
	 * The user a caller-supplied `login` names, as Cognito resolves the
	 * `Username` parameter: the username itself first; otherwise, on a
	 * username-attribute pool, the user whose `email` / `phone_number` it is
	 * (verified or not); on an alias pool, the user whose **verified** `email` /
	 * `phone_number` it is. Both runtimes keep that user unique (FX49: an alias
	 * is verified on one account only, and a username-attribute pool's email /
	 * phone is in use by one user only — {@link aliasHolders}); a state file
	 * written before FX49 may still hold duplicates, and then the last match wins.
	 */
	resolve(login: string): { username: string; user: MockUserRecord } | undefined {
		const direct = this.user(login);
		if (direct) return { username: login, user: direct };
		let found: { username: string; user: MockUserRecord } | undefined;
		for (const [username, user] of Object.entries(this.state.users)) {
			if (signsInWithAttribute(this.opts.signInMode, user.attributes, login)) found = { username, user };
		}
		return found;
	}

	/**
	 * The users other than `except` who hold `value` as their `attribute` sign-in
	 * attribute, as Cognito keeps it unique (FX49; developer guide, "Customizing
	 * sign-in attributes"): on a username-attribute pool, whoever has that
	 * email / phone, verified or not ("The email address or phone number must be
	 * unique … It doesn't have to be verified"); on an alias pool, whoever has
	 * it **verified** ("the value that you provide can be in a verified state in
	 * only one account"). Empty when nobody does, or when `attribute` is not a
	 * sign-in attribute of the pool; more than one only in a state file written
	 * before FX49.
	 */
	aliasHolders(attribute: ContactAttribute, value: string, except?: string): string[] {
		const { usernameAttributes, aliasAttributes } = this.opts.signInMode;
		const verifiedOnly = aliasAttributes.includes(attribute);
		if (!verifiedOnly && !usernameAttributes.includes(attribute)) return [];
		return Object.entries(this.state.users)
			.filter(
				([username, user]) =>
					username !== except &&
					user.attributes[attribute] === value &&
					(!verifiedOnly || user.attributes[`${attribute}_verified`] === 'true'),
			)
			.map(([username]) => username);
	}

	/** {@link resolve}, or `UserNotFoundException`. */
	requireResolved(login: string): { username: string; user: MockUserRecord } {
		const found = this.resolve(login);
		if (!found) throw userNotFound();
		return found;
	}

	/**
	 * The name a code is delivered for (`codeDelivery`, `last-code.json`, the
	 * log line): what the user signs in with. On a username-attribute pool that
	 * is their email / phone, not the generated username.
	 */
	signInNameOf(username: string): string {
		const user = this.user(username);
		if (!user) return username;
		for (const attr of this.opts.signInMode.usernameAttributes) {
			const value = user.attributes[attr];
			if (value) return value;
		}
		return username;
	}

	/**
	 * Add a user. Defined as an own property, so a username such as
	 * `__proto__` is stored like any other instead of rewriting the map's
	 * prototype.
	 */
	addUser(username: string, record: MockUserRecord): void {
		setOwn(this.state.users, username, record);
		this.flush();
	}

	requireUser(username: string): MockUserRecord {
		const user = this.user(username);
		if (!user) throw userNotFound();
		return user;
	}

	groupsOf(username: string): string[] {
		return Object.entries(this.state.groups)
			.filter(([, members]) => members.includes(username))
			.map(([name]) => name);
	}

	requireGroup(group: string): string[] {
		const members = Object.hasOwn(this.state.groups, group) ? this.state.groups[group] : undefined;
		if (!members) throw serviceError(AuthErrors.GroupNotFound, 'Group not found.');
		return members;
	}

	/** Remove a user and their group memberships, codes and challenges. */
	deleteUser(username: string): void {
		delete this.state.users[username];
		for (const group of Object.keys(this.state.groups)) {
			this.state.groups[group] = this.state.groups[group].filter((u) => u !== username);
		}
		for (const key of Object.keys(this.state.codes)) {
			if (key.endsWith(`:${username}`)) delete this.state.codes[key];
		}
		for (const [token, c] of Object.entries(this.state.challenges)) {
			if (c.username === username) delete this.state.challenges[token];
		}
		this.flush();
	}

	enforcePasswordPolicy(password: string): void {
		const p = this.opts.passwordPolicy ?? {};
		const missing: string[] = [];
		const minLength = p.minLength ?? 8;
		if (password.length < minLength) missing.push(`at least ${minLength} characters`);
		if (p.requireUppercase !== false && !/[A-Z]/.test(password)) missing.push('an uppercase letter');
		if (p.requireLowercase !== false && !/[a-z]/.test(password)) missing.push('a lowercase letter');
		if (p.requireDigits !== false && !/\d/.test(password)) missing.push('a digit');
		if (p.requireSymbols !== false && !/[^A-Za-z0-9]/.test(password)) missing.push('a symbol');
		if (missing.length > 0) {
			throw serviceError(AuthErrors.InvalidPassword, `Password must contain ${missing.join(', ')}`);
		}
	}

	/** A password that satisfies the default policy (upper, lower, digit, symbol, ≥ 8). */
	generateTemporaryPassword(): string {
		return `Aa1!${crypto.randomBytes(9).toString('base64url')}`;
	}

	// ── Codes ───────────────────────────────────────────────────────────────

	/**
	 * Issue a 6-digit code for `purpose`: store it, write `last-code.json`, and
	 * call the `codeDelivery` hook (else log it at info level). `username` is
	 * the stored username; the hook and the file receive {@link signInNameOf}.
	 */
	async generateCode(
		purpose: CodeDeliveryPurpose,
		username: string,
		key = `${purpose}:${username}`,
	): Promise<string> {
		const code = String(crypto.randomInt(100000, 1000000));
		this.state.codes[key] = { code, exp: Date.now() + CODE_TTL_MS };
		this.flush();
		const name = this.signInNameOf(username);
		this.writeLastCode(purpose, name, code);
		const deliver = this.opts.codeDelivery;
		if (deliver) {
			const delivered: Promise<void> = deliver(name, code, purpose);
			await delivered;
		} else this.opts.log.info(`[bb-auth] ${purpose} code for ${name}: ${code}`);
		return code;
	}

	/**
	 * Check and consume a code. A missing or wrong code is `CodeMismatchException`
	 * (with Cognito's wording, the same an unknown user gets on the confirm-code
	 * flows); an expired one is `ExpiredCodeException` and is discarded.
	 *
	 * `beforeConsume` runs once the code has matched, before it is consumed: a
	 * throw from it rejects the call and leaves the code valid (FX49: a
	 * confirmation the code allows but the pool refuses, such as an alias
	 * another user holds).
	 */
	verifyCode(key: string, code: string, beforeConsume?: () => void): void {
		const entry = Object.hasOwn(this.state.codes, key) ? this.state.codes[key] : undefined;
		if (!entry) throw serviceError(AuthErrors.CodeMismatch, WRONG_CODE_MESSAGE);
		if (entry.exp < Date.now()) {
			delete this.state.codes[key];
			this.flush();
			throw serviceError(AuthErrors.ExpiredCode, 'Invalid code provided, please request a code again.');
		}
		if (entry.code !== code) throw serviceError(AuthErrors.CodeMismatch, WRONG_CODE_MESSAGE);
		beforeConsume?.();
		delete this.state.codes[key];
		this.flush();
	}

	/**
	 * The most recent code, for e2e tests and `npm run dev` (no mailbox
	 * locally). Test scaffolding only — not secure storage; `.bb-data/` is
	 * gitignored. Overwritten on every code, so only the last one is visible.
	 */
	private writeLastCode(purpose: CodeDeliveryPurpose, username: string, code: string): void {
		writeFileSync(this.lastCodeFile, JSON.stringify({ username, code, purpose }, null, 2));
	}

	// ── Challenges ──────────────────────────────────────────────────────────

	/** Mint a challenge session token, persist the challenge, and bake the token into the step. */
	issueChallenge(
		username: string,
		step: SignInNextStep,
		extras: { isEmailSetup?: boolean; flow?: 'USER_AUTH'; decoy?: boolean } = {},
	): SignInNextStep {
		const token = crypto.randomBytes(16).toString('base64url');
		const record: ChallengeRecord = { username, step: step.name, exp: Date.now() + CHALLENGE_TTL_MS };
		if (step.name === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') record.sharedSecret = step.sharedSecret;
		if (extras.isEmailSetup) record.isEmailSetup = true;
		if (extras.flow) record.flow = extras.flow;
		if (extras.decoy) record.decoy = true;
		this.state.challenges[token] = record;
		this.flush();
		if (step.name === 'RESET_PASSWORD' || step.name === 'CONFIRM_SIGN_UP') return step;
		return { ...step, session: token };
	}

	/** The live challenge for `token`, or `ExpiredCodeException` (expired ones are discarded). */
	challenge(token: string): ChallengeRecord {
		const c = Object.hasOwn(this.state.challenges, token) ? this.state.challenges[token] : undefined;
		if (!c || c.exp < Date.now()) {
			if (c) {
				delete this.state.challenges[token];
				this.flush();
			}
			throw serviceError(AuthErrors.ExpiredCode, 'Invalid session for the user, session is expired.');
		}
		return c;
	}

	consumeChallenge(token: string): void {
		delete this.state.challenges[token];
		this.flush();
	}

	// ── Tokens ──────────────────────────────────────────────────────────────

	/**
	 * Mint Cognito-shaped tokens for `username`. `authTime` (seconds) is kept
	 * across refreshes, as Cognito keeps `auth_time`, so `requireAuth({ fresh })`
	 * measures the sign-in, not the last refresh.
	 */
	mintTokens(username: string, user: MockUserRecord, opts: { authTime?: number; refreshToken?: string } = {}) {
		const now = Math.floor(Date.now() / 1000);
		const common = {
			iss: `https://mock.bb-auth.local/${this.opts.fullId}`,
			sub: user.userSub,
			iat: now,
			exp: now + TOKEN_TTL_SECONDS,
			auth_time: opts.authTime ?? now,
		};
		const tokens: PoolTokens = {
			idToken: mockJwt({
				...idTokenAttributeClaims(user.attributes),
				...common,
				aud: `mock-client-${this.opts.fullId}`,
				token_use: 'id',
				'cognito:username': username,
				'cognito:groups': this.groupsOf(username),
			}),
			accessToken: mockJwt({
				...common,
				client_id: `mock-client-${this.opts.fullId}`,
				token_use: 'access',
				scope: 'aws.cognito.signin.user.admin',
				username,
				jti: crypto.randomUUID(),
				[REVISION_CLAIM]: user.tokenRevision ?? 0,
			}),
			refreshToken: opts.refreshToken ?? `mock-refresh-${crypto.randomBytes(16).toString('hex')}`,
		};
		return tokens;
	}

	/**
	 * The user an access token belongs to, checked the way Cognito checks one:
	 * the user still exists (same `sub` — a re-created username is a different
	 * user), is enabled, the token is unexpired and not revoked by a global
	 * sign-out.
	 *
	 * @throws `UserNotFoundException` when the user is gone; `NotAuthorizedException` otherwise.
	 */
	userForAccessToken(accessToken: string): { username: string; user: MockUserRecord } {
		const claims = decodeJwtPayload(accessToken);
		const username = typeof claims?.username === 'string' ? claims.username : '';
		const user = username ? this.user(username) : undefined;
		if (!claims || !user || user.userSub !== claims.sub) throw userNotFound();
		if (user.disabled) throw serviceError(AuthErrors.NotAuthorized, 'User is disabled.');
		const exp = typeof claims.exp === 'number' ? claims.exp : 0;
		if (exp * 1000 < Date.now()) throw serviceError(AuthErrors.NotAuthorized, 'Access Token has expired');
		if (revisionOf(claims) < (user.tokenRevision ?? 0)) {
			throw serviceError(AuthErrors.NotAuthorized, 'Access Token has been revoked');
		}
		return { username, user };
	}
}

/** The token revision an access token was minted under (0 for `AuthCognito`'s tokens). */
export function revisionOf(claims: Record<string, unknown>): number {
	const rev = claims[REVISION_CLAIM];
	return typeof rev === 'number' && Number.isInteger(rev) ? rev : 0;
}
