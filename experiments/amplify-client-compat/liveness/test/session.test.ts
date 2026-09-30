// Offline tests for liveness session ownership rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOwner, assertSessionId, SessionDeniedError, STREAMING_SESSION_POLICY } from '../aws-blocks/session.js';

const ID = '3f1c2b7e-9a4d-4e21-8c55-0d2e6b9f1a77';

test('only the creator may use a session', () => {
	assert.doesNotThrow(() => assertOwner('user-a', 'user-a', ID));
	assert.throws(() => assertOwner('user-a', 'user-b', ID), SessionDeniedError);
	assert.throws(() => assertOwner(null, 'user-a', ID), /unknown or expired/);
});

test('session ids must be UUIDs', () => {
	assert.doesNotThrow(() => assertSessionId(ID));
	for (const bad of ['', '../../etc', `${ID} `, 42, null, undefined]) {
		assert.throws(() => assertSessionId(bad), SessionDeniedError, String(bad));
	}
});

test('browser credentials can only stream', () => {
	const p = JSON.parse(STREAMING_SESSION_POLICY);
	assert.deepEqual(p.Statement, [{ Effect: 'Allow', Action: 'rekognition:StartFaceLivenessSession', Resource: '*' }]);
});
