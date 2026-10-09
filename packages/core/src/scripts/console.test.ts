// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { resolveConsoleStack } from './console.js';
import { outputsFilePath } from './deploy-outputs.js';

/**
 * Every file under `root`, as `relative path -> contents`.
 *
 * Proving a function writes nothing needs the whole tree, not a named file: a
 * check for one expected path cannot see a write somewhere else.
 */
function treeFingerprint(root: string, dir = root, acc: Record<string, string> = {}): Record<string, string> {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) treeFingerprint(root, path, acc);
		else acc[relative(root, path)] = readFileSync(path, 'utf-8');
	}
	return acc;
}

/**
 * A project root shaped like a scaffolded app: a committed `.blocks/config.json`
 * carrying the stackId, plus this machine's sandbox id.
 */
function projectRoot(stackId = 'rota-3a4f18', sandboxId = 'philippa-bf9209'): string {
	const root = mkdtempSync(join(tmpdir(), 'blocks-console-'));
	mkdirSync(join(root, '.blocks'), { recursive: true });
	writeFileSync(join(root, '.blocks', 'config.json'), JSON.stringify({ stackId }));
	mkdirSync(join(root, '.blocks-sandbox'), { recursive: true });
	writeFileSync(join(root, '.blocks-sandbox', 'sandbox-id.txt'), sandboxId);
	return root;
}

function writeOutputs(root: string, stage: 'sandbox' | 'production', document: unknown): void {
	const file = outputsFilePath(stage, root);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(file, JSON.stringify(document));
}

