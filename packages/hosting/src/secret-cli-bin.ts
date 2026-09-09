#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `hosting-secret` — a ready-to-run CLI for **secrets** (AWS Secrets Manager) in
 * apps that consume `@aws-blocks/hosting` directly (standalone / pipeline). The
 * config counterpart is `hosting-config` (SSM Parameter Store).
 *
 *   npx hosting-secret set <KEY> [<value>] [--value-stdin] [--stage <name>] [--prefix <path>]
 *   npx hosting-secret list [--stage <name>] [--prefix <path>]
 *   npx hosting-secret remove <KEY> [--stage <name>] [--prefix <path>]
 */

import { runValueCli } from './secret-cli.js';

runValueCli(process.argv.slice(2), { kind: 'secret', label: 'hosting-secret' }).catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
