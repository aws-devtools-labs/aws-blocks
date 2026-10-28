// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
/**
 * Tests for Bedrock Mantle endpoint detection and short-term Bedrock API key minting.
 *
 * The expected keys are reference vectors produced by `@aws/bedrock-token-generator` (SigV4 via
 * `@smithy/signature-v4`) for the same credentials, region, signing time and lifetime, so these
 * pin byte-for-byte compatibility with the format Bedrock accepts.
 */
import { describe, test } from 'node:test';
import {
	buildMantleBearerToken,
	createMantleApiKeyResolver,
	type MantleCredentials,
	parseMantleRegion,
} from './mantle.js';

const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const SIGNED_AT = new Date(Date.UTC(2026, 0, 15, 10, 30, 45));

/** Decodes a key back to its presigned query string. */
function decode(token: string): string {
	assert.ok(token.startsWith('bedrock-api-key-'), token);
	return Buffer.from(token.slice('bedrock-api-key-'.length), 'base64').toString('utf8');
}

describe('parseMantleRegion', () => {
	test('accepts https Mantle endpoints and returns the region', () => {
		assert.strictEqual(parseMantleRegion('https://bedrock-mantle.us-east-1.api.aws/v1'), 'us-east-1');
		assert.strictEqual(parseMantleRegion('https://bedrock-mantle.eu-west-1.api.aws/openai/v1'), 'eu-west-1');
		assert.strictEqual(parseMantleRegion('https://bedrock-mantle.ap-southeast-2.api.aws'), 'ap-southeast-2');
		assert.strictEqual(parseMantleRegion('https://bedrock-mantle.us-gov-west-1.api.aws/v1'), 'us-gov-west-1');
		assert.strictEqual(
			parseMantleRegion('https://BEDROCK-MANTLE.US-EAST-1.API.AWS/v1'),
			'us-east-1',
			'URL hostnames are case-normalized',
		);
	});

	test('rejects anything that is not exactly an https Mantle hostname', () => {
		for (const endpoint of [
			undefined,
			'',
			'not a url',
			'http://bedrock-mantle.us-east-1.api.aws/v1',
			'https://bedrock-mantle.us-east-1.api.aws.evil.com/v1',
			'https://evil.com/?bedrock-mantle.us-east-1.api.aws',
			'https://evil.com/bedrock-mantle.us-east-1.api.aws/v1',
			'https://bedrock-mantle.us-east-1.api.aws@evil.com/v1',
			'https://x.bedrock-mantle.us-east-1.api.aws/v1',
			'https://bedrock-mantle.us-east.api.aws/v1',
			'https://bedrock-mantle..api.aws/v1',
			'https://bedrock-runtime.us-east-1.amazonaws.com',
			'https://api.openai.com/v1',
			'http://localhost:11434/v1',
		]) {
			assert.strictEqual(parseMantleRegion(endpoint), undefined, String(endpoint));
		}
	});
});

