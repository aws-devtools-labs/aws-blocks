#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `hosting-secret` — a ready-to-run secret CLI for apps that consume
 * `@aws-blocks/hosting` (and `@aws-blocks/pipeline`) **directly**, without a
 * Blocks backend and its scaffolded `npm run secret` wrapper — i.e. a standalone
 * hosting/pipeline app or an Amplify consumer.
 *
 * It's the same command surface as the Blocks `npm run secret` (both wrap
 * {@link runSecretCli}), so such a consumer gets a provided tool out of the box
 * — no hand-written wrapper, no dropping to the raw AWS CLI/console.
 *
 * **Covers hosting and pipeline.** Pipeline secrets (`source.connectionArn`,
 * `buildSecrets`) live in the same store/namespace as hosting secrets and are
 * set with this same CLI — point `--prefix`/`--store` at the pipeline's
 * `secrets: { prefix, store }` and the values are written where the pipeline
 * reads them. One tool, one store, both surfaces.
 *
 * Usage:
 *   npx hosting-secret set  <KEY> [<value>] [--value-stdin] [--stage <name>] [--prefix <path>] [--store <ssm|secrets-manager>]
 *   npx hosting-secret list [--stage <name>] [--prefix <path>] [--store <ssm|secrets-manager>]
 *   npx hosting-secret remove <KEY> [--stage <name>] [--prefix <path>] [--store <ssm|secrets-manager>]
 *
 * Pass the SAME `--prefix` / `--store` your `HostingConstruct({ secrets })` (or
 * `Pipeline({ secrets })`) uses, so the value is written and read under the same
 * locator. Defaults match the construct defaults (neutral `/hosting/secrets`
 * prefix, Secrets Manager).
 *
 * Prefer `--value-stdin` (or the interactive prompt when no value is given) over
 * a positional value, which would land in your shell history / `ps` output.
 *
 * @module
 */
import { runSecretCli } from './secret-cli.js';

runSecretCli(process.argv.slice(2), { label: 'hosting-secret' }).catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
