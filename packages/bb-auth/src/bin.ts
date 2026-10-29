#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `bb-auth` bin. It dispatches on the first argument:
 *
 * - `npx @aws-blocks/bb-auth migrate [paths…] [--dry-run]` — the codemod; see `migrate/cli.ts`.
 * - `npx @aws-blocks/bb-auth users <command> …` — group membership (the first
 *   admin), locally or on a deployed stack; see `users-cli/cli.ts`.
 *
 * Anything else (no command, `--help`, an unknown command) goes to `migrate`'s
 * entry point, which prints the usage, as before `users` existed. Each command
 * is loaded only when it runs.
 */

const argv = process.argv.slice(2);
const run =
	argv[0] === 'users'
		? import('./users-cli/cli.js').then(({ runUsersCli }) => runUsersCli(argv.slice(1)))
		: import('./migrate/cli.js').then(({ main }) => main(argv));

run.then(
	(code) => {
		process.exitCode = code;
	},
	(e: unknown) => {
		console.error(e instanceof Error ? e.message : String(e));
		process.exitCode = 1;
	},
);
