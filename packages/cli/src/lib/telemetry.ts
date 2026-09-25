// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { getTelemetryStatus, getGlobalConfigPath, getProjectConfigPath } from '@aws-blocks/core/runtime';
import { writeConfigTelemetry } from '@aws-blocks/core/runtime';

export interface TelemetryOptions {
  argv?: string[];
}

interface ParsedFlags {
  action: 'enable' | 'disable' | 'status' | 'help';
  global: boolean;
}

function printUsage(): void {
  console.log(`Usage: npx blocks-telemetry [options]

Options:
  --enable           Enable telemetry collection
  --disable          Disable telemetry collection
  --status           Show current telemetry status
  --global           Apply globally (~/.blocks/config.json)
                     Without this flag, applies to current project (.blocks/config.json)
  --help, -h         Show this help message

Examples:
  npx blocks-telemetry --status           # Show current status
  npx blocks-telemetry --enable           # Enable for current project
  npx blocks-telemetry --disable          # Disable for current project
  npx blocks-telemetry --enable --global  # Enable globally
  npx blocks-telemetry --disable --global # Disable globally

Environment:
  AWS_BLOCKS_DISABLE_TELEMETRY=1              Disables telemetry (overrides config files)
`);
}

const KNOWN_FLAGS = ['--enable', '--disable', '--status', '--global', '--help', '-h'];

function parseFlags(argv: string[]): ParsedFlags {
  const args = argv.slice(2);

  const unknownFlags = args.filter(a => a.startsWith('-') && !KNOWN_FLAGS.includes(a));
  if (unknownFlags.length > 0) {
    console.warn(`Unknown option(s): ${unknownFlags.join(', ')}. These will be ignored. Run 'npx blocks-telemetry --help' to see available options.`);
  }

  const help = args.includes('--help') || args.includes('-h');
  const enable = args.includes('--enable');
  const disable = args.includes('--disable');
  const statusFlag = args.includes('--status');
  const global = args.includes('--global');

  if (enable && disable) {
    console.error('Error: --enable and --disable are mutually exclusive.');
    console.error('Run with --help for usage information.');
    process.exit(1);
  }

  let action: 'enable' | 'disable' | 'status' | 'help' = 'help';
  if (statusFlag) action = 'status';
  if (enable) action = 'enable';
  if (disable) action = 'disable';
  if (help) action = 'help';

  return { action, global };
}

function handleEnable(global: boolean): void {
  const configPath = global ? getGlobalConfigPath() : getProjectConfigPath();

  try {
    writeConfigTelemetry(configPath, true);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Failed to write config: ${message}`);
    process.exit(1);
  }

  if (global) {
    console.log('✅ Telemetry enabled globally.');
    console.log(`   Config: ${configPath}`);
  } else {
    console.log('✅ Telemetry enabled for this project.');
    console.log(`   Config: ${configPath}`);
  }
}

function handleDisable(global: boolean): void {
  const configPath = global ? getGlobalConfigPath() : getProjectConfigPath();

  try {
    writeConfigTelemetry(configPath, false);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Failed to write config: ${message}`);
    process.exit(1);
  }

  if (global) {
    console.log('✅ Telemetry disabled globally.');
    console.log(`   Config: ${configPath}`);
  } else {
    console.log('✅ Telemetry disabled for this project.');
    console.log(`   Config: ${configPath}`);
  }
}

function handleStatus(): void {
  const status = getTelemetryStatus();

  console.log('');
  console.log(`  Telemetry: ${status.enabled ? '✅ Enabled' : '❌ Disabled'}`);
  console.log('');

  const globalConfigPath = getGlobalConfigPath();
  const projectConfigPath = getProjectConfigPath();

  console.log('  Mechanisms:');

  if (status.envVar !== undefined) {
    console.log(`    AWS_BLOCKS_DISABLE_TELEMETRY = "${status.envVar}"`);
  } else {
    console.log(`    AWS_BLOCKS_DISABLE_TELEMETRY = (not set)`);
  }

  if (status.projectConfig !== undefined) {
    console.log(`    Project config (${projectConfigPath}): telemetry.enabled = ${status.projectConfig}`);
  } else {
    console.log(`    Project config (${projectConfigPath}): (not configured)`);
  }

  if (status.globalConfig !== undefined) {
    console.log(`    Global config (${globalConfigPath}): telemetry.enabled = ${status.globalConfig}`);
  } else {
    console.log(`    Global config (${globalConfigPath}): (not configured)`);
  }

  console.log('');
}

/**
 * Manage Blocks telemetry consent settings.
 *
 * Parses CLI flags from `process.argv` (or custom argv) and performs the
 * requested action:
 *
 * - `--enable` / `--disable` — toggle telemetry (project-level by default, `--global` for global)
 * - `--status` — display current telemetry status and mechanism values
 * - bare invocation (no flags) — prints help/usage text
 *
 * @param options.argv - Custom argv array (defaults to process.argv)
 */
export async function telemetry(options?: TelemetryOptions): Promise<void> {
  const argv = options?.argv ?? process.argv;
  const flags = parseFlags(argv);

  switch (flags.action) {
    case 'enable':
      handleEnable(flags.global);
      break;
    case 'disable':
      handleDisable(flags.global);
      break;
    case 'status':
      handleStatus();
      break;
    case 'help':
      printUsage();
      break;
  }
}
