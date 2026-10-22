// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synth probe for `test-support-synth.test.ts` (plumbing, not a test).
 *
 * Run as `tsx -C cdk test/test-support-synth.probe.ts <out.json>` with or
 * without `BLOCKS_TEST_ENV`. It synthesizes the comprehensive stack exactly as
 * `cdk synth` would (`aws-blocks/index.cdk.ts`), then writes a summary: the
 * synthesized template, the RPC namespaces recorded on the stack's compute, and
 * the methods of the backend module's `api` and `testSupport` exports (the very
 * module instance synth loaded, not a second copy).
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Template } from 'aws-cdk-lib/assertions';
import { blocksStack } from '../aws-blocks/index.cdk.js';

const out = process.argv[2];
if (!out) throw new Error('usage: test-support-synth.probe.ts <out.json>');

const backendPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'aws-blocks', 'index.ts');

// `BlocksStack.create` imports the backend as `<file URL>?stack=<stack id>`;
// the same specifier returns that cached instance.
const url = pathToFileURL(backendPath);
url.searchParams.set('stack', blocksStack.node.id);
const backend: Record<string, unknown> = await import(url.href);

/** Method names of an exported `ApiNamespace` (its handler, called with an empty context), or `null` if absent. */
function methodsOf(value: unknown): string[] | null {
	if (typeof value !== 'function') return null;
	const methods: unknown = value({});
	return typeof methods === 'object' && methods !== null ? Object.keys(methods).sort() : null;
}

/**
 * The RPC namespaces the backend registers: every export core tagged as an
 * `ApiNamespace` handler (`API_NAMESPACE_COMPUTE`, read by synth-time routing).
 */
const API_NAMESPACE_COMPUTE = Symbol.for('blocks:ApiNamespaceCompute');
const namespaces = Object.entries(backend)
	.filter(([, value]) => typeof value === 'function' && Reflect.get(value, API_NAMESPACE_COMPUTE) !== undefined)
	.map(([name]) => name)
	.sort();

/** The keys registered with `registerConfig` on the stack (core keeps the registry on the stack under a symbol). */
function configKeysOf(root: object): string[] {
	for (const sym of Object.getOwnPropertySymbols(root)) {
		const state: unknown = Reflect.get(root, sym);
		const entries: unknown = typeof state === 'object' && state !== null ? Reflect.get(state, 'entries') : undefined;
		if (entries instanceof Map) return [...entries.keys()].map(String).sort();
	}
	return [];
}

writeFileSync(
	out,
	JSON.stringify({
		configKeys: configKeysOf(blocksStack),
		apiMethods: methodsOf(backend.api),
		testSupportMethods: methodsOf(backend.testSupport),
		namespaces,
		template: Template.fromStack(blocksStack).toJSON(),
	}),
);
