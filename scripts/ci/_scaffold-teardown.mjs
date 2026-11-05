// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Makes a scaffolded app's production deploy fully deletable. `npm run deploy`
// deploys the templates with `BlocksPresets.production`, whose RETAIN removal
// policy is right for a customer: `npm run destroy` keeps the config access-log
// bucket (an audit artifact, see packages/core/src/cdk/config-registry.ts). A CI
// stack must leave nothing behind, and the CI role can't delete buckets, so each
// scheduled Windows E2E run leaked one bucket that nothing reclaimed.
//
// Trade-off: no CI job deploys the RETAIN posture to AWS any more (every test
// app CI deploys uses the sandbox preset). The rewrite also turns on the log
// bucket's autoDeleteObjects custom resource, so this stack is not exactly the
// customer's production stack, and it brings the late-access-log BucketNotEmpty
// race that config-registry.ts notes for non-sandbox DESTROY (`npm run destroy`
// empties the bucket and retries before giving up). The RETAIN synth stays
// covered by packages/core/src/cdk/config-registry.test.ts ("log bucket
// inherits the production preset posture").

import { readFileSync, writeFileSync } from 'node:fs';

const CDK_IMPORT = /^import \* as cdk from 'aws-cdk-lib';$/m;
const PRODUCTION_PRESET = 'BlocksPresets.production';
const DISPOSABLE_PRESET = `{ ...${PRODUCTION_PRESET}, removalPolicy: cdk.RemovalPolicy.DESTROY, deletionProtection: false }`;

/**
 * Rewrite the production preset in a scaffolded `aws-blocks/index.cdk.ts` to
 * `{ ...BlocksPresets.production, removalPolicy: DESTROY, deletionProtection: false }`:
 * every other production default is kept. Deletion protection goes too, so a
 * stateful block added to the template later can't leave the stack
 * DELETE_FAILED. Throws, leaving the file as is, when the file doesn't import
 * `cdk` or doesn't use the preset exactly once (the template changed shape), so
 * the run fails up front instead of leaking again.
 */
export function makeProductionDeployDisposable(cdkEntryPath) {
	const source = readFileSync(cdkEntryPath, 'utf-8');
	const uses = source.split(PRODUCTION_PRESET).length - 1;
	if (!CDK_IMPORT.test(source) || uses !== 1) {
		throw new Error(
			`${cdkEntryPath}: expected \`import * as cdk from 'aws-cdk-lib'\` and one \`${PRODUCTION_PRESET}\` ` +
				`(found ${uses}); cannot make the production deploy deletable, so it would leak retained resources`,
		);
	}
	writeFileSync(
		cdkEntryPath,
		source.replace(PRODUCTION_PRESET, DISPOSABLE_PRESET),
	);
}
