// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Pre-bundle the AgentCore Runtime entrypoint that ships inside @aws-blocks/bb-agent
// into a self-contained ESM file at BUILD time, so the CDK Runtime construct can
// package it with a plain `Code.fromAsset(...)` / `AgentRuntimeArtifact.fromCodeAsset(...)`
// (no synth-time bundling, no projectRoot/lockfile discovery).
//
// Why: like the Lambda-handler case (see packages/hosting/scripts/bundle-handlers.mjs),
// synth-time bundling of an npm-installed package fails with PathNotUnderRoot once
// bb-agent lives under a consumer's node_modules. fromCodeAsset just zips a directory,
// so we hand it a ready, self-contained bundle.
//
// IMPORTANT: bundle with `conditions: ['aws-runtime', ...]` so bb-agent's own
// `@aws-blocks/*` imports resolve to their `index.aws.js` variants inside the bundle —
// matching how core bundles the Lambda handler (esbuildArgs { '--conditions': 'aws-runtime' }).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');

const entry = join(pkgRoot, 'dist', 'agentcore-entry.js');
// Output into its own directory so `Code.fromAsset(dirname(outfile))` zips ONLY the bundle.
const outfile = join(pkgRoot, 'dist', 'agentcore', 'agentcore-entry.js');

await build({
	entryPoints: [entry],
	outfile,
	bundle: true,
	platform: 'node',
	// Match AgentCoreRuntime.NODE_22.
	target: 'node22',
	format: 'esm',
	minify: true,
	// Resolve @aws-blocks/* to their AWS-runtime (index.aws.js) variants, exactly as the
	// Lambda handler is bundled. Without this the entrypoint would pull the mock classes.
	conditions: ['aws-runtime', 'import', 'node'],
	// The AWS SDK v3 is present in the AgentCore Node 22 base image; externalize it.
	// Strands, bedrock-agentcore, and zod are NOT in the baseline, so they get bundled.
	external: ['@aws-sdk/*'],
	// Shim `require` for any CJS interop the bundled deps do under ESM output.
	banner: {
		js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
	},
});

// eslint-disable-next-line no-console
console.log(`✓ bundled AgentCore entrypoint → ${outfile}`);