describe('buildMantleBearerToken', () => {
	test('matches the reference key for long-term credentials', () => {
		const token = buildMantleBearerToken({
			credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET },
			region: 'us-east-1',
			now: SIGNED_AT,
			expiresInSeconds: 43200,
		});
		assert.strictEqual(
			token,
			'bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29tLz9BY3Rpb249Q2FsbFdpdGhCZWFyZXJUb2tlbiZYLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSURFWEFNUExFJTJGMjAyNjAxMTUlMkZ1cy1lYXN0LTElMkZiZWRyb2NrJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjAxMTVUMTAzMDQ1WiZYLUFtei1FeHBpcmVzPTQzMjAwJlgtQW16LVNpZ25hdHVyZT1mYzg1MGZjZDUyNzc2MzliNzc1MWNiNWVjNTBkOWE4YzU3ZTRlOTRjYzM3ODUwMzdiN2ZhYTMxMGViOWM3NzM2JlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCZWZXJzaW9uPTE=',
		);
		assert.strictEqual(
			decode(token),
			'bedrock.amazonaws.com/?Action=CallWithBearerToken&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20260115%2Fus-east-1%2Fbedrock%2Faws4_request&X-Amz-Date=20260115T103045Z&X-Amz-Expires=43200&X-Amz-Signature=fc850fcd5277639b7751cb5ec50d9a8c57e4e94cc3785037b7faa310eb9c7736&X-Amz-SignedHeaders=host&Version=1',
		);
	});

	test('matches the reference key for temporary credentials (session token is signed)', () => {
		const token = buildMantleBearerToken({
			credentials: {
				accessKeyId: 'ASIAEXAMPLE',
				secretAccessKey: SECRET,
				sessionToken: 'IQoJb3JpZ2luX2VjE+/=session token',
			},
			region: 'us-east-1',
			now: SIGNED_AT,
		});
		assert.strictEqual(
			token,
			'bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29tLz9BY3Rpb249Q2FsbFdpdGhCZWFyZXJUb2tlbiZYLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFTSUFFWEFNUExFJTJGMjAyNjAxMTUlMkZ1cy1lYXN0LTElMkZiZWRyb2NrJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjAxMTVUMTAzMDQ1WiZYLUFtei1FeHBpcmVzPTQzMjAwJlgtQW16LVNlY3VyaXR5LVRva2VuPUlRb0piM0pwWjJsdVgyVmpFJTJCJTJGJTNEc2Vzc2lvbiUyMHRva2VuJlgtQW16LVNpZ25hdHVyZT0wOWI5NWU3ZjcwNWJhODI5MmE0NzBmN2UxMzlmN2NjZWY2NDJmYmQxYmNiZDZlYTJmMDIyZjE4Y2VlNjZhYWMxJlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCZWZXJzaW9uPTE=',
		);
	});

	test('matches the reference key for another region and lifetime', () => {
		const token = buildMantleBearerToken({
			credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET },
			region: 'eu-west-1',
			now: SIGNED_AT,
			expiresInSeconds: 900,
		});
		assert.strictEqual(
			token,
			'bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29tLz9BY3Rpb249Q2FsbFdpdGhCZWFyZXJUb2tlbiZYLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSURFWEFNUExFJTJGMjAyNjAxMTUlMkZldS13ZXN0LTElMkZiZWRyb2NrJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjAxMTVUMTAzMDQ1WiZYLUFtei1FeHBpcmVzPTkwMCZYLUFtei1TaWduYXR1cmU9MWQ5NDBhNmQxMTVmMmZmZmQwOTNiZmNiZWYyNzM2MTZmNTVlNDFjZjExODAzMmNmMTRiYzU4YjQzZDJkODU0MyZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmVmVyc2lvbj0x',
		);
	});

	test("matches the reference key when the session token contains !'()* (RFC 3986 escaping)", () => {
		const token = buildMantleBearerToken({
			credentials: {
				accessKeyId: 'ASIAEXAMPLE',
				secretAccessKey: SECRET,
				sessionToken: "FwoGZX!'()*session/token+=",
			},
			region: 'us-west-2',
			now: SIGNED_AT,
			expiresInSeconds: 3600,
		});
		assert.strictEqual(
			token,
			'bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29tLz9BY3Rpb249Q2FsbFdpdGhCZWFyZXJUb2tlbiZYLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFTSUFFWEFNUExFJTJGMjAyNjAxMTUlMkZ1cy13ZXN0LTIlMkZiZWRyb2NrJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjAxMTVUMTAzMDQ1WiZYLUFtei1FeHBpcmVzPTM2MDAmWC1BbXotU2VjdXJpdHktVG9rZW49RndvR1pYJTIxJTI3JTI4JTI5JTJBc2Vzc2lvbiUyRnRva2VuJTJCJTNEJlgtQW16LVNpZ25hdHVyZT04OTBhNjM1NGQwNDVjY2JmYzQ1YTdlOTczZDk5ZGZmMDNhOTJkNmY2MzUwMDgyODU5OTFmOGY4ZTFjNTA5NGIyJlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCZWZXJzaW9uPTE=',
		);
		assert.ok(decode(token).includes('X-Amz-Security-Token=FwoGZX%21%27%28%29%2Asession%2Ftoken%2B%3D&'));
	});

	test('caps the lifetime at 12 hours and at the credentials expiration', () => {
		const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET };
		const expiresOf = (token: string) => Number(/X-Amz-Expires=(\d+)/.exec(decode(token))?.[1]);
		assert.strictEqual(
			expiresOf(buildMantleBearerToken({ credentials, region: 'us-east-1', now: SIGNED_AT })),
			43200,
			'default',
		);
		assert.strictEqual(
			expiresOf(
				buildMantleBearerToken({ credentials, region: 'us-east-1', now: SIGNED_AT, expiresInSeconds: 100000 }),
			),
			43200,
			'capped at 12h',
		);
		const expiration = new Date(SIGNED_AT.getTime() + 3600 * 1000);
		assert.strictEqual(
			expiresOf(
				buildMantleBearerToken({
					credentials: { ...credentials, expiration },
					region: 'us-east-1',
					now: SIGNED_AT,
				}),
			),
			3600,
			'capped at credential expiry',
		);
		const expired = new Date(SIGNED_AT.getTime() - 1000);
		assert.strictEqual(
			expiresOf(
				buildMantleBearerToken({
					credentials: { ...credentials, expiration: expired },
					region: 'us-east-1',
					now: SIGNED_AT,
				}),
			),
			1,
			'never zero or negative',
		);
	});

	test('uses the 12 hour maximum when the requested lifetime is not finite', () => {
		const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET };
		const expiresOf = (token: string) => Number(/X-Amz-Expires=(\d+)/.exec(decode(token))?.[1]);
		for (const expiresInSeconds of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			assert.strictEqual(
				expiresOf(
					buildMantleBearerToken({ credentials, region: 'us-east-1', now: SIGNED_AT, expiresInSeconds }),
				),
				43200,
				String(expiresInSeconds),
			);
		}
	});
});

