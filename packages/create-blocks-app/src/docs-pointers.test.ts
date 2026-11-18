// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A scaffolded app finds its Building Block docs through one command, `cdk-blocks docs`. The
 * app AGENTS.md describes it in one bullet; every template's README and backend point at it in
 * the same words, with block names as its positional arguments; and nothing tells an agent to
 * read the docs or type files in `node_modules`, which the command replaces. The example apps
 * beside the native SDKs carry the same comments, so they are read too.
 */

import assert from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(packageRoot, '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'cdk.out', '.bb-data', '.blocks-sandbox']);
const TEXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.md', '.json', '.html', '']);
/**
 * The TypeScript apps of the native SDK examples, written like a scaffolded app. The Kotlin app's README is for
 * the SDK's developers (how to resolve the packages from a checkout's `node_modules`), so only its code is read.
 */
const NATIVE_APPS = ['native/swift/Demo/typescript-demo', 'native/kotlin/example/typescript'].map((d) =>
	join(repoRoot, d),
);
const NATIVE_READ = [
	join(repoRoot, 'native/swift/Demo/typescript-demo'),
	join(repoRoot, 'native/kotlin/example/typescript/aws-blocks'),
	join(repoRoot, 'native/kotlin/example/typescript/src'),
];
const TEMPLATES = readdirSync(join(packageRoot, 'templates'))
	.map((name) => join(packageRoot, 'templates', name))
	.filter((dir) => statSync(dir).isDirectory());

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (TEXT.has(extname(name))) out.push(path);
	}
	return out;
}

const files = [join(packageRoot, 'templates'), join(packageRoot, 'resources'), ...NATIVE_READ].flatMap((d) => walk(d));
const lines = files.flatMap((file) =>
	readFileSync(file, 'utf-8')
		.split('\n')
		.map((text, i) => ({ where: `${relative(repoRoot, file)}:${i + 1}`, file, text, i })),
);

const BULLET =
	"- **AWS Blocks docs:** `npx --no -- cdk-blocks docs` is the docs command for this app's Building Blocks and AWS Blocks APIs. It answers types, signatures and how a block behaves, so there's no need to open the packages' source unless necessary. With no arguments it lists the blocks; name one or more blocks or APIs to print their docs: `npx --no -- cdk-blocks docs KVStore Auth`. A name can be a block, an export, a type, a function, an option or a method (`ApiError`, `AuthState`, `submitAuthAction`, `ifFieldEquals`, `Secret.get`): it prints the import line, the declaration and the docs about it. `--section <topic>` prints the part of a block's docs about a topic (`KVStore --section local` for how it behaves on your machine), `--api` prints exact signatures, `--exports [filter]` lists what you can import and from which entry, `--search <term>` searches all the docs, and `--help` shows every option.";
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

	it('point at it from every template: its README and its backend', () => {
		const pointsAt = (file: string) => readFileSync(file, 'utf-8').includes('Building Block docs:');
		const withReadme = TEMPLATES.filter((dir) => existsSync(join(dir, 'README.md')));
		assert.ok(withReadme.length >= 10, `templates with a README: ${withReadme.length}`);
		for (const dir of withReadme) {
			assert.ok(pointsAt(join(dir, 'README.md')), `${relative(repoRoot, dir)}/README.md`);
			const backend = join(dir, 'aws-blocks', 'index.ts');
			if (existsSync(backend)) assert.ok(pointsAt(backend), relative(repoRoot, backend));
		}
		for (const dir of NATIVE_APPS) {
			for (const file of ['aws-blocks/index.ts', 'src/index.ts']) {
				assert.ok(pointsAt(join(dir, file)), `${relative(repoRoot, dir)}/${file}`);
			}
		}
	});

	it('point at it in the same words in every README and code comment', () => {
		const pointers = lines.filter((l) => l.text.includes('Building Block docs:'));
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
