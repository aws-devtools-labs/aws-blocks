// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';

/**
 * The installed aws-cdk-lib version, or `undefined` if it can't be read. Used in
 * messages about couplings to aws-cdk-lib internals, so a report names the
 * version that changed.
 *
 * @internal
 */
export function cdkVersion(): string | undefined {
	try {
		return (createRequire(import.meta.url)('aws-cdk-lib/package.json') as { version?: string }).version;
	} catch {
		return undefined;
	}
}
