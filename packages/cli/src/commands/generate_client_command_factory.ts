// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandModule } from 'yargs';
import { join } from 'node:path';
import { writeClientCode } from '../lib/generate-client.js';
import { resolveAppPaths } from '../paths.js';

interface GenerateClientArgs {
	foundation?: string;
	output?: string;
}

/**
 * `blocks generate-client [foundation] [output]` — regenerate the app's typed
 * client. Defaults to `aws-blocks/index.ts` → `aws-blocks/client.js`.
 */
export function createGenerateClientCommand(): CommandModule<object, GenerateClientArgs> {
	return {
		command: 'generate-client [foundation] [output]',
		describe: 'Regenerate the typed client from the backend foundation',
		builder: (yargs) =>
			yargs
				.positional('foundation', {
					type: 'string',
					describe: 'Backend foundation entry (default aws-blocks/index.ts)',
				})
				.positional('output', {
					type: 'string',
					describe: 'Output client path (default aws-blocks/client.js)',
				}),
		handler: async (args) => {
			const { appDir, backendPath } = resolveAppPaths();
			const foundation = args.foundation ?? backendPath;
			const output = args.output ?? join(appDir, 'client.js');
			await writeClientCode(foundation, output);
		},
	};
}