describe('createMantleApiKeyResolver', () => {
	function setup(expiration?: () => Date | undefined) {
		let clock = SIGNED_AT.getTime();
		let calls = 0;
		const credentialsProvider = async (): Promise<MantleCredentials> => {
			calls++;
			return {
				accessKeyId: `AKID${calls}`,
				secretAccessKey: SECRET,
				sessionToken: 'tok',
				expiration: expiration?.(),
			};
		};
		const resolve = createMantleApiKeyResolver('us-east-1', undefined, { credentialsProvider, now: () => clock });
		return {
			resolve,
			advance: (ms: number) => {
				clock += ms;
			},
			calls: () => calls,
			now: () => clock,
		};
	}

	test('caches the key until 5 minutes before it expires, then re-mints', async () => {
		const t = setup();
		const first = await t.resolve();
		assert.ok(decode(first).includes('X-Amz-Credential=AKID1%2F'));
		t.advance(11 * 3600 * 1000);
		assert.strictEqual(await t.resolve(), first, 'still cached after 11h');
		assert.strictEqual(t.calls(), 1);
		t.advance(56 * 60 * 1000); // 11h56m: within 5 min of the 12h expiry
		const second = await t.resolve();
		assert.notStrictEqual(second, first);
		assert.ok(decode(second).includes('X-Amz-Credential=AKID2%2F'));
		assert.strictEqual(t.calls(), 2);
	});

	test('refreshes with the credentials when they expire before 12 hours', async () => {
		let t: ReturnType<typeof setup> | undefined;
		t = setup(() => new Date((t?.now() ?? 0) + 3600 * 1000));
		const first = await t.resolve();
		assert.ok(decode(first).includes('X-Amz-Expires=3600&'));
		t.advance(50 * 60 * 1000);
		assert.strictEqual(await t.resolve(), first);
		t.advance(6 * 60 * 1000); // 56 minutes in: within 5 minutes of the credential expiry
		assert.notStrictEqual(await t.resolve(), first);
		assert.strictEqual(t.calls(), 2);
	});

	test('concurrent callers share one mint', async () => {
		const t = setup();
		const [a, b, c] = await Promise.all([t.resolve(), t.resolve(), t.resolve()]);
		assert.strictEqual(a, b);
		assert.strictEqual(b, c);
		assert.strictEqual(t.calls(), 1);
	});

	test('a failed mint rejects and the next call retries', async () => {
		let fail = true;
		const resolve = createMantleApiKeyResolver('us-east-1', undefined, {
			credentialsProvider: async () => {
				if (fail) throw new Error('no credentials');
				return { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET };
			},
		});
		await assert.rejects(resolve(), /no credentials/);
		fail = false;
		assert.ok((await resolve()).startsWith('bedrock-api-key-'));
	});
});
