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
		.version(cliVersion())
		.strict()
		.demandCommand(1, 'You must specify a command. Run `blocks --help` to see all commands.')
		.help()
		.recommendCommands();
}
