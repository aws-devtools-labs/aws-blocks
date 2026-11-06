// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Tags a scaffolded app's stacks so cleanup-stacks.yml can reclaim them. The
// sweeper deletes a `bb-test-*` stack only when its `blocks:purpose` tag is
// `e2e-*` or `*-e2e`; the scaffolded templates set no such tag, so a stack a
// failed teardown leaves behind would otherwise be skipped on every sweep.

import { readFileSync, writeFileSync } from 'node:fs';

/** `blocks:purpose` value for stacks the scheduled Windows E2E deploys. */
export const WINDOWS_E2E_PURPOSE = 'e2e-windows';

const CDK_IMPORT = /^import \* as cdk from 'aws-cdk-lib';$/m;
const STACK_EXPORT = /^export const blocksStack = /m;

/**
 * Append `cdk.Tags.of(blocksStack).add('blocks:purpose', purpose)` to a
 * scaffolded `aws-blocks/index.cdk.ts`. Throws when the file doesn't import
 * `cdk` or export `blocksStack` (the template changed shape), so the run fails
 * up front instead of deploying an untagged stack.
 */
export function addPurposeTag(cdkEntryPath, purpose) {
	const source = readFileSync(cdkEntryPath, 'utf-8');
	if (!CDK_IMPORT.test(source) || !STACK_EXPORT.test(source)) {
		throw new Error(
			`${cdkEntryPath}: expected \`import * as cdk from 'aws-cdk-lib'\` and \`export const blocksStack\`; ` +
				'cannot add the blocks:purpose tag cleanup-stacks.yml needs to reclaim a leaked stack',
		);
	}
	writeFileSync(
		cdkEntryPath,
		`${source.trimEnd()}\n\n// Added by the CI driver so cleanup-stacks.yml can reclaim a leaked stack.\n` +
			`cdk.Tags.of(blocksStack).add('blocks:purpose', '${purpose}');\n`,
	);
}
