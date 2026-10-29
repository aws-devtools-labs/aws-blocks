#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** The `bb-auth` bin: `npx @aws-blocks/bb-auth migrate [paths…] [--dry-run]`. See `cli.ts`. */

import { main } from './cli.js';

main(process.argv.slice(2)).then((code) => {
	process.exitCode = code;
});
