// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime probe of the REAL aws-amplify@6 Storage client against the emitted
 * storage section. No network, no AWS: `getUrl` without
 * `validateObjectExistence` only presigns locally.
 *
 *  1. As emitted today (no Identity Pool), Storage has no AWS credentials.
 *  2. With a custom `credentialsProvider` (standing in for creds a Blocks
 *     ApiNamespace would vend), the unchanged Storage client presigns against
 *     the Blocks bucket with the caller's identity prefix. This is the
 *     mechanism behind option B in the findings doc; the fake credentials here
 *     prove the wiring only, not any IAM scoping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Amplify } from 'aws-amplify';
import { getUrl } from 'aws-amplify/storage';
import { emitAmplifyOutputs } from '../src/emit-amplify-outputs.js';

const { outputs } = emitAmplifyOutputs(
	{ region: 'us-west-2', userPoolId: 'us-west-2_ABC123', userPoolClientId: '1h57kf5a2b3c4d5e6f7g8h9i0j' },
	{ fileBuckets: [{ bucketName: 'my-app-uploads', region: 'us-west-2', corsOrigins: ['https://app.example.com'], exposesEtag: true }] },
);

const noTokens = { getTokens: async () => null };

test('as emitted (no Identity Pool), Storage has no credentials', async () => {
	Amplify.configure(outputs, { Auth: { tokenProvider: noTokens } });
	await assert.rejects(getUrl({ path: 'public/a.txt' }), { name: 'NoCredentials' });
});

test('with a Blocks-vended credentialsProvider, the real Storage client presigns against the Blocks bucket', async () => {
	Amplify.configure(outputs, {
		Auth: {
			tokenProvider: noTokens,
			credentialsProvider: {
				getCredentialsAndIdentityId: async () => ({
					credentials: { accessKeyId: 'ASIAFAKEBLOCKSVENDED', secretAccessKey: 'fake', sessionToken: 'fake' },
					identityId: 'user-sub-123',
				}),
				clearCredentialsAndIdentityId: () => {},
			},
		},
	});
	const { url } = await getUrl({ path: ({ identityId }) => `private/${identityId}/a.txt` });
	assert.equal(url.hostname, 'my-app-uploads.s3.us-west-2.amazonaws.com');
	assert.equal(url.pathname, '/private/user-sub-123/a.txt');
	assert.match(url.searchParams.get('X-Amz-Credential') ?? '', /^ASIAFAKEBLOCKSVENDED\//);
});
