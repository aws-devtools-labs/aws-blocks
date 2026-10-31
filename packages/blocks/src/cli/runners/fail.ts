// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** How a lifecycle runner reports an error that ends it. */

import { log } from '@aws-blocks/core/scripts';

/**
 * Print the error's message and exit 1. The stack trace prints only at
 * `BLOCKS_LOG_LEVEL=debug` (`--debug`), as the CLI's own errors do: core has
 * usually printed its guidance for the failure already.
 */
export function exitWithError(error: unknown): never {
	console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
	log.debugError(error);
	process.exit(1);
}
