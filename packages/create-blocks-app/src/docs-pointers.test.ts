// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A scaffolded app finds its Building Block docs through one command, `cdk-blocks docs`. The
 * app AGENTS.md describes it in one bullet; every template's README and code comments point at
 * it in the same words, with block names as its positional arguments; and nothing tells an agent
 * to read the docs or type files in `node_modules`, which the command replaces.
 */

import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'cdk.out', '.bb-data', '.blocks-sandbox']);
const TEXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.md', '.json', '.html', '']);

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (TEXT.has(extname(name))) out.push(path);
	}
	return out;
}

const files = ['templates', 'resources'].flatMap((d) => walk(join(packageRoot, d)));
const lines = files.flatMap((file) =>
	readFileSync(file, 'utf-8')
		.split('\n')
		.map((text, i) => ({ where: `${relative(packageRoot, file)}:${i + 1}`, file, text, i })),
);

const BULLET =
	"- **AWS Blocks docs:** `npx --no -- cdk-blocks docs` is the docs command for this app's Building Blocks and AWS Blocks APIs. It answers types, signatures and how a block behaves, so there's no need to open the packages' source unless necessary. With no arguments it lists the blocks; name one or more blocks or APIs to print their docs: `npx --no -- cdk-blocks docs DistributedTable Auth`. A name can be a block, an export, a type, a function, an option or a method (`ApiError`, `AuthState`, `submitAuthAction`, `ifFieldEquals`, `Secret.get`): it prints the import line, the declaration and the docs about it. `--section <topic>` prints the part of a block's docs about a topic (`KVStore --section local` for how it behaves on your machine), `--api` prints exact signatures, `--exports [filter]` lists what you can import and from which entry, `--search <term>` searches all the docs, and `--help` shows every option.";
const README_POINTER =
	'Building Block docs: `npx --no -- cdk-blocks docs` lists the blocks, and `npx --no -- cdk-blocks docs <Block>...` prints their docs (`--help` for more).';
const COMMENT_POINTER =
	'// Building Block docs: npx --no -- cdk-blocks docs lists the blocks; npx --no -- cdk-blocks docs <Block>... prints their docs (--help for more)';

describe('the docs pointers of a scaffolded app', () => {
	it('describe the docs command in one AGENTS.md bullet', () => {
		const guide = readFileSync(join(packageRoot, 'resources', 'AGENTS.md'), 'utf-8').split('\n');
		assert.deepStrictEqual(
			guide.filter((line) => line.startsWith('- **AWS Blocks docs')),
			[BULLET],
		);
	});

	it('point at it in the same words in every README and code comment', () => {
		const pointers = lines.filter((l) => l.text.includes('Building Block docs:'));
		assert.ok(pointers.length > 20, `expected a pointer in every template, found ${pointers.length}`);
		for (const { where, text, file, i } of pointers) {
			if (extname(file) === '.md') {
				assert.ok(text.includes(README_POINTER), `${where}: ${text}`);
			} else if (text.endsWith(';')) {
				// Split over two lines of a comment block.
				const prefix = text.slice(0, text.indexOf('Building'));
				const next = readFileSync(file, 'utf-8').split('\n')[i + 1];
				assert.strictEqual(
					`${text} ${next.slice(prefix.length)}`,
					`${prefix}${COMMENT_POINTER.slice(3)}`,
					where,
				);
			} else {
				assert.strictEqual(text.trim(), COMMENT_POINTER, where);
			}
		}
	});

	it('name blocks as positional arguments, in no older wording', () => {
		for (const { where, text } of lines.filter((l) => l.text.includes('cdk-blocks docs'))) {
			assert.doesNotMatch(text, /prints one\b|one block:|docs <block>|one block's usage/, where);
		}
	});

	it('never send an agent to node_modules for docs or types', () => {
		for (const { where, text } of lines.filter((l) => l.text.includes('node_modules'))) {
			assert.doesNotMatch(text, /docs|README|\.d\.ts|@aws-blocks|API\.md/i, `${where}: ${text}`);
		}
	});
});
