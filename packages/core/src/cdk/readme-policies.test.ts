// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The README section "Running many apps in one AWS account" gives the shared
 * IAM policies in full, for platforms to copy. Pin what it says about them: every
 * JSON block parses, and every full policy fits IAM's managed-policy limit of
 * 6,144 characters (white space not counted), so the snippets and the README's
 * size claims can't drift apart.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** IAM's limit on a customer managed policy, not counting white space. */
const MANAGED_POLICY_MAX = 6144;

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'README.md'), 'utf8');
const start = readme.indexOf('### Running many apps in one AWS account');
const end = readme.indexOf('\n### ', start + 1);
const section = readme.slice(start, end === -1 ? undefined : end);
const jsonBlocks = [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);

describe('README: the shared platform policies', () => {
	test('the section is found and has JSON blocks', () => {
		assert.ok(start !== -1, 'README section "Running many apps in one AWS account" not found');
		assert.ok(jsonBlocks.length > 0, 'no JSON blocks in the section');
	});

	test('every JSON block parses', () => {
		for (const [i, block] of jsonBlocks.entries()) {
			assert.doesNotThrow(() => JSON.parse(block), `JSON block ${i + 1} in the section doesn't parse`);
		}
	});

	test(`every full policy fits IAM's ${MANAGED_POLICY_MAX}-character managed-policy limit`, () => {
		const policies = jsonBlocks
			.map((block) => ({ block, doc: JSON.parse(block) as { Version?: string; Statement?: { Sid?: string }[] } }))
			.filter(({ doc }) => doc.Version !== undefined && Array.isArray(doc.Statement));
		// The boundary, the execution policy's role fence and the deploy guard.
		assert.ok(policies.length >= 3, `expected at least 3 full policies, found ${policies.length}`);
		for (const { block, doc } of policies) {
			const size = block.replace(/\s/g, '').length;
			const first = doc.Statement?.[0]?.Sid ?? '(no Sid)';
			assert.ok(size <= MANAGED_POLICY_MAX, `the policy starting with ${first} is ${size} characters`);
		}
	});
});
