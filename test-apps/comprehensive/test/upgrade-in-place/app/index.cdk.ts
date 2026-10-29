// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK entry of the upgrade-in-place fixture app. Copied verbatim into BOTH
 * revisions by `../../upgrade-in-place.ts`, so the stack name, the stack
 * defaults and the tags are identical before and after the upgrade — only
 * `aws-blocks/index.ts` (AuthCognito vs Auth) differs.
 *
 * The stack name is `bb-test-<BLOCKS_STACK_SUFFIX>` and nothing else: no
 * per-checkout sandbox id, because the two revisions live in two different
 * checkouts and must address the same stack.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlocksPresets, BlocksStack } from '@aws-blocks/blocks/cdk';
import * as cdk from 'aws-cdk-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));

const suffix = process.env.BLOCKS_STACK_SUFFIX ?? '';
if (!/^upgrade-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(suffix)) {
	throw new Error(
		`upgrade-in-place app: BLOCKS_STACK_SUFFIX must be a dedicated 'upgrade-…' suffix, got '${suffix}'.`,
	);
}

const app = new cdk.App();

export const blocksStack = await BlocksStack.create(app, `bb-test-${suffix}`, {
	backendHandlerPath: join(__dirname, 'index.handler.ts'),
	backendCDKPath: join(__dirname, 'index.ts'),
	// A disposable e2e stack: DESTROY everywhere, no deletion protection, so the
	// harness's destroy() always removes the user pool too. Both revisions use
	// the same preset, so `Auth`'s Q4 "pool follows the stack defaults" resolves
	// to the same DESTROY policy `AuthCognito` hard-codes.
	defaults: BlocksPresets.sandbox,
});

// `blocks:purpose=e2e-*` + the `bb-test-` prefix make a leaked stack eligible
// for .github/workflows/cleanup-stacks.yml.
cdk.Tags.of(blocksStack).add('blocks:purpose', 'e2e-upgrade-in-place');
cdk.Tags.of(blocksStack).add('blocks:deploy-mode', 'production');
