// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	isMissingDeployRecord,
	OUTPUTS_FILE,
	outputsFilePath,
	parseStageArg,
	readBackendStack,
	selectBackendStack,
} from './deploy-outputs.js';

function scratchRoot(): string {
	return mkdtempSync(join(tmpdir(), 'blocks-outputs-'));
}

/** Write a stage's outputs file under `root`, creating its directory. */
function writeOutputs(root: string, stage: 'sandbox' | 'production', document: unknown): string {
	const file = outputsFilePath(stage, root);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(file, JSON.stringify(document));
	return file;
}

describe('outputs file paths', () => {
	it('gives each stage its own file', () => {
		// The point of the fix: a production deploy must not be able to overwrite
		// the sandbox's record, and vice versa. The CDK CLI replaces this file
		// rather than merging into it.
		assert.notStrictEqual(OUTPUTS_FILE.production, OUTPUTS_FILE.sandbox);
	});

	it('keeps the sandbox at its established path', () => {
		// Existing sandboxes, the Windows template E2E and every hosting test-app
		// read this exact path; moving it would be a gratuitous break.
		assert.strictEqual(OUTPUTS_FILE.sandbox, '.blocks-sandbox/outputs.json');
	});

	it('keeps both stages in the already-gitignored directory, under distinct names', () => {
		// Two distinct FILE NAMES are what stops one stage erasing the other; the
		// shared DIRECTORY is what keeps either from being committed. A generated
		// app commits `.blocks/` (it carries the stackId in config.json, D-012),
		// so a per-deploy file there would need an explicit per-file ignore in
		// every template, example and scaffold path — and whichever consumer
		// forgot one would commit a developer's deployment record.
		// `.blocks-sandbox/` is ignored everywhere already.
		assert.strictEqual(OUTPUTS_FILE.production, '.blocks-sandbox/outputs.production.json');
		for (const file of Object.values(OUTPUTS_FILE)) {
			assert.ok(
				file.startsWith('.blocks-sandbox/'),
				`${file} must live in the gitignored .blocks-sandbox/, not in the committed .blocks/`,
			);
		}
		assert.notStrictEqual(OUTPUTS_FILE.production, OUTPUTS_FILE.sandbox);
	});

	it('returns the project-relative form when no root is given', () => {
		// `cdk deploy --outputs-file` runs with cwd = project root.
		assert.strictEqual(outputsFilePath('production'), '.blocks-sandbox/outputs.production.json');
	});

	it('joins onto a project root when one is given', () => {
		assert.strictEqual(
			outputsFilePath('production', '/app'),
			join('/app', '.blocks-sandbox', 'outputs.production.json'),
		);
	});
});

