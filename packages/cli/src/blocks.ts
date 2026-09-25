#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `blocks` — the AWS Blocks command-line interface entrypoint.
 *
 * Builds the yargs parser, parses argv, and routes failures through the
 * shared error handler so users see a single clean message rather than a
 * raw stack trace.
 */

import { hideBin } from 'yargs/helpers';
import { createMainParser } from './main_parser_factory.js';
import { reportError } from './error_handler.js';

async function main(): Promise<void> {
	const parser = createMainParser(hideBin(process.argv));
	// `.fail(false)` lets us route yargs validation errors through our handler
	// instead of yargs printing and exiting on its own.
	parser.fail((msg, err) => {
		throw err ?? new Error(msg);
	});
	await parser.parseAsync();
}

main().catch((error) => {
	reportError(error);
});
