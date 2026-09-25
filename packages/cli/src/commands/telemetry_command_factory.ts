// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandModule } from 'yargs';
import { telemetry } from '../lib/telemetry.js';

interface TelemetryArgs {
	args?: string[];
}

/**
 * `blocks telemetry [--enable|--disable|--status] [--global]` — manage CLI
 * telemetry consent. `telemetry()` parses its own flags via `argv.slice(2)`, so
 * we reconstruct a `['node','blocks', ...flags]` argv from the forwarded args.
 */
export function createTelemetryCommand(): CommandModule<object, TelemetryArgs> {
	return {
		command: 'telemetry [args..]',
		describe: 'Manage CLI telemetry consent (enable | disable | status)',
		builder: (yargs) =>
			yargs.positional('args', {
				describe: 'Flags forwarded to telemetry (--enable | --disable | --status | --global)',
				type: 'string',
				array: true,
			}),
		handler: async (args) => {
			const flags = (args.args as string[] | undefined) ?? [];
			await telemetry({ argv: ['node', 'blocks', ...flags] });
		},
	};
}
