// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `SHARED-ACCOUNT.md`, the platform's side of the README section "Running many
 * apps in one AWS account", gives the shared IAM policies in full, for platforms
 * to copy. Pin what it says about them: every JSON block parses, and every full
 * policy fits IAM's managed-policy limit of 6,144 characters (white space not
 * counted), so the snippets and the document's size claims can't drift apart.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** IAM's limit on a customer managed policy, not counting white space. */
const MANAGED_POLICY_MAX = 6144;

const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'SHARED-ACCOUNT.md'), 'utf8');
const jsonBlocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);

describe('SHARED-ACCOUNT.md: the shared platform policies', () => {
	test('the document has JSON blocks', () => {
		assert.ok(jsonBlocks.length > 0, 'no JSON blocks in SHARED-ACCOUNT.md');
	});

	test('every JSON block parses', () => {
		for (const [i, block] of jsonBlocks.entries()) {
			assert.doesNotThrow(() => JSON.parse(block), `JSON block ${i + 1} in SHARED-ACCOUNT.md doesn't parse`);
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
