// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DataProvider } from './data-provider.js';
import { LocalDataProvider } from './local-provider.js';

export const PROJECT_ROOT_ENV_VAR = 'BLOCKS_PROJECT_ROOT';

let provider: DataProvider | undefined;

/**
 * Returns the process-wide DataProvider.
 *
 * Today this is always the local provider rooted at BLOCKS_PROJECT_ROOT
 * (set by core's dashboard.ts before booting the server, or defaulting to
 * cwd under plain `next dev`). A hosted/in-account variant swaps this
 * factory — route handlers never know the difference.
 */
export function getDataProvider(): DataProvider {
	if (!provider) {
		provider = new LocalDataProvider(process.env[PROJECT_ROOT_ENV_VAR] ?? process.cwd());
	}
	return provider;
}

/** Test seam: replace or reset the active provider. */
export function setDataProvider(next: DataProvider | undefined): void {
	provider = next;
}
