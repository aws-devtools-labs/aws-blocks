// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `deployTimeLambdaCode` / `deployTimeLambdaEntry` in both layouts a Building
 * Block's CDK code runs from: installed (`dist/` holds the `build:lambda` bundle
 * or the compiled handler) and vendorized (`src/` only — `blocks-vendorize`
 * copies no `dist/`), plus the error when neither is there.
 *
 * The fixture lives inside this package so esbuild resolves from it exactly as
 * it resolves from a vendorized copy inside an app.
 */

import assert from 'node:assert';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { deployTimeLambdaCode, deployTimeLambdaEntry } from './lambda-code.js';
import { DEFAULT_NODE_RUNTIME } from './node-version.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), `.lambda-code-fixture.${process.pid}`);
after(() => rmSync(FIXTURE, { recursive: true, force: true }));

/** A package directory with `cdk/owner.<ext>` creating the Lambda, and whatever `files` are given. */
function fixturePackage(name: string, files: Record<string, string>): string {
	const root = join(FIXTURE, name);
	mkdirSync(join(root, 'src', 'cdk'), { recursive: true });
	writeFileSync(join(root, 'package.json'), '{"name":"fixture","type":"module"}');
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return pathToFileURL(join(root, 'src', 'cdk', 'owner.ts')).href;
}

/** Synthesizes one Function with `code` and returns its asset's `index.js`. */
function synthesizedHandler(code: lambda.Code): string {
	const outdir = join(FIXTURE, `cdk.out.${Math.random().toString(36).slice(2)}`);
	const app = new cdk.App({ outdir, context: { 'aws:cdk:enable-asset-metadata': true } });
	const stack = new cdk.Stack(app, 'S');
	new lambda.Function(stack, 'Fn', { runtime: DEFAULT_NODE_RUNTIME, handler: 'index.handler', code });
	const assembly = app.synth();
	const template = assembly.getStackByName('S').template as {
		Resources: Record<string, { Type: string; Metadata?: Record<string, string> }>;
	};
	const fn = Object.values(template.Resources).find((r) => r.Type === 'AWS::Lambda::Function');
	const assetPath = fn?.Metadata?.['aws:asset:path'];
	assert.ok(assetPath, 'the Function has a code asset');
	return readFileSync(join(outdir, assetPath, 'index.js'), 'utf8');
}

const SPEC = { bundleDir: '../handler-lambda', source: './handler' } as const;

describe('deployTimeLambdaCode', () => {
	test('installed layout: the pre-built bundle is used as-is', () => {
		const moduleUrl = fixturePackage('installed', {
			'src/handler-lambda/index.js': 'exports.handler = async () => "PREBUILT";\n',
			// Present too, and must be ignored: the bundle wins.
			'src/cdk/handler.ts': 'export const handler = async () => "FROM_SOURCE";\n',
		});
		const handler = synthesizedHandler(deployTimeLambdaCode({ moduleUrl, ...SPEC }));
		assert.match(handler, /PREBUILT/);
		assert.doesNotMatch(handler, /FROM_SOURCE/);
	});

	test('vendorized layout (no bundle): the TypeScript source is bundled at synth, local imports included', () => {
		const moduleUrl = fixturePackage('vendorized', {
			'src/cdk/handler.ts': "import { reply } from './reply.js';\nexport const handler = async () => reply();\n",
			'src/cdk/reply.ts': "export const reply = (): string => 'VENDORIZED_SOURCE';\n",
		});
		const handler = synthesizedHandler(deployTimeLambdaCode({ moduleUrl, ...SPEC }));
		assert.match(handler, /VENDORIZED_SOURCE/, 'the imported module is bundled in');
		assert.match(handler, /module\.exports/, 'CommonJS, as build:lambda emits');
	});

	test('neither bundle nor source: an actionable error naming the missing bundle', () => {
		const moduleUrl = fixturePackage('broken', {});
		assert.throws(
			() => deployTimeLambdaCode({ moduleUrl, ...SPEC }),
			(e: unknown) =>
				e instanceof Error &&
				e.message.includes('deploy-time Lambda bundle of fixture is missing') &&
				e.message.includes(join('handler-lambda', 'index.js')) &&
				e.message.includes('npm run build:lambda'),
		);
	});
});

describe('deployTimeLambdaEntry', () => {
	const ownerDir = (url: string) => dirname(fileURLToPath(url));

	test('installed layout: the compiled .js handler, even when a .ts sits beside it', () => {
		const moduleUrl = fixturePackage('entry-installed', {
			'src/cdk/migration-lambda.js': 'exports.handler = async () => {};\n',
			'src/cdk/migration-lambda.ts': 'export const handler = async () => {};\n',
		});
		assert.strictEqual(
			deployTimeLambdaEntry(moduleUrl, './migration-lambda'),
			join(ownerDir(moduleUrl), 'migration-lambda.js'),
		);
	});

	test('vendorized layout: the .ts source', () => {
		const moduleUrl = fixturePackage('entry-vendorized', {
			'src/cdk/migration-lambda.ts': 'export const handler = async () => {};\n',
		});
		assert.strictEqual(
			deployTimeLambdaEntry(moduleUrl, './migration-lambda'),
			join(ownerDir(moduleUrl), 'migration-lambda.ts'),
		);
	});

	test('neither: an actionable error naming both candidates', () => {
		const moduleUrl = fixturePackage('entry-broken', {});
		assert.throws(
			() => deployTimeLambdaEntry(moduleUrl, './migration-lambda'),
			(e: unknown) =>
				e instanceof Error &&
				e.message.includes('deploy-time Lambda handler of fixture is missing') &&
				e.message.includes('migration-lambda.js') &&
				e.message.includes('migration-lambda.ts'),
		);
	});
});
