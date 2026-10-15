// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery seam for per-block CLI verbs.
 *
 * A block MAY ship its own CLI bin (today only the data block does, as
 * `bb-data`). The `blocks` CLI exposes those verbs through a grouped facade
 * (e.g. `blocks db <verb>`) WITHOUT depending on the block package: it looks
 * the bin up in the app's own dependency tree (`node_modules/.bin`) and
 * delegates to it. This keeps `@aws-blocks/cli` block-agnostic — it carries no
 * `@aws-blocks/*` block dependency, and a group only works when the backing
 * block is installed in the app the user is running from.
 *
 * This is the pragmatic form of the facade described in the RFC's Open
 * Question 6: delegation is a subprocess to the discovered bin. When a block
 * later exports an in-process verb module (`run(argv)`), the group can swap the
 * subprocess for a direct call with no user-facing change.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Windows resolves bins as `.cmd` shims; cross-spawn runs either, but we must probe both names. */
function binCandidates(binName: string): string[] {
	return process.platform === 'win32'
		? [`${binName}.cmd`, `${binName}.CMD`, binName]
		: [binName];
}

/**
 * Resolve a block's installed CLI bin from the app's `node_modules/.bin`.
 * Returns the absolute path to the bin, or `undefined` when the block is not
 * installed in this app (so the caller can print an actionable message).
 */
export function resolveBlockBin(
	binName: string,
	projectRoot: string = process.cwd(),
): string | undefined {
	const binDir = join(projectRoot, 'node_modules', '.bin');
	for (const candidate of binCandidates(binName)) {
		const full = join(binDir, candidate);
		if (existsSync(full)) {
			return full;
		}
	}
	return undefined;
}
