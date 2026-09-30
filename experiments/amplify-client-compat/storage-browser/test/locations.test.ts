// Offline tests for the StorageBrowser credential-scoping rules. The live
// counterpart (real STS + S3) is live-storage-browser.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeScope, locationsFor, sessionPolicy, ScopeDeniedError } from '../aws-blocks/locations.js';

const BUCKET = 'stack-ampsb-7f3c1-files';
const A = '11111111-aaaa';
const B = '22222222-bbbb';
const locs = locationsFor(BUCKET, A);

test('grants the caller their own prefix with every permission', () => {
	const r = authorizeScope(locs, `s3://${BUCKET}/private/${A}/*`, ['get', 'list', 'write', 'delete']);
	assert.equal(r.location.id, 'mine');
	assert.equal(r.prefix, `private/${A}/`);
});

test('narrows to a sub-folder inside the caller prefix', () => {
	const r = authorizeScope(locs, `s3://${BUCKET}/private/${A}/photos/*`, ['list']);
	assert.equal(r.prefix, `private/${A}/photos/`);
});

test('refuses another user prefix, a look-alike prefix, and other buckets', () => {
	for (const scope of [
		`s3://${BUCKET}/private/${B}/*`,
		`s3://${BUCKET}/private/${A}x/*`, // shares a string prefix with A's sub but is a different folder
		`s3://${BUCKET}/private/*`,
		`s3://${BUCKET}/*`,
		`s3://other-bucket/private/${A}/*`,
	]) {
		assert.throws(() => authorizeScope(locs, scope, ['list']), ScopeDeniedError, scope);
	}
});

test('refuses wildcards that would widen the IAM resource', () => {
	assert.throws(() => authorizeScope(locs, `s3://${BUCKET}/private/${A}/*/x*`, ['get']), ScopeDeniedError);
	assert.throws(() => authorizeScope(locs, `s3://${BUCKET}/private/${A}/?*`, ['get']), ScopeDeniedError);
});

test('refuses write/delete on the read-only shared location', () => {
	assert.equal(authorizeScope(locs, `s3://${BUCKET}/public/*`, ['get', 'list']).location.id, 'shared');
	assert.throws(() => authorizeScope(locs, `s3://${BUCKET}/public/*`, ['write']), /write not granted/);
	assert.throws(() => authorizeScope(locs, `s3://${BUCKET}/public/*`, ['delete']), /delete not granted/);
});

test('refuses an empty or malformed request', () => {
	assert.throws(() => authorizeScope(locs, `s3://${BUCKET}/private/${A}/*`, []), ScopeDeniedError);
	assert.throws(() => authorizeScope(locs, `https://${BUCKET}/private/${A}/*`, ['get']), ScopeDeniedError);
});

test('session policy covers exactly the requested permissions on the prefix', () => {
	const p = JSON.parse(sessionPolicy(BUCKET, `private/${A}/`, ['list', 'get']));
	assert.deepEqual(p.Statement, [
		{
			Effect: 'Allow',
			Action: 's3:ListBucket',
			Resource: `arn:aws:s3:::${BUCKET}`,
			Condition: { StringLike: { 's3:prefix': [`private/${A}/*`] } },
		},
		{ Effect: 'Allow', Action: 's3:GetObject', Resource: `arn:aws:s3:::${BUCKET}/private/${A}/*` },
	]);
});
