// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as first from './request-base-url.js';

// Dynamic on purpose: a query string gives Node a separate module instance, as a
// duplicated `@aws-blocks/core` copy in a dependency tree would. A static import
// would resolve to the same instance as `first`.
const second: typeof first = await import(`./request-base-url.js?copy=${Date.now()}`);

describe('getRequestBaseUrl across duplicate copies of @aws-blocks/core', () => {
	const ctx = {
		request: { url: new URL('https://abc123.execute-api.us-east-1.amazonaws.com/aws-blocks/auth/callback') },
	};

	it('a base set by one copy is read by another (the stage survives)', () => {
		const base = 'https://abc123.execute-api.us-east-1.amazonaws.com/prod';
		assert.strictEqual(
			first.requestBaseUrl.run(base, () => second.getRequestBaseUrl(ctx)),
			base,
		);
		assert.strictEqual(
			second.requestBaseUrl.run(base, () => first.getRequestBaseUrl(ctx)),
			base,
		);
	});

	it('outside a request, both copies fall back to the request origin', () => {
		assert.strictEqual(second.getRequestBaseUrl(ctx), 'https://abc123.execute-api.us-east-1.amazonaws.com');
	});
});