describe('selectBackendStack', () => {
	const outputsFile = '/app/.blocks-sandbox/outputs.production.json';

	it('selects the backend stack regardless of position', () => {
		// `cdk deploy --all` on an app with a Lambda@Edge route writes the edge
		// stack too, and it can come first.
		const selected = selectBackendStack({
			document: {
				'edge-lambda-stack-c8a9': { Version: '3' },
				'app-prod': { ApiUrl: 'https://prod.example' },
			},
			outputsFile,
		});
		assert.strictEqual(selected.stackName, 'app-prod');
		assert.strictEqual(selected.outputs.ApiUrl, 'https://prod.example');
	});

	it('identifies the stack by content, not by a naming convention', () => {
		// Only the scaffolded templates name stacks with getStackName; every test
		// app in this repo and both native examples hand-roll the name, so nothing
		// in the deploy path may assume a derivable name.
		const selected = selectBackendStack({
			document: { 'bb-test-prod-pr-1234-1-ci-abc123': { ApiUrl: 'https://ci.example' } },
			outputsFile,
		});
		assert.strictEqual(selected.stackName, 'bb-test-prod-pr-1234-1-ci-abc123');
	});

	it('reports an empty document as a probable failed deploy', () => {
		// The CDK CLI writes the file from a `finally` block, so a deploy that
		// failed on its first stack leaves `{}` behind — which must not be read as
		// "the stack is gone".
		assert.throws(
			() => selectBackendStack({ document: {}, outputsFile, stage: 'production' }),
			/holds no stacks[\s\S]*deploy failed[\s\S]*npm run deploy/,
		);
	});

	it('names the stacks it did find when none is a backend stack', () => {
		assert.throws(
			() =>
				selectBackendStack({
					document: { 'edge-lambda-stack-c8a9': { Version: '3' } },
					outputsFile,
					stage: 'production',
				}),
			/no stack publishing the ApiUrl output[\s\S]*edge-lambda-stack-c8a9/,
		);
	});

	it('refuses to guess between two backend stacks', () => {
		assert.throws(
			() =>
				selectBackendStack({
					document: {
						'app-prod': { ApiUrl: 'https://a.example' },
						'app-other': { ApiUrl: 'https://b.example' },
					},
					outputsFile,
				}),
			/2 stacks publishing the ApiUrl output[\s\S]*refusing to guess/,
		);
	});

	it('ignores a non-string output value for the required key', () => {
		assert.throws(
			() => selectBackendStack({ document: { 'app-prod': { ApiUrl: 42 } }, outputsFile }),
			/no stack publishing the ApiUrl output/,
		);
	});

	it('honours a different required output key', () => {
		const selected = selectBackendStack({
			document: { a: { ApiUrl: 'https://a.example' }, b: { Special: 'yes' } },
			outputsFile,
			requiredOutput: 'Special',
		});
		assert.strictEqual(selected.stackName, 'b');
	});

	it('rejects a document that is not an object', () => {
		assert.throws(
			() => selectBackendStack({ document: [], outputsFile }),
			/not a CDK outputs document/,
		);
	});
});

describe('readBackendStack', () => {
	it('reads the stage its caller asked for', () => {
		const root = scratchRoot();
		writeOutputs(root, 'production', { 'app-prod': { ApiUrl: 'https://prod.example' } });
		writeOutputs(root, 'sandbox', { 'app-dev-a1b2c3': { ApiUrl: 'https://sandbox.example' } });

		assert.strictEqual(
			readBackendStack({ stage: 'production', projectRoot: root }).outputs.ApiUrl,
			'https://prod.example',
		);
		assert.strictEqual(
			readBackendStack({ stage: 'sandbox', projectRoot: root }).outputs.ApiUrl,
			'https://sandbox.example',
		);
	});

	it('does not answer with the other stage when its own file is missing', () => {
		// Pre-fix, both stages shared one file, so this read returned the
		// sandbox's ApiUrl as production's.
		const root = scratchRoot();
		writeOutputs(root, 'sandbox', { 'app-dev-a1b2c3': { ApiUrl: 'https://sandbox.example' } });

		assert.throws(
			() => readBackendStack({ stage: 'production', projectRoot: root }),
			(error: Error) => {
				assert.match(error.message, /No production outputs file/);
				assert.match(error.message, /npm run deploy/);
				assert.ok(
					!error.message.includes('sandbox.example'),
					'must not surface the other stage’s values',
				);
				return true;
			},
		);
	});

	it('distinguishes a missing file from a file with no backend stack', () => {
		const root = scratchRoot();
		writeOutputs(root, 'production', { 'edge-lambda-stack-c8a9': { Version: '3' } });

		assert.throws(
			() => readBackendStack({ stage: 'production', projectRoot: root }),
			/no stack publishing the ApiUrl output/,
		);
	});

	it('honours an explicit outputsFile override', () => {
		// The sandbox path is configurable via startSandbox({ outDir }).
		const root = scratchRoot();
		const file = join(root, 'elsewhere.json');
		writeFileSync(file, JSON.stringify({ 'app-dev': { ApiUrl: 'https://elsewhere.example' } }));

		assert.strictEqual(
			readBackendStack({ stage: 'sandbox', outputsFile: file }).outputs.ApiUrl,
			'https://elsewhere.example',
		);
	});

	it('reports invalid JSON as such', () => {
		const root = scratchRoot();
		const file = outputsFilePath('production', root);
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(file, '{ not json');

		assert.throws(
			() => readBackendStack({ stage: 'production', projectRoot: root }),
			/is not valid JSON/,
		);
	});

	it('marks ONLY the missing-file failure as a missing record', () => {
		// The marker is what lets a caller substitute a derived name for "not
		// deployed" without also swallowing "this record cannot be read". Every
		// unusable-record case must therefore stay unmarked.
		const root = scratchRoot();
		const thrown = (run: () => void): unknown => {
			try {
				run();
			} catch (error) {
				return error;
			}
			throw new Error('expected a throw');
		};

		// Missing file → marked.
		assert.strictEqual(
			isMissingDeployRecord(thrown(() => readBackendStack({ stage: 'production', projectRoot: root }))),
			true,
		);

		// Present but unusable → NOT marked, in all three shapes.
		writeOutputs(root, 'production', {});
		assert.strictEqual(
			isMissingDeployRecord(thrown(() => readBackendStack({ stage: 'production', projectRoot: root }))),
			false,
		);

		writeOutputs(root, 'production', {
			a: { ApiUrl: 'https://a.example' },
			b: { ApiUrl: 'https://b.example' },
		});
		assert.strictEqual(
			isMissingDeployRecord(thrown(() => readBackendStack({ stage: 'production', projectRoot: root }))),
			false,
		);

		writeFileSync(outputsFilePath('production', root), '{ not json');
		assert.strictEqual(
			isMissingDeployRecord(thrown(() => readBackendStack({ stage: 'production', projectRoot: root }))),
			false,
		);
	});

	it('does not report an unrelated value as a missing record', () => {
		for (const value of [undefined, null, 'ENOENT', new Error('boom'), {}]) {
			assert.strictEqual(isMissingDeployRecord(value), false);
		}
	});
});

