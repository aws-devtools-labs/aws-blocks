// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandModule } from 'yargs';
import spawn from 'cross-spawn';

/**
 * `blocks vendorize [args...]` — copy Building Block source into the app.
 *
 * Delegates to the public `blocks-vendorize` bin shipped by `@aws-blocks/blocks`
 * rather than importing `@aws-blocks/blocks/vendorize` directly, because that
 * module self-invokes on import. We spawn it via `npm exec` so it resolves from
 * the consuming app's own dependency tree.
 */
export function createVendorizeCommand(): CommandModule {
	return {
		command: 'vendorize [args..]',
		describe: 'Vendorize Building Block source into the app',
		builder: (yargs) =>
			yargs.positional('args', {
				describe: 'Arguments forwarded to blocks-vendorize',
				type: 'string',
				array: true,
			}),
		handler: async (args) => {
			const passthrough = (args.args as string[] | undefined) ?? [];
			const result = spawn.sync('npm', ['exec', '--', 'blocks-vendorize', ...passthrough], {
				stdio: 'inherit',
			});
			if (result.status !== 0) {
				process.exitCode = result.status ?? 1;
			}
		},
	};
}
