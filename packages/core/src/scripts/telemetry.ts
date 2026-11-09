// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getTelemetryStatus, getGlobalConfigPath, getProjectConfigPath, isDisableValue, type TelemetryStatus } from '../telemetry/consent.js';
import { writeConfigTelemetry } from '../telemetry/config-writer.js';

export interface TelemetryOptions {
  argv?: string[];
}

interface ParsedFlags {
  action: 'enable' | 'disable' | 'status' | 'help';
  global: boolean;
}

function printUsage(): void {
  console.log(`Usage: npx --no -- cdk-blocks telemetry [status|enable|disable] [--global]
       npx blocks-telemetry [options]   (the older form; same options as flags)

Options:
  --enable           Enable telemetry collection
                     A disable from any other mechanism still wins; see --status
  --disable          Disable telemetry collection
  --status           Show current telemetry status
  --global           Apply globally (~/.blocks/config.json)
                     Without this flag, applies to the project (.blocks/config.json at the
                     nearest directory with package.json and aws-blocks/, else the current one)
  --help, -h         Show this help message

Examples:
  npx blocks-telemetry --status           # Show current status
  npx blocks-telemetry --enable           # Enable for current project
  npx blocks-telemetry --disable          # Disable for current project
  npx blocks-telemetry --enable --global  # Enable globally
  npx blocks-telemetry --disable --global # Disable globally

Environment:
  AWS_BLOCKS_DISABLE_TELEMETRY=1|true|yes     Disables telemetry (overrides config files)
                                              Case-insensitive; surrounding whitespace ignored
  BLOCKS_TELEMETRY_ENDPOINT=<url>             Sends events to <url> instead of the collector
                                              Send failures are ignored; the command is unaffected
  AWS_BLOCKS_DISABLE_TEMPLATE_METADATA=1|true|yes
                                              Omits AWSToolsMetrics.AWSBlocks from CloudFormation templates
                                              Also: -c blocks:template-metadata=false or cdk --no-version-reporting
                                              Separate from telemetry; --disable does not affect it
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

/**
 * Branches in the order `getTelemetryStatus` resolves the mechanisms. Only called
 * when `status.enabled` is false, so one of the three always holds and the final
 * `return` needs no guard.
 */
function describeDisable(status: TelemetryStatus, projectRoot?: string): string {
  if (isDisableValue(status.envVar)) return `AWS_BLOCKS_DISABLE_TELEMETRY="${status.envVar}"`;
  if (status.projectConfig === false) return `the project config (${getProjectConfigPath(projectRoot)})`;
  return `the global config (${getGlobalConfigPath()})`;
}

/**
 * The project root: the nearest directory at or above `start` that holds both a
 * `package.json` and an `aws-blocks/` directory, or `start` itself when none does.
 *
 * Mirrors `findProjectRoot` in `packages/blocks/src/cli/context.ts` (core cannot
 * import from `@aws-blocks/blocks`); keep the two rules in step.
 */
function resolveProjectRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    const appDir = join(dir, 'aws-blocks');
    if (existsSync(join(dir, 'package.json')) && existsSync(appDir) && statSync(appDir).isDirectory()) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

function handleEnable(global: boolean): void {
  const projectRoot = resolveProjectRoot();
  const configPath = global ? getGlobalConfigPath() : getProjectConfigPath(projectRoot);

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

  const status = getTelemetryStatus(projectRoot);
  if (!status.enabled) {
    console.warn(`⚠️  Telemetry is still disabled by ${describeDisable(status, projectRoot)}.`);
    console.warn('   Any disable wins, so this file cannot override it. Run --status to see every mechanism.');
  }
}

function handleDisable(global: boolean): void {
  const projectRoot = resolveProjectRoot();
  const configPath = global ? getGlobalConfigPath() : getProjectConfigPath(projectRoot);

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

  // Read the result back the way the send gate does, so a write that did not take
  // effect is reported instead of claimed.
  const status = getTelemetryStatus(projectRoot);
  if (status.enabled) {
    console.error(`⚠️  Telemetry is still enabled after writing ${configPath}.`);
    console.error('   Run --status to see every mechanism, or set AWS_BLOCKS_DISABLE_TELEMETRY=1.');
    process.exit(1);
  }
}

function handleStatus(): void {
  const projectRoot = resolveProjectRoot();
  const status = getTelemetryStatus(projectRoot);

  console.log('');
  console.log(`  Telemetry: ${status.enabled ? '✅ Enabled' : '❌ Disabled'}`);
  console.log('');

  const globalConfigPath = getGlobalConfigPath();
  const projectConfigPath = getProjectConfigPath(projectRoot);

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
 * - `--enable` / `--disable` — write `telemetry.enabled` (project-level by default, `--global` for global)
 *   The project-level file is `.blocks/config.json` at the project root: the nearest directory at or
 *   above the working directory holding a `package.json` and an `aws-blocks/` directory, else the
 *   working directory. `--disable` reads the status back and exits non-zero if telemetry is still enabled.
 * - `--status` — display current telemetry status and mechanism values (reading the same project root)
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
