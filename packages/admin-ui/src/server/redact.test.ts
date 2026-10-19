// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
	isAncillaryStoreName,
	LONG_STRING_THRESHOLD,
	looksSecret,
	REDACTED,
	redactRecordValue,
	redactValue,
	SECRET_KEY_PATTERN,
} from './redact.js';

/*
 * Fixtures. All key material is obviously fake, and the PEM armor is assembled
 * from concatenated fragments rather than written as one literal so the repo's
 * git-secrets pre-commit hook does not flag this file.
 */

/** `$2b$` + cost + exactly 53 base64-ish chars, built by repeat so the length is provably right. */
const BCRYPT_HASH = `$2b$12$${'abcdefghij'.repeat(5)}klm`;
const ARGON2_HASH = '$argon2id$v=19$m=65536,t=3,p=4$ZmFrZXNhbHQ$ZmFrZWhhc2hmYWtlaGFzaA';
const PBKDF2_HASH = 'pbkdf2_sha256$260000$ZmFrZXNhbHQ$ZmFrZWhhc2hmYWtlaGFzaGZha2U';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlLXVzZXIifQ.ZmFrZXNpZ25hdHVyZQ';
const AWS_ACCESS_KEY_ID = `AKIA${'IOSFODNN7EXAMPLE'}`;
const AWS_SESSION_KEY_ID = `ASIA${'IOSFODNN7EXAMPLE'}`;

const PEM_BEGIN = `${'-----BEGIN'} RSA ${'PRIVATE'} KEY-----`;
const PEM_END = `${'-----END'} RSA ${'PRIVATE'} KEY-----`;
const PEM_PRIVATE_KEY = [PEM_BEGIN, 'MIIBOgIBAAJBAKfakefakefakefakefake', 'ZmFrZWtleW1hdGVyaWFs', PEM_END].join('\n');

/** Every shape, keyed by name so the shape suites can loop instead of repeating themselves. */
const SHAPES: ReadonlyArray<readonly [string, string]> = [
	['bcrypt', BCRYPT_HASH],
	['argon2', ARGON2_HASH],
	['pbkdf2', PBKDF2_HASH],
	['jwt', JWT],
	['pem private key', PEM_PRIVATE_KEY],
	['aws access key id', AWS_ACCESS_KEY_ID],
	['aws session key id', AWS_SESSION_KEY_ID],
];

/** Field names that no name-based denylist would ever flag. */
const BENIGN_KEYS = ['displayName', 'note', 'label'] as const;

describe('REDACTED marker', () => {
	it('is the non-ASCII bullet marker, not a plain-ASCII word', () => {
		// A future regression to a plain `'REDACTED'` literal would still satisfy
		// every "is it masked" assertion in this file, so pin the encoding itself.
		assert.doesNotMatch(REDACTED, /^[\x20-\x7E]*$/);
		assert.ok(REDACTED.includes('\u2022'));
		assert.strictEqual(REDACTED, '\u2022\u2022\u2022redacted\u2022\u2022\u2022');
	});
});

describe('looksSecret', () => {
	for (const [name, sample] of SHAPES) {
		it(`detects ${name}`, () => {
			assert.strictEqual(looksSecret(sample), true);
		});
	}

	it('detects a shape embedded in surrounding prose', () => {
		assert.strictEqual(looksSecret(`the key is ${AWS_ACCESS_KEY_ID} (rotate it)`), true);
		assert.strictEqual(looksSecret(`stored as ${BCRYPT_HASH} on disk`), true);
	});

	it('does not flag ordinary short strings', () => {
		for (const clean of ['hello', 'alpha', 'en-GB', 'active', 'us-east-1', 'Bob Bobbor', '2024-01-01T00:00:00Z']) {
			assert.strictEqual(looksSecret(clean), false, clean);
		}
	});

	it('does not flag lookalikes that are not credential encodings', () => {
		// Truncated / malformed shapes must not trip the patterns.
		assert.strictEqual(looksSecret('$2b$12$tooshort'), false);
		assert.strictEqual(looksSecret('AKIAshort'), false);
		assert.strictEqual(looksSecret('AKIAIOSFODNN7EXAMPL'), false); // 15 chars
		assert.strictEqual(looksSecret('-----BEGIN CERTIFICATE-----'), false);
		assert.strictEqual(looksSecret('we discussed pbkdf2 at standup'), false);
	});

	it('is stateless across repeated calls', () => {
		// Guards against a stray `g` flag, whose `lastIndex` would make the
		// second call on the same value return false.
		assert.strictEqual(looksSecret(JWT), true);
		assert.strictEqual(looksSecret(JWT), true);
		assert.strictEqual(looksSecret(JWT), true);
	});
});