describe('parseStageArg', () => {
	it('defaults to sandbox', () => {
		assert.strictEqual(parseStageArg([]), 'sandbox');
	});

	it('honours an explicit fallback', () => {
		assert.strictEqual(parseStageArg([], 'production'), 'production');
	});

	it('accepts the flag spellings', () => {
		assert.strictEqual(parseStageArg(['--production']), 'production');
		assert.strictEqual(parseStageArg(['--prod']), 'production');
		assert.strictEqual(parseStageArg(['--sandbox'], 'production'), 'sandbox');
	});

	it('accepts --stage in both forms', () => {
		assert.strictEqual(parseStageArg(['--stage', 'production']), 'production');
		assert.strictEqual(parseStageArg(['--stage=prod']), 'production');
		assert.strictEqual(parseStageArg(['--stage=sandbox'], 'production'), 'sandbox');
	});

	it('ignores unrelated arguments', () => {
		assert.strictEqual(parseStageArg(['--verbose', '--production']), 'production');
	});

	it('rejects an unknown stage rather than defaulting', () => {
		// A typo must not silently act on the wrong deployment.
		assert.throws(() => parseStageArg(['--stage', 'staging']), /Unknown stage "staging"/);
	});

	it('refuses local with a reason, in every spelling', () => {
		// `local` is the repo's own third environment word (BLOCKS_TEST_ENV, the
		// dev server's `environment` field), so it gets a real answer rather than
		// "unknown stage": local deploys nothing, so no outputs file exists.
		for (const argv of [['--local'], ['--dev'], ['--stage', 'local'], ['--stage=dev']]) {
			assert.throws(
				() => parseStageArg(argv),
				(error: Error) =>
					/is not a deployment stage/.test(error.message) &&
					/\.bb-data\//.test(error.message) &&
					!/Unknown stage/.test(error.message),
				`expected a local-specific refusal for ${argv.join(' ')}`,
			);
		}
	});

	it('has no outputs file for local', () => {
		// The map stays two-valued: a `local` entry would push a stage with no
		// CloudFormation stack into readBackendStack and the console URL.
		assert.deepStrictEqual(Object.keys(OUTPUTS_FILE).sort(), ['production', 'sandbox']);
	});
});