describe('resolveConsoleStack', () => {
	it('opens the sandbox stack by default', () => {
		const root = projectRoot();
		writeOutputs(root, 'sandbox', {
			'rota-3a4f18-philippa-bf9209': { ApiUrl: 'https://sandbox.example' },
		});

		const resolved = resolveConsoleStack({ projectRoot: root });
		assert.strictEqual(resolved.stage, 'sandbox');
		assert.strictEqual(resolved.stackName, 'rota-3a4f18-philippa-bf9209');
		assert.strictEqual(resolved.note, undefined);
	});

	it('does not open production from a command asking for the sandbox', () => {
		// The live bug: `sandbox:console` read Object.keys(outputs)[0] from the
		// then-shared outputs file, so after a production deploy it opened
		// PRODUCTION. Production's record is now in its own file and is not
		// consulted for a sandbox request at all.
		const root = projectRoot();
		writeOutputs(root, 'production', { 'rota-3a4f18-prod': { ApiUrl: 'https://prod.example' } });

		const resolved = resolveConsoleStack({ projectRoot: root });
		assert.notStrictEqual(resolved.stackName, 'rota-3a4f18-prod');
		assert.strictEqual(resolved.stackName, 'rota-3a4f18-philippa-bf9209');
	});

	it('opens the production stack when asked for it', () => {
		const root = projectRoot();
		writeOutputs(root, 'production', { 'rota-3a4f18-prod': { ApiUrl: 'https://prod.example' } });

		const resolved = resolveConsoleStack({ projectRoot: root, stage: 'production' });
		assert.strictEqual(resolved.stage, 'production');
		assert.strictEqual(resolved.stackName, 'rota-3a4f18-prod');
		assert.strictEqual(resolved.note, undefined);
	});

	it('uses the recorded name even when it is not derivable', () => {
		// A hand-written index.cdk.ts names its stack whatever it likes, so the
		// deploy record — not getStackName — is the authority on what exists.
		const root = projectRoot();
		writeOutputs(root, 'production', {
			'bb-test-prod-pr-1234-1-ci-abc123': { ApiUrl: 'https://ci.example' },
		});

		const resolved = resolveConsoleStack({ projectRoot: root, stage: 'production' });
		assert.strictEqual(resolved.stackName, 'bb-test-prod-pr-1234-1-ci-abc123');
	});

	it('ignores a secondary stack that publishes no ApiUrl', () => {
		const root = projectRoot();
		writeOutputs(root, 'sandbox', {
			'edge-lambda-stack-c8a9': { Version: '3' },
			'rota-3a4f18-philippa-bf9209': { ApiUrl: 'https://sandbox.example' },
		});

		assert.strictEqual(
			resolveConsoleStack({ projectRoot: root }).stackName,
			'rota-3a4f18-philippa-bf9209',
		);
	});

	it('falls back to the derived name with a note when nothing was deployed', () => {
		// A production-only user has no sandbox outputs file; the old unguarded
		// readFileSync turned that into ENOENT.
		const root = projectRoot();

		const resolved = resolveConsoleStack({ projectRoot: root, stage: 'production' });
		assert.strictEqual(resolved.stackName, 'rota-3a4f18-prod');
		assert.match(resolved.note ?? '', /No production outputs file/);
		assert.match(resolved.note ?? '', /derived stack name/);
	});

	it('reports the missing record, not the missing stackId, when neither source can name a stack', () => {
		// An app that names its stack in index.cdk.ts (every test app here, both
		// native examples) has no stackId to derive from and never needs one, so
		// "your config has no stackId" would be a misleading diagnosis of
		// "you have not deployed".
		const root = mkdtempSync(join(tmpdir(), 'blocks-console-bare-'));

		assert.throws(
			() => resolveConsoleStack({ projectRoot: root, stage: 'production' }),
			(error: Error) => {
				assert.match(error.message, /^No production outputs file/);
				assert.match(error.message, /stackId/); // kept as trailing context
				return true;
			},
		);
	});

	it('takes an explicit stackId verbatim without reading any file', () => {
		const resolved = resolveConsoleStack({ stackId: 'some-other-stack', projectRoot: '/nonexistent' });
		assert.strictEqual(resolved.stackName, 'some-other-stack');
		assert.strictEqual(resolved.note, undefined);
	});

	it('honours an explicit outputsFile', () => {
		const root = projectRoot();
		const file = join(root, 'elsewhere.json');
		writeFileSync(file, JSON.stringify({ 'named-elsewhere': { ApiUrl: 'https://x.example' } }));

		const resolved = resolveConsoleStack({ projectRoot: root, outputsFile: file });
		assert.strictEqual(resolved.stackName, 'named-elsewhere');
		assert.strictEqual(resolved.note, undefined);
	});

	it('writes nothing, on the fallback path that used to mint a sandbox id', () => {
		// Opening a console must not write to the project. The sandbox fallback
		// reaches the D-012 naming scheme, whose get-or-create `getSandboxId`
		// would materialize `.blocks-sandbox/sandbox-id.txt` — so the id is read
		// with `readSandboxId` and passed in instead. Asserted by fingerprinting
		// the whole tree, because the claim is about what does NOT happen.
		const root = projectRoot('rota-3a4f18', 'philippa-bf9209');
		const before = treeFingerprint(root);

		// No outputs file for either stage: both tiers fall through to derivation.
		assert.strictEqual(
			resolveConsoleStack({ projectRoot: root }).stackName,
			'rota-3a4f18-philippa-bf9209',
		);
		assert.strictEqual(
			resolveConsoleStack({ projectRoot: root, stage: 'production' }).stackName,
			'rota-3a4f18-prod',
		);

		assert.deepStrictEqual(treeFingerprint(root), before);
	});

	it('reports no sandbox stack rather than inventing a name for one', () => {
		// A machine with no sandbox id has never run `npm run sandbox`, so no
		// sandbox stack of this project exists here. Minting an id would both
		// write to the project and name a stack that cannot exist.
		const root = mkdtempSync(join(tmpdir(), 'blocks-console-nosandbox-'));
		mkdirSync(join(root, '.blocks'), { recursive: true });
		writeFileSync(join(root, '.blocks', 'config.json'), JSON.stringify({ stackId: 'rota-3a4f18' }));

		assert.throws(
			() => resolveConsoleStack({ projectRoot: root }),
			(error: Error) => {
				assert.match(error.message, /^No sandbox outputs file/);
				assert.match(error.message, /no sandbox id/);
				return true;
			},
		);
		assert.strictEqual(existsSync(join(root, '.blocks-sandbox', 'sandbox-id.txt')), false);
	});

	it('does not downgrade an AMBIGUOUS record to the derived name', () => {
		// The fallback exists for "you have not deployed", not for "this record
		// cannot be read". Guessing here would throw away the very diagnosis
		// selectBackendStack produces — and a scaffolded app's derived name would
		// look authoritative while the file says two stacks qualify.
		const root = projectRoot();
		writeOutputs(root, 'production', {
			'rota-3a4f18-prod': { ApiUrl: 'https://one.example' },
			'rota-3a4f18-prod-copy': { ApiUrl: 'https://two.example' },
		});

		assert.throws(
			() => resolveConsoleStack({ projectRoot: root, stage: 'production' }),
			/2 stacks publishing the ApiUrl output[\s\S]*refusing to guess/,
		);
	});

	it('does not downgrade a CORRUPT record to the derived name', () => {
		const root = projectRoot();
		const file = outputsFilePath('production', root);
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(file, '{ not json');

		assert.throws(
			() => resolveConsoleStack({ projectRoot: root, stage: 'production' }),
			/is not valid JSON/,
		);
	});

	it('does not downgrade an EMPTY record to the derived name', () => {
		// `{}` is what the CDK CLI writes when a deploy fails on its first stack,
		// so the honest answer is "your last deploy failed", not a stack name.
		const root = projectRoot();
		writeOutputs(root, 'production', {});

		assert.throws(
			() => resolveConsoleStack({ projectRoot: root, stage: 'production' }),
			/holds no stacks[\s\S]*last deploy failed/,
		);
	});
});