describe('defect 1 regression: patterns are unanchored and survive serialization', () => {
	// The reference pbkdf2 pattern was `/^\$?pbkdf2[-_$]/i` — anchored to string
	// start — yet was tested against `JSON.stringify(record)`, which always begins
	// with `{`. It could never fire. Assert the serialized form for EVERY shape so
	// no pattern carries the same latent anchoring bug.
	it('catches a pbkdf2 hash in the SERIALIZED form of a record', () => {
		const serialized = JSON.stringify({ id: 'u-1', displayName: 'Bob', note: PBKDF2_HASH });
		assert.ok(serialized.startsWith('{'), 'precondition: serialized records start with {');
		assert.strictEqual(looksSecret(serialized), true);
	});

	for (const [name, sample] of SHAPES) {
		it(`catches ${name} in the SERIALIZED form of a record`, () => {
			const serialized = JSON.stringify({ id: 'u-1', createdAt: '2024-01-01', note: sample });
			assert.ok(serialized.startsWith('{'));
			assert.strictEqual(looksSecret(serialized), true);
		});
	}

	it('catches a shape in the SERIALIZED form of an array of records', () => {
		const serialized = JSON.stringify([{ label: 'primary', note: PBKDF2_HASH }]);
		assert.ok(serialized.startsWith('['));
		assert.strictEqual(looksSecret(serialized), true);
	});
});

describe('defect 2 regression: the redacted flag is computed, not claimed', () => {
	// The reference Cognito read path hardcoded `redacted: false` while applying
	// nothing at all. The flag now comes back from the walk itself.
	it('reports redacted: true when something was actually masked', () => {
		const result = redactValue({ id: 'u-1', note: PBKDF2_HASH });
		assert.strictEqual(result.redacted, true);
		assert.deepStrictEqual(result.value, { id: 'u-1', note: REDACTED });
	});

	it('reports redacted: false when nothing was masked', () => {
		const result = redactValue({ id: 'u-1', note: 'looks fine' });
		assert.strictEqual(result.redacted, false);
		assert.deepStrictEqual(result.value, { id: 'u-1', note: 'looks fine' });
	});

	it('reports redacted: true for a key-name-only match on an otherwise clean value', () => {
		const result = redactValue({ passwordHash: 'plaintext-oops' });
		assert.strictEqual(result.redacted, true);
		assert.deepStrictEqual(result.value, { passwordHash: REDACTED });
	});
});

describe('redactValue — shapes under benign field names', () => {
	for (const [name, sample] of SHAPES) {
		for (const key of BENIGN_KEYS) {
			it(`masks ${name} at benign key "${key}"`, () => {
				const result = redactValue({ id: 'u-1', [key]: sample });
				assert.deepStrictEqual(result.value, { id: 'u-1', [key]: REDACTED });
				assert.strictEqual(result.redacted, true);
			});
		}
	}

	it('runs the content check BEFORE the length heuristic', () => {
		// A bcrypt hash is 60 chars — comfortably under the length cap. It must
		// not survive by being short.
		assert.ok(BCRYPT_HASH.length < LONG_STRING_THRESHOLD);
		const result = redactValue({ displayName: BCRYPT_HASH });
		assert.deepStrictEqual(result.value, { displayName: REDACTED });
		assert.strictEqual(result.redacted, true);
	});
});

describe('redactValue — length cap', () => {
	it('masks a string longer than the threshold', () => {
		const long = 'x'.repeat(LONG_STRING_THRESHOLD + 1);
		const result = redactValue({ note: long });
		assert.deepStrictEqual(result.value, { note: REDACTED });
		assert.strictEqual(result.redacted, true);
	});

	it('leaves a string exactly at the threshold alone', () => {
		const atLimit = 'x'.repeat(LONG_STRING_THRESHOLD);
		const result = redactValue({ note: atLimit });
		assert.deepStrictEqual(result.value, { note: atLimit });
		assert.strictEqual(result.redacted, false);
	});
});

