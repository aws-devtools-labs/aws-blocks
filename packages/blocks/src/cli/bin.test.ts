// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
	bin: Record<string, string>;
};

describe('the bin map of @aws-blocks/blocks', () => {
	it('installs the CLI as cdk-blocks, and no blocks command', () => {
		assert.strictEqual(manifest.bin['cdk-blocks'], './dist/cli/bin.js');
		assert.strictEqual(Object.hasOwn(manifest.bin, 'blocks'), false);
	});
});
