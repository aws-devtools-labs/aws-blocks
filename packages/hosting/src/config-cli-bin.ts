#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `hosting-config` — a ready-to-run CLI for **config** values (SSM Parameter
 * Store) in apps that consume `@aws-blocks/hosting` directly. The secret
 * counterpart is `hosting-secret` (AWS Secrets Manager).
 *
 *   npx hosting-config set <KEY> [<value>] [--value-stdin] [--stage <name>] [--prefix <path>]
 *   npx hosting-config list [--stage <name>] [--prefix <path>]
 *   npx hosting-config remove <KEY> [--stage <name>] [--prefix <path>]
 */

import { runValueCli } from './secret-cli.js';

runValueCli(process.argv.slice(2), { kind: 'config', label: 'hosting-config' }).catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