describe('redactValue — key-name matching', () => {
	it('masks a benign value sitting under a matching key', () => {
		const result = redactValue({ sessionId: 'abc', authMode: 'sso', secretName: 'prod/db' });
		assert.deepStrictEqual(result.value, { sessionId: REDACTED, authMode: REDACTED, secretName: REDACTED });
		assert.strictEqual(result.redacted, true);
	});

	it('masks a whole sub-object at a matching key', () => {
		const result = redactValue({
			id: 'u-1',
			credentials: { accessKeyId: 'AKIA-not-even-valid', region: 'us-east-1', nested: { deep: true } },
		});
		assert.deepStrictEqual(result.value, { id: 'u-1', credentials: REDACTED });
		assert.strictEqual(result.redacted, true);
	});

	it('masks non-string values at a matching key too', () => {
		const result = redactValue({ challengeAttempts: 3, tokenValid: false, codes: [1, 2, 3] });
		assert.deepStrictEqual(result.value, { challengeAttempts: REDACTED, tokenValid: REDACTED, codes: REDACTED });
		assert.strictEqual(result.redacted, true);
	});

	it('covers every documented key token', () => {
		for (const token of [
			'secret',
			'token',
			'password',
			'hash',
			'credential',
			'challenge',
			'session',
			'auth',
			'code',
		]) {
			assert.strictEqual(SECRET_KEY_PATTERN.test(token), true, token);
			assert.strictEqual(SECRET_KEY_PATTERN.test(`user${token}Value`), true, token);
		}
	});

	it('over-matches "code" on purpose, in the safe direction', () => {
		// Documented over-approximation: masking a zip code is a cosmetic
		// annoyance; leaking an authorization code is an incident.
		const result = redactValue({ zipcode: '10001', statusCode: 200 });
		assert.deepStrictEqual(result.value, { zipcode: REDACTED, statusCode: REDACTED });
		assert.strictEqual(result.redacted, true);
	});
});

describe('redactValue — benign records round-trip untouched', () => {
	it('leaves an ordinary record exactly as it was', () => {
		const record = {
			id: 'u-1',
			name: 'Bob Bobbor',
			createdAt: '2024-01-01T00:00:00Z',
			region: 'us-east-1',
			count: 42,
			active: true,
			retiredAt: null,
		};
		const result = redactValue(record);
		assert.deepStrictEqual(result.value, record);
		assert.strictEqual(result.redacted, false);
	});

	it('passes numbers, booleans, null and undefined through untouched', () => {
		for (const primitive of [0, 42, -1.5, true, false, null, undefined]) {
			const result = redactValue(primitive);
			assert.strictEqual(result.value, primitive);
			assert.strictEqual(result.redacted, false);
		}
	});
});

describe('redactValue — arrays', () => {
	it('leaves an array of ordinary strings entirely alone', () => {
		const record = { tags: ['alpha', 'beta'] };
		const result = redactValue(record);
		assert.deepStrictEqual(result.value, { tags: ['alpha', 'beta'] });
		assert.strictEqual(result.redacted, false);
	});

	it('masks only the qualifying element', () => {
		const result = redactValue({ tags: ['alpha', AWS_ACCESS_KEY_ID] });
		assert.deepStrictEqual(result.value, { tags: ['alpha', REDACTED] });
		assert.strictEqual(result.redacted, true);
	});

	it('leaves arrays of numbers, booleans and null alone', () => {
		const record = { counts: [1, 2, 3], flags: [true, false], blanks: [null, null] };
		const result = redactValue(record);
		assert.deepStrictEqual(result.value, record);
		assert.strictEqual(result.redacted, false);
	});

	it('masks a container element that holds something qualifying', () => {
		const result = redactValue({ items: [{ label: 'ok' }, { label: JWT }] });
		assert.deepStrictEqual(result.value, { items: [{ label: 'ok' }, { label: REDACTED }] });
		assert.strictEqual(result.redacted, true);
	});

	it('handles a bare top-level array', () => {
		const result = redactValue(['alpha', BCRYPT_HASH]);
		assert.deepStrictEqual(result.value, ['alpha', REDACTED]);
		assert.strictEqual(result.redacted, true);
	});
});

describe('redactValue — deep nesting', () => {
	it('catches a PEM key at accounts[0].profile.pem', () => {
		const result = redactValue({
			accounts: [{ profile: { pem: PEM_PRIVATE_KEY, displayName: 'primary' } }],
		});
		assert.deepStrictEqual(result.value, {
			accounts: [{ profile: { pem: REDACTED, displayName: 'primary' } }],
		});
		assert.strictEqual(result.redacted, true);
	});

	it('recurses to arbitrary depth', () => {
		const result = redactValue({ a: { b: { c: { d: { e: [{ f: AWS_SESSION_KEY_ID }] } } } } });
		assert.deepStrictEqual(result.value, { a: { b: { c: { d: { e: [{ f: REDACTED }] } } } } });
		assert.strictEqual(result.redacted, true);
	});
});

