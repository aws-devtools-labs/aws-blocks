// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shape-based credential redaction — the single redaction authority that every
 * data-browser read path passes through.
 *
 * WHY SHAPE-BASED, NOT A FIELD-NAME DENYLIST
 *
 * A field-NAME denylist fails open on every name it has not seen. The
 * implementation we model this on learned that from an incident: a
 * `<scope>-auth-users` store shipped bcrypt hashes to the browser because no
 * name token matched. Credential ENCODINGS are by contrast a closed,
 * self-describing set that travels with the value wherever it lands — a bcrypt
 * hash is recognisably a bcrypt hash under `displayName` just as much as under
 * `passwordHash`. So the value's SHAPE is the authority here, and the field
 * name (`SECRET_KEY_PATTERN`) is only a cheap over-approximation layered on
 * top of it.
 *
 * TWO REFERENCE DEFECTS THIS MODULE IS BUILT TO MAKE IMPOSSIBLE
 *
 * 1. The reference pbkdf2 pattern was `/^\$?pbkdf2[-_$]/i` — anchored to the
 *    start of the string — yet it was tested against `JSON.stringify(record)`,
 *    which always begins with `{` or `[`. It could therefore never match at
 *    that call site, and a pbkdf2 hash under a benign field name leaked. EVERY
 *    pattern below is consequently UNANCHORED and matches its shape anywhere
 *    in a string; `redact.test.ts` pins that by asserting the serialized form
 *    of a record for every shape, not just for pbkdf2.
 *
 * 2. The reference Cognito read path hardcoded `redacted: false` while
 *    applying no redaction at all, so the flag the UI trusted was a claim by
 *    the caller rather than a fact about the data. `redactValue` therefore
 *    RETURNS the flag next to the value, computed from what actually happened
 *    during the walk. There is no way for a caller to assert a redaction state
 *    that disagrees with reality, because callers do not get to assert it.
 */

/**
 * The mask. Deliberately NOT plain ASCII: the bullets make a masked cell
 * visually unmistakable in the data browser, and a test asserts the
 * non-ASCII-ness so a future regression to a plain `'REDACTED'` literal
 * cannot pass vacuously.
 */
export const REDACTED = '\u2022\u2022\u2022redacted\u2022\u2022\u2022';

/**
 * Field names whose value is masked wholesale, sub-objects included.
 *
 * `code` deliberately OVER-MATCHES (`zipcode`, `statusCode`, `countryCode`
 * all trip it) because the safe direction of error is masking benign data
 * rather than leaking a secret: an over-masked zip code is a cosmetic
 * annoyance a reader can work around, whereas a leaked one-time code or
 * authorization code is an incident.
 */
export const SECRET_KEY_PATTERN = /secret|token|password|hash|credential|challenge|session|auth|code/i;

/**
 * Above this length a string is masked outright — a blunt but
 * safe-direction proxy for opaque blobs (encrypted payloads, serialized
 * keys, base64 attachments) whose encoding we do not recognise.
 */
export const LONG_STRING_THRESHOLD = 120;

/**
 * Credential encodings. Every one is UNANCHORED on purpose — see defect 1 in
 * the module header. These must keep matching when the value is embedded in a
 * larger string such as `JSON.stringify(record)`.
 */

/** bcrypt: `$2a$`/`$2b$`/`$2y$`, a two-digit cost, then 53 base64-ish chars. */
const BCRYPT_PATTERN = /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/;

/** argon2 PHC strings: `$argon2i$`, `$argon2d$`, `$argon2id$`. */
const ARGON2_PATTERN = /\$argon2(?:id|i|d)\$/i;

/**
 * pbkdf2 hash strings. The delimiter after the algorithm name is what
 * separates a real encoded hash from prose that merely mentions pbkdf2, and it
 * covers the encodings in the wild: Django `pbkdf2_sha256$...`, passlib
 * `$pbkdf2-sha256$...`, PHP/Werkzeug `pbkdf2:sha256:...`.
 */
const PBKDF2_PATTERN = /pbkdf2[-_$:]/i;

/** JWT: three base64url segments, the first starting `eyJ` (i.e. `{"`). */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/;

/** PEM private-key armor, any key type (RSA, EC, OPENSSH, PKCS#8, ...). */
const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

/** AWS access key id: `AKIA`/`ASIA` plus 16 uppercase alphanumerics. */
const AWS_ACCESS_KEY_PATTERN = /(?:AKIA|ASIA)[0-9A-Z]{16}/;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
	BCRYPT_PATTERN,
	ARGON2_PATTERN,
	PBKDF2_PATTERN,
	JWT_PATTERN,
	PEM_PRIVATE_KEY_PATTERN,
	AWS_ACCESS_KEY_PATTERN,
];

