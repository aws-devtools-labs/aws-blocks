#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** The `blocks` and `cdk-blocks` bins of `@aws-blocks/blocks`. */

import { coreMismatchError } from './core-load.js';
import { formatError } from './errors.js';

// Imported here rather than statically, so that a part of the CLI that imports an
// entry of an installed @aws-blocks/core that does not match it fails with the
// reinstall message, even for --version and --help, not with Node's raw error.
let main: typeof import('./main.js').main;
try {
	({ main } = await import('./main.js'));
} catch (error) {
	const mismatch = coreMismatchError(error);
	if (!mismatch) throw error;
	const debug = process.argv.includes('--debug');
	process.stderr.write(formatError(mismatch, { debug, verbose: false, color: false }));
	process.exit(1);
}

// A closed terminal or pipe (`cdk-blocks sandbox | tee log` after a Ctrl-C, `blocks … | head`)
// must not kill this parent while its runner still works: drop the write error, as core's
// ignoreClosedOutput() does for the runners. Not imported from `@aws-blocks/core/scripts`:
// loading that entry takes about 0.6 s, on every command.
for (const stream of [process.stdout, process.stderr]) {
	stream.on('error', (error: NodeJS.ErrnoException) => {
		if (error.code !== 'EPIPE' && error.code !== 'EIO' && error.code !== 'ERR_STREAM_DESTROYED') throw error;
	});
}

// Set explicitly: Node does not exit 130 on its own once a SIGINT handler is installed.
process.exitCode = await main(process.argv.slice(2));