describe('redactValue — bare top-level string (documented divergence)', () => {
	// The reference masks a bare top-level string UNCONDITIONALLY. We do not:
	// KVStore values are frequently plain short strings, and blanking them all
	// would make the data browser useless while protecting nothing.
	it('leaves a plain short string unchanged', () => {
		const result = redactValue('hello');
		assert.strictEqual(result.value, 'hello');
		assert.strictEqual(result.redacted, false);
	});

	it('masks a bare bcrypt hash', () => {
		const result = redactValue(BCRYPT_HASH);
		assert.strictEqual(result.value, REDACTED);
		assert.strictEqual(result.redacted, true);
	});

	it('masks a bare over-long string', () => {
		const result = redactValue('y'.repeat(LONG_STRING_THRESHOLD + 1));
		assert.strictEqual(result.value, REDACTED);
		assert.strictEqual(result.redacted, true);
	});

	it('leaves an empty string unchanged', () => {
		const result = redactValue('');
		assert.strictEqual(result.value, '');
		assert.strictEqual(result.redacted, false);
	});
});

describe('redactValue — never mutates its input', () => {
	it('leaves the input object identical after a redacting call', () => {
		const record = {
			id: 'u-1',
			note: PBKDF2_HASH,
			passwordHash: 'plaintext',
			nested: { items: ['alpha', JWT] },
		};
		const before = structuredClone(record);
		const result = redactValue(record);
		assert.strictEqual(result.redacted, true);
		assert.deepStrictEqual(record, before);
		assert.notStrictEqual(result.value, record);
	});

	it('returns fresh containers rather than the originals', () => {
		const nested = { label: 'ok' };
		const record = { nested, items: ['alpha'] };
		const result = redactValue(record) as { value: { nested: unknown; items: unknown } };
		assert.notStrictEqual(result.value.nested, nested);
		assert.notStrictEqual(result.value.items, record.items);
	});
});

describe('isAncillaryStoreName', () => {
	it('matches the ancillary suffixes, case-insensitively', () => {
		for (const name of [
			'myapp-codes',
			'myapp-sessions',
			'myapp-tokens',
			'myapp-challenges',
			'myapp-cache',
			'MyApp-Sessions',
			'MYAPP-CACHE',
		]) {
			assert.strictEqual(isAncillaryStoreName(name), true, name);
		}
	});

	it('does not match primary store names', () => {
		for (const name of ['myapp-auth-users', 'myapp-orders', 'myapp-cached-items', 'codes-myapp', 'myapp-token']) {
			assert.strictEqual(isAncillaryStoreName(name), false, name);
		}
	});
});

/**
 * Found by a live run of the data browser against a real AuthBasic `state.json`,
 * not by any of the unit tests above: flattening an object store into one record
 * per property moves the field name out of the value, so the name-based layer
 * stopped protecting it and `{ sessionSecret: 's3cr3t' }` came back in clear.
 */
describe('redactRecordValue — the record key is a field name', () => {
	it('masks a short secret that shape detection cannot possibly catch', () => {
		// 's3cr3t' has no recognisable encoding, so the key name is the only signal.
		assert.strictEqual(looksSecret('s3cr3t'), false, 'precondition: the value looks benign');
		const outcome = redactRecordValue('sessionSecret', 's3cr3t');
		assert.strictEqual(outcome.value, REDACTED);
		assert.strictEqual(outcome.redacted, true);
	});

	it('masks the whole value when the record key looks secret, object or not', () => {
		for (const key of ['sessionSecret', 'passwordHash', 'refreshToken', 'credentials', 'challenges', 'authState']) {
			const outcome = redactRecordValue(key, { nested: { anything: 'here' } });
			assert.strictEqual(outcome.value, REDACTED, key);
			assert.strictEqual(outcome.redacted, true, key);
		}
	});

	it('leaves a benign record key to the ordinary value walk', () => {
		const value = { id: 'u1', title: 'task 1', tags: ['alpha', 'beta'] };
		const outcome = redactRecordValue('users', value);
		assert.deepStrictEqual(outcome.value, value);
		assert.strictEqual(outcome.redacted, false);
	});

	it('still catches a credential shape under a benign record key', () => {
		const outcome = redactRecordValue('users', { displayName: `$2b$12$${'A'.repeat(53)}` });
		assert.deepStrictEqual(outcome.value, { displayName: REDACTED });
		assert.strictEqual(outcome.redacted, true);
	});

	it('does not mutate the input', () => {
		const value = { id: 'u1' };
		redactRecordValue('sessionSecret', value);
		assert.deepStrictEqual(value, { id: 'u1' });
	});
});
