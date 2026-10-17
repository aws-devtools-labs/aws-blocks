// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { BINDINGS_METADATA_KEY } from './constants.js';
import { predeploy } from './predeploy.js';

const bindings = (databases: Record<string, { cluster: string; type: 'distributed' }>) => ({
	Metadata: { [BINDINGS_METADATA_KEY]: { databases, clusters: {} } },
	Resources: {},
});

/** A CloudFormation client whose stack already exists with the given template. */
const deployedClient = (template: unknown) => ({
	async send(command: { constructor: { name: string } }) {
		switch (command.constructor.name) {
			case 'DescribeStacksCommand':
				return { Stacks: [{ Parameters: [] }] };
			case 'GetTemplateCommand':
				return { TemplateBody: JSON.stringify(template) };
			default:
				return {};
		}
	},
});

describe('predeploy hook', () => {
	test('sandbox: no synth, one note', async () => {
		let synths = 0;
		const result = await predeploy({
			stage: 'sandbox',
			projectRoot: '/app',
			synth: async () => {
				synths++;
				return [];
			},
		});
		assert.strictEqual(synths, 0);
		assert.deepStrictEqual(result.stops, undefined);
		assert.match(result.notes?.[0] ?? '', /sandbox stage skips the deploy guard/);
	});

	test('production: guards every synthesized stack and returns the stops', async () => {
		const deployed = bindings({ 'app-db': { cluster: 'default', type: 'distributed' } });
		const next = bindings({ 'app-db': { cluster: 'app-shared', type: 'distributed' } });
		const result = await predeploy(
			{ stage: 'production', projectRoot: '/app', synth: async () => [{ stackName: 'App', template: next }] },
			{ cloudFormation: deployedClient(deployed) },
		);
		assert.strictEqual(result.stops?.length, 1);
		assert.match(result.stops?.[0] ?? '', /Database 'app-db' is bound to its default cluster/);
	});

	test('production: a first deploy passes with a note', async () => {
		const client = {
			async send() {
				throw new Error('Stack with id App does not exist');
			},
		};
		const result = await predeploy(
			{
				stage: 'production',
				projectRoot: '/app',
				synth: async () => [{ stackName: 'App', template: bindings({}) }],
			},
			{ cloudFormation: client },
		);
		assert.deepStrictEqual(result.stops, []);
		assert.match(result.notes?.[0] ?? '', /^App: Stack App does not exist yet: first deploy/);
	});
});
