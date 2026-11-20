// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Package script entry: `node --input-type=module -e "import 'aws-cdk-blocks/run'" -- <task>`. */

import { CLI_CLOSED_OUTPUT_CODES } from './closed-output.js';
import { coreMismatchError } from './core-load.js';
import { formatError } from './errors.js';

// Imported here rather than statically, so that a part of the CLI that imports an
// entry of an installed @aws-cdk-blocks/core that does not match it fails with the
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

// A closed terminal or pipe (for example `npm run sandbox | tee log` after a Ctrl-C)
// must not kill this parent while its runner still works: drop the write error, as core's
// ignoreClosedOutput() does for the runners. Not imported from `@aws-cdk-blocks/core/scripts`:
// loading that entry takes about 0.6 s, on every command (see CLI_CLOSED_OUTPUT_CODES).
for (const stream of [process.stdout, process.stderr]) {
	stream.on('error', (error: NodeJS.ErrnoException) => {
		if (!CLI_CLOSED_OUTPUT_CODES.includes(error.code ?? '')) throw error;
	});
}

// Set explicitly: Node does not exit 130 on its own once a SIGINT handler is installed.
// `node -e` has no script name in argv[1]. Restore the standard Node argv shape for
// in-process core functions (including telemetry), which read the actual process.argv.
process.argv.splice(1, 0, import.meta.filename);
process.exitCode = await main(process.argv.slice(2));
