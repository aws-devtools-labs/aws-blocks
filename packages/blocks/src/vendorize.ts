#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI entry point for the vendorize command.
 *
 * Usage: blocks-vendorize <package-name> [--force]
 * Example: blocks-vendorize @aws-blocks/bb-kv-store
 *
 * `-h`/`--help` anywhere prints the usage and exits 0 before anything is copied
 * or installed.
 */
import { vendorize } from './vendorize/index.js';
import { trackCommand } from '@aws-blocks/core/scripts';

const USAGE = `Usage: blocks-vendorize <package-name> [--force]

Copy the published source of a Building Block into vendor/<name>/ of the workspace root,
add vendor/<name> to "workspaces", run npm install to re-link it, and write
vendor/<name>/VENDORIZE.md with migration notes.

Options:
  --force       Delete an existing vendor/<name>/ first and copy it again.
  -h, --help    Print this help and exit.

Example: blocks-vendorize @aws-blocks/bb-kv-store`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const force = args.includes('--force');
const packageName = args.find(a => !a.startsWith('--'));

if (!packageName) {
  console.error('Usage: blocks-vendorize <package-name> [--force]');
  console.error('Example: blocks-vendorize @aws-blocks/bb-kv-store');
  process.exit(1);
}

trackCommand('vendorize', async () => {
  vendorize(packageName, { force });
});
