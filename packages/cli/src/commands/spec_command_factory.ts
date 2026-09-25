// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandModule } from 'yargs';
import { runGenerateSpec } from '../lib/generate-spec-cli.js';
import { resolveAppPaths } from '../paths.js';

interface SpecArgs {
	backend?: string;
	output?: string;
}

/**
 * `blocks spec [backend] [output]` — generate the OpenRPC spec
 * (`aws-blocks/blocks.spec.json`) from the backend foundation. Defaults to the
 * app's `aws-blocks/index.ts` / `aws-blocks/blocks.spec.json`.
 */
export function createSpecCommand(): CommandModule<object, SpecArgs> {
	return {
		command: 'spec [backend] [output]',
		describe: 'Generate the OpenRPC spec from the backend foundation',
		builder: (yargs) =>
			yargs
				.positional('backend', {
					type: 'string',
					describe: 'Backend foundation entry (default aws-blocks/index.ts)',
				})
				.positional('output', {
					type: 'string',
					describe: 'Output spec path (default alongside the backend)',
				}),
		handler: async (args) => {
			const { backendPath } = resolveAppPaths();
			await runGenerateSpec(args.backend ?? backendPath, args.output);
		},
	};
}