/**
 * True when the string CONTAINS a recognised credential encoding anywhere.
 * Content only — the length heuristic is applied separately by `redactValue`,
 * and deliberately after this check, so a 60-char bcrypt hash under an
 * innocuous field name cannot survive by being short.
 */
export function looksSecret(value: string): boolean {
	return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/** A redacted (or verifiably untouched) value and whether anything was masked. */
export interface RedactionResult {
	value: unknown;
	redacted: boolean;
}

/** Plain records only. A `Date` or a class instance is not walked — enumerating it would destroy it. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * The bare-string rule: content check first, then the length cap.
 *
 * DELIBERATE DIVERGENCE FROM THE REFERENCE: the reference masks a bare
 * top-level string UNCONDITIONALLY. We do not. Our data browser renders
 * KVStore values that are frequently plain short strings such as `'hello'`,
 * `'en-GB'` or `'active'`, and blanking every one of them would make the
 * browser useless while protecting nothing — a short non-credential-shaped
 * string is not a credential. A bare top-level string therefore gets exactly
 * the same treatment as a nested one: shape check plus length cap, nothing
 * more. `redact.test.ts` pins both halves of that.
 */
function redactString(value: string): RedactionResult {
	if (looksSecret(value)) return { value: REDACTED, redacted: true };
	if (value.length > LONG_STRING_THRESHOLD) return { value: REDACTED, redacted: true };
	return { value, redacted: false };
}

function redactArray(value: readonly unknown[]): RedactionResult {
	let redacted = false;
	const result = value.map((element) => {
		const outcome = redactAny(element);
		if (outcome.redacted) redacted = true;
		return outcome.value;
	});
	return { value: result, redacted };
}

function redactRecord(value: Record<string, unknown>): RedactionResult {
	let redacted = false;
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		// A key-name match masks the WHOLE value at that key, sub-objects included:
		// we do not walk into `credentials: { ... }` hoping to recognise each leaf.
		if (SECRET_KEY_PATTERN.test(key)) {
			result[key] = REDACTED;
			redacted = true;
			continue;
		}
		const outcome = redactAny(entry);
		result[key] = outcome.value;
		if (outcome.redacted) redacted = true;
	}
	return { value: result, redacted };
}

function redactAny(value: unknown): RedactionResult {
	if (typeof value === 'string') return redactString(value);
	if (Array.isArray(value)) return redactArray(value);
	if (isPlainRecord(value)) return redactRecord(value);
	// Numbers, booleans, null, undefined and non-plain objects pass through.
	return { value, redacted: false };
}

/**
 * Redacts `value`, recursing through nested objects and arrays to arbitrary
 * depth, and reports whether anything was actually masked.
 *
 * Arrays map element-wise but do NOT get a blanket bare-string rule: masking
 * every string in `tags: ['alpha', 'beta']` renders rows of bullets and reads
 * as data loss rather than as protection. An element is masked only when it
 * individually looks secret, is over-long, or is a container holding something
 * that qualifies.
 *
 * Never mutates the input — every container is rebuilt.
 */
export function redactValue(value: unknown): RedactionResult {
	return redactAny(value);
}

/**
 * Redacts a data-browser record, treating the record's KEY as a field name.
 *
 * Why this exists, and why `redactValue` alone is not enough: the data browser
 * flattens an object-shaped store into one record per property, so an auth
 * `state.json` of `{ sessionSecret: 's3cr3t', users: {…} }` becomes a record
 * keyed `sessionSecret` whose value is the bare string. Inside the original
 * object that name matched {@link SECRET_KEY_PATTERN} and the value was masked;
 * after the split the name lives in `DataRecord.key`, outside the value, and
 * the name-based layer stopped applying. The flattening silently dropped a
 * protection.
 *
 * A short secret is also invisible to shape detection — `'s3cr3t'` has no
 * recognisable encoding — so the key name is the only signal left. Hence: a
 * record whose key looks secret is masked whole, and everything else is
 * delegated to the ordinary value walk.
 */
export function redactRecordValue(recordKey: string, value: unknown): RedactionResult {
	if (SECRET_KEY_PATTERN.test(recordKey)) {
		return { value: REDACTED, redacted: true };
	}
	return redactAny(value);
}

/**
 * Stores whose contents are an implementation detail of an auth or caching
 * flow: one-time codes, sessions, refresh tokens, MFA challenges, caches.
 *
 * Why this exists: these stores are usually EMPTY at rest (a code lives for
 * minutes, a cache entry expires), so opening one first makes a perfectly
 * healthy block look broken to whoever is looking at it. Later stages sort
 * ancillary stores last for that reason, so the store a reader lands on first
 * is one with data in it.
 */
export function isAncillaryStoreName(name: string): boolean {
	return /-(?:codes|sessions|tokens|challenges|cache)$/i.test(name);
}
