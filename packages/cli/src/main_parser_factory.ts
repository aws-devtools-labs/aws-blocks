// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';
import yargs, { type Argv } from 'yargs';
import { createDeployCommand } from './commands/deploy_command_factory.js';
import { createDestroyCommand } from './commands/destroy_command_factory.js';
import { createSandboxCommand } from './commands/sandbox_command_factory.js';
import { createSandboxDestroyCommand } from './commands/sandbox_destroy_command_factory.js';
import { createConsoleCommand } from './commands/console_command_factory.js';
import { createDevCommand } from './commands/dev_command_factory.js';
import { createCleanupCommand } from './commands/cleanup_command_factory.js';
import { createSecretCommand } from './commands/secret_command_factory.js';
import { createConfigCommand } from './commands/config_command_factory.js';
import { createTypegenCommand } from './commands/typegen_command_factory.js';
import { createSpecCommand } from './commands/spec_command_factory.js';
import { createGenerateClientCommand } from './commands/generate_client_command_factory.js';
import { createVendorizeCommand } from './commands/vendorize_command_factory.js';
import { createTelemetryCommand } from './commands/telemetry_command_factory.js';
import { createHelpCommand } from './commands/help_command_factory.js';
import { levelFromFlags, setLogLevel } from './logger.js';

function cliVersion(): string {
	try {
		const require = createRequire(import.meta.url);
		// dist/main_parser_factory.js → ../package.json
		const pkg = require('../package.json') as { version?: string };
		return pkg.version ?? '0.0.0';
	} catch {
		return '0.0.0';
	}
}

/**
 * Build the `blocks` yargs parser with every command registered. Exported so
 * tests can drive it without spawning a process.
 */
export function createMainParser(argv: string[]): Argv {
	return yargs(argv)
		.scriptName('blocks')
		.usage('$0 <command> [options]')
		// Global verbosity flags — available on every command. A middleware
		// applies the resolved level before any handler runs, so all CLI output
		// (and spawned child processes, via BLOCKS_LOG_LEVEL) honour it.
		.option('verbose', {
			alias: 'v',
			type: 'boolean',
			describe: 'Print extra detail (resolved paths, spawned commands)',
			global: true,
		})
		.option('debug', {
			type: 'boolean',
			describe: 'Print debug detail and full stack traces on error',
			global: true,
		})
		.option('quiet', {
			alias: 'q',
			type: 'boolean',
			describe: 'Suppress non-essential output (errors are still shown)',
			global: true,
		})
		.middleware((args) => {
			setLogLevel(
				levelFromFlags({
					quiet: args.quiet as boolean | undefined,
					verbose: args.verbose as boolean | undefined,
					debug: args.debug as boolean | undefined,
				}),
			);
		})
		.command(createDeployCommand())
		.command(createDestroyCommand())
		.command(createSandboxCommand())
		.command(createSandboxDestroyCommand())
		.command(createConsoleCommand())
		.command(createDevCommand())
		.command(createCleanupCommand())
		.command(createSecretCommand())
		.command(createConfigCommand())
		.command(createTypegenCommand())
		.command(createSpecCommand())
		.command(createGenerateClientCommand())
		.command(createVendorizeCommand())
		.command(createTelemetryCommand())
		.command(createHelpCommand())
		.example('$0 sandbox', 'Deploy and watch a per-developer sandbox stack')
		.example('$0 deploy --verbose', 'Deploy to production with detailed output')
		.example('$0 help deploy', 'Show help for a specific command')
		.version(cliVersion())
		.alias('version', 'V')
		.strict()
		.demandCommand(1, 'You must specify a command. Run `blocks --help` to see all commands.')
		.help()
		.alias('help', 'h')
		.recommendCommands()
		.epilogue('Docs: https://github.com/aws-devtools-labs/aws-blocks  •  Run `blocks help <command>` for command details.')
		.wrap(Math.min(100, process.stdout.columns ?? 100));
}
