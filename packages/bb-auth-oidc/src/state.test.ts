// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
	encodeState,
	decodeState,
	type StatePayload,
	type StatePayloadV1,
} from './state.js';

const SECRET = 'test-secret-for-state-tests-only';

describe('state envelope', () => {
	test('round-trips a payload with all fields', () => {
		const payload: StatePayloadV1 = { v: 1, csrf: 'csrf-value-32-chars-minimum-ok!', relay: 'myapp://auth', app: 'user-state' };
		const encoded = encodeState(payload, SECRET);
		const result = decodeState(encoded, SECRET);
		assert.deepStrictEqual(result, { ok: true, payload });
	});

	test('round-trips with only required fields', () => {
		const payload: StatePayloadV1 = { v: 1, csrf: 'just-csrf' };
		const encoded = encodeState(payload, SECRET);
		const result = decodeState(encoded, SECRET);
		assert.deepStrictEqual(result, { ok: true, payload });
	});

	test('canonical encoding: undefined fields produce same bytes as absent fields', () => {
		const withUndefined: StatePayload = { v: 1, csrf: 'x', relay: undefined, app: undefined };
		const withoutFields: StatePayload = { v: 1, csrf: 'x' };
		assert.strictEqual(encodeState(withUndefined, SECRET), encodeState(withoutFields, SECRET));
	});

	// Pins the wire format the native SDKs decode. The expected value was
	// produced by the original hand-written base64url helpers; the body
	// contains `-` and `_` and needs padding, so a switch to standard base64
	// or a padding change fails here.
	const KNOWN_PAYLOAD: StatePayloadV1 = {
		v: 1,
		csrf: 'known-answer-csrf-value-100',
		relay: 'myapp://auth',
		app: 'redirect=/café?x=~&y=☃',
	};
	const KNOWN_STATE =
		'eyJ2IjoxLCJjc3JmIjoia25vd24tYW5zd2VyLWNzcmYtdmFsdWUtMTAwIiwicmVsYXkiOiJteWFwcDovL2F1dGgiLCJhcHAiOiJyZWRpcmVjdD0vY2Fmw6k_eD1-Jnk94piDIn0.ocjEjeXY-WMrpqTO-fEXqAptbf30Shljtht_yjhksJ8';

	test('encodes a known payload to the pinned wire format', () => {
		assert.strictEqual(encodeState(KNOWN_PAYLOAD, SECRET), KNOWN_STATE);
	});

	test('decodes a pinned state envelope', () => {
		assert.deepStrictEqual(decodeState(KNOWN_STATE, SECRET), { ok: true, payload: KNOWN_PAYLOAD });
	});

	test('tampered body returns signature failure', () => {
		const encoded = encodeState({ v: 1, csrf: 'csrf-val' }, SECRET);
		const [body, sig] = encoded.split('.');
		const tampered = `${body}X.${sig}`;
		assert.deepStrictEqual(decodeState(tampered, SECRET), { ok: false, reason: 'signature' });
	});

	test('wrong secret returns signature failure', () => {
		const encoded = encodeState({ v: 1, csrf: 'csrf-val' }, SECRET);
		assert.deepStrictEqual(decodeState(encoded, 'wrong-secret'), { ok: false, reason: 'signature' });
	});

	test('unknown version returns version failure', () => {
		const encoded = encodeState({ v: 99, csrf: 'x' } as any, SECRET);
		assert.deepStrictEqual(decodeState(encoded, SECRET), { ok: false, reason: 'version' });
	});

	test('malformed envelope (no separator) returns malformed', () => {
		assert.deepStrictEqual(decodeState('noseparator', SECRET), { ok: false, reason: 'malformed' });
	});
});
