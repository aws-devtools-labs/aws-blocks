#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Templates ship next to the built CLI (packages/create-block/templates). */
const TEMPLATES_DIR = resolve(__dirname, '..', 'templates');

export type BlockType = 'primitive' | 'composite' | 'client-facing';
export const BLOCK_TYPES: BlockType[] = ['primitive', 'composite', 'client-facing'];

export interface CliOptions {
	className?: string;
	type?: BlockType;
	dir?: string;
	scope?: string;
	yes: boolean;
	skipInstall: boolean;
	skipVerify: boolean;
	dryRun: boolean;
	help: boolean;
}

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────────

/**
 * Normalize a user-supplied block name into a PascalCase class name and validate
 * it. A leading `BB`/`Bb` prefix is stripped (the naming convention forbids it —
 * `KVStore`, not `BBKVStore`).
 */
export function normalizeClassName(raw: string): string {
	const stripped = raw.replace(/^bb[-_]?/i, '');
	return stripped;
}

export function validateClassName(name: string): { ok: true } | { ok: false; reason: string } {
	if (!name) return { ok: false, reason: 'a block name is required' };
	if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
		return {
			ok: false,
			reason: `"${name}" must be PascalCase (start with an uppercase letter, letters/digits only) — e.g. "SearchIndex"`,
		};
	}
	return { ok: true };
}

/** `DemoStore` → `demo-store`, `SQLCache` → `sql-cache`, `HTTPQueue` → `http-queue`. */
export function toKebabCase(pascal: string): string {
	return pascal
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2') // HTTPQueue → HTTP-Queue
		.replace(/([a-z0-9])([A-Z])/g, '$1-$2') // demoStore → demo-Store
		.toLowerCase();
}

export interface DerivedNames {
	className: string;
	suffix: string;
	folder: string;
	pkgName: string;
}

/** Compute folder / package name from the class name and mode. */
export function deriveNames(className: string, mode: Mode, scope: string): DerivedNames {
	const suffix = toKebabCase(className);
	const folder = `bb-${suffix}`;
	const org = mode === 'contributor' ? 'aws-blocks' : scope;
	return { className, suffix, folder, pkgName: `@${org}/bb-${suffix}` };
}

/** Replace the two template tokens in a file's text. */
export function substituteTokens(content: string, tokens: { className: string; pkgName: string }): string {
	return content.replace(/__BB_CLASS__/g, tokens.className).replace(/__BB_PKG_NAME__/g, tokens.pkgName);
}

export type Mode = 'contributor' | 'external';

// ─── Filesystem helpers ──────────────────────────────────────────────────────

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

async function confirm(message: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((res) => {
		rl.question(`${message} (y/N) `, (answer) => {
			rl.close();
			res(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
		});
	});
}

async function ask(message: string, fallback: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((res) => {
		rl.question(`${message} `, (answer) => {
			rl.close();
			res(answer.trim() || fallback);
		});
	});
}

/**
 * Walk up from `startDir` looking for the AWS Blocks monorepo root: a directory
 * whose `package.json` declares a `workspaces` array that includes
 * `packages/blocks`, and which actually contains `packages/blocks`. Returns the
 * root path in contributor mode, or `null` (external mode).
 */
export async function findMonorepoRoot(startDir: string): Promise<string | null> {
	let dir = resolve(startDir);
	// Bound the walk to the filesystem root.
	for (;;) {
		const pkgPath = join(dir, 'package.json');
		if (await exists(pkgPath)) {
			try {
				const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as {
					workspaces?: string[];
				};
				const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : [];
				if (ws.includes('packages/blocks') && (await exists(join(dir, 'packages', 'blocks')))) {
					return dir;
				}
			} catch {
				// Unparseable package.json — keep walking up.
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Recursively list every file (not directory) under `root`, as absolute paths. */
async function listFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else out.push(full);
		}
	}
	await walk(root);
	return out;
}

// ─── Scaffolding ─────────────────────────────────────────────────────────────

interface PlannedWrite {
	path: string;
	action: string;
}

/**
 * Copy `templates/<type>/` into `targetDir`, substituting tokens in every file's
 * contents. In `--dry-run` mode nothing is written; the planned files are
 * returned instead.
 */
async function copyTemplate(
	type: BlockType,
	targetDir: string,
	tokens: { className: string; pkgName: string },
	dryRun: boolean,
	planned: PlannedWrite[],
): Promise<void> {
	const templateDir = join(TEMPLATES_DIR, type);
	if (!(await exists(templateDir))) {
		throw new Error(`Template not found: ${templateDir} (is create-block built?)`);
	}
	const files = await listFiles(templateDir);
	for (const src of files) {
		const rel = relative(templateDir, src);
		const dest = join(targetDir, rel);
		planned.push({ path: dest, action: 'create' });
		if (dryRun) continue;
		await mkdir(dirname(dest), { recursive: true });
		const raw = await readFile(src, 'utf-8');
		await writeFile(dest, substituteTokens(raw, tokens));
	}
}

/**
 * External mode fixup: the shipped template's `prebuild` calls the monorepo's
 * `scripts/generate-version.mjs`, which does not exist outside the repo. Rewrite
 * it to an inline Node one-liner that writes `src/version.ts`, and add the
 * `aws-blocks` discovery keyword.
 */
async function fixupForExternal(targetDir: string, className: string, dryRun: boolean): Promise<void> {
	const pkgPath = join(targetDir, 'package.json');
	const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as {
		scripts?: Record<string, string>;
		keywords?: string[];
	};
	pkg.scripts ??= {};
	// Inline version generator — no dependency on the monorepo's scripts/.
	pkg.scripts.prebuild =
		`node -e "require('fs').writeFileSync('src/version.ts', ` +
		`'// Auto-generated on build — do not edit manually\\n' + ` +
		`'export const BB_NAME = \\'${className}\\';\\n' + ` +
		`'export const BB_VERSION = \\'' + require('./package.json').version + '\\';\\n')"`;
	pkg.keywords = Array.from(new Set([...(pkg.keywords ?? []), 'aws-blocks']));
	if (!dryRun) await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

	// The shipped tsconfig extends the monorepo base and references sibling
	// packages by path — neither exists outside the repo. Replace it with a
	// self-contained config so `tsc --build` works standalone.
	const tsconfigPath = join(targetDir, 'tsconfig.json');
	if (await exists(tsconfigPath)) {
		const standalone = {
			compilerOptions: {
				target: 'ES2022',
				module: 'ES2022',
				moduleResolution: 'bundler',
				strict: true,
				esModuleInterop: true,
				skipLibCheck: true,
				forceConsistentCasingInFileNames: true,
				declaration: true,
				declarationMap: true,
				composite: true,
				incremental: true,
				outDir: './dist',
				rootDir: './src',
			},
			include: ['src/**/*'],
		};
		if (!dryRun) await writeFile(tsconfigPath, `${JSON.stringify(standalone, null, 2)}\n`);
	}
}

// ─── Contributor-mode monorepo wiring ────────────────────────────────────────

const BEGIN_MARKER = '// <!-- BEGIN:generated-block-exports -->';
const END_MARKER = '// <!-- END:generated-block-exports -->';

/**
 * Insert `entry` between the generated-exports markers in `content`, adding the
 * marker pair at the end of the file if it is not present yet. Idempotent: if
 * the entry already appears inside the block it is left untouched.
 */
export function insertBetweenMarkers(content: string, entry: string): string {
	let text = content;
	if (!text.includes(BEGIN_MARKER)) {
		const trimmed = text.replace(/\s*$/, '');
		text = `${trimmed}\n\n${BEGIN_MARKER}\n${END_MARKER}\n`;
	}
	const begin = text.indexOf(BEGIN_MARKER) + BEGIN_MARKER.length;
	const end = text.indexOf(END_MARKER);
	const region = text.slice(begin, end);
	if (region.includes(entry.trim())) return text; // already wired — idempotent
	const updated = `${region.replace(/\s*$/, '')}\n${entry}\n`;
	return text.slice(0, begin) + updated + text.slice(end);
}

interface WireResult {
	edits: string[];
	warnings: string[];
}

async function wireContributor(root: string, names: DerivedNames, dryRun: boolean): Promise<WireResult> {
	const edits: string[] = [];
	const warnings: string[] = [];
	const { className, suffix, folder, pkgName } = names;

	const editJson = async (path: string, mutate: (o: any) => void, label: string): Promise<void> => {
		const obj = JSON.parse(await readFile(path, 'utf-8'));
		mutate(obj);
		if (!dryRun) await writeFile(path, `${JSON.stringify(obj, null, 2)}\n`);
		edits.push(label);
	};
	const editText = async (path: string, mutate: (s: string) => string, label: string): Promise<void> => {
		const before = await readFile(path, 'utf-8');
		const after = mutate(before);
		if (after !== before && !dryRun) await writeFile(path, after);
		edits.push(label);
	};

	// 1. Root workspaces — append packages/<folder> if absent.
	await editJson(
		join(root, 'package.json'),
		(o) => {
			o.workspaces ??= [];
			if (!o.workspaces.includes(`packages/${folder}`)) o.workspaces.push(`packages/${folder}`);
		},
		'root package.json → workspaces',
	);

	// 2. Umbrella runtime re-export (with JSDoc) + type re-export.
	await editText(
		join(root, 'packages/blocks/src/index.ts'),
		(s) =>
			insertBetweenMarkers(
				s,
				`/**\n * **${className}** — TODO: one-line summary shown in IDE hover.\n *\n * Package: \`${pkgName}\`\n * Full docs: \`README.md\` in the package directory above.\n */\nexport { ${className}, ${className}Errors } from '${pkgName}';\nexport type { ${className}Options } from '${pkgName}';`,
			),
		'packages/blocks/src/index.ts → re-export',
	);

	// 3. Umbrella CDK re-export (terse).
	await editText(
		join(root, 'packages/blocks/src/index.cdk.ts'),
		(s) =>
			insertBetweenMarkers(
				s,
				`export { ${className}, ${className}Errors } from '${pkgName}';\nexport type { ${className}Options } from '${pkgName}';`,
			),
		'packages/blocks/src/index.cdk.ts → re-export',
	);

	// 4. Umbrella package.json: dependency + vendorize map entry.
	await editJson(
		join(root, 'packages/blocks/package.json'),
		(o) => {
			o.dependencies ??= {};
			o.dependencies[pkgName] = '^0.1.0';
			o['aws-blocks'] ??= {};
			o['aws-blocks'].vendorize ??= {};
			o['aws-blocks'].vendorize[pkgName] = [className];
		},
		'packages/blocks/package.json → dependencies + vendorize',
	);

	// 5. Umbrella tsconfig project reference.
	await editJson(
		join(root, 'packages/blocks/tsconfig.json'),
		(o) => {
			o.references ??= [];
			if (!o.references.some((r: any) => r.path === `../${folder}`)) {
				o.references.push({ path: `../${folder}` });
			}
		},
		'packages/blocks/tsconfig.json → reference',
	);

	// 6. Comprehensive test app: dependency + starter test.
	const compPkg = join(root, 'test-apps/comprehensive/package.json');
	if (await exists(compPkg)) {
		await editJson(
			compPkg,
			(o) => {
				o.dependencies ??= {};
				o.dependencies[pkgName] = '*';
			},
			'test-apps/comprehensive/package.json → dependency',
		);
		const testPath = join(root, `test-apps/comprehensive/test/${suffix}.test.ts`);
		if (!(await exists(testPath))) {
			const starter = starterComprehensiveTest(className, pkgName);
			if (!dryRun) await writeFile(testPath, starter);
			edits.push(`test-apps/comprehensive/test/${suffix}.test.ts → starter (author TODO)`);
		}
	} else {
		warnings.push('test-apps/comprehensive not found — skipped test-app wiring');
	}

	// 7. Changeset.
	const changesetName = `add-${folder}-${randomBytes(3).toString('hex')}`;
	const changesetPath = join(root, `.changeset/${changesetName}.md`);
	const changeset = `---\n"${pkgName}": minor\n"@aws-blocks/blocks": patch\n---\n\nAdd \`${className}\` Building Block (\`${pkgName}\`) and re-export it from \`@aws-blocks/blocks\`.\n\nTODO: describe what this block does and its public surface before release.\n`;
	if (!dryRun) await writeFile(changesetPath, changeset);
	edits.push(`.changeset/${changesetName}.md`);

	return { edits, warnings };
}

function starterComprehensiveTest(className: string, pkgName: string): string {
	return `// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// TODO(author): flesh this out. Instantiate ${className} against the app's Scope
// in test-apps/comprehensive/aws-blocks/index.ts, expose it via the ApiNamespace,
// and assert the end-to-end typed DX with ZERO type casts (see AGENTS.md).
import { test } from 'node:test';
import assert from 'node:assert';
import { ${className} } from '${pkgName}';

test('${className}: scaffolded placeholder — replace with real e2e coverage', () => {
	assert.ok(${className}, '${className} should be importable from ${pkgName}');
});
`;
}

// ─── Verification ────────────────────────────────────────────────────────────

function verify(root: string, pkgName: string): boolean {
	try {
		execSync(`npm run build -w ${pkgName}`, { cwd: root, stdio: 'inherit' });
		execSync(`npm test -w ${pkgName}`, { cwd: root, stdio: 'inherit' });
		return true;
	} catch {
		return false;
	}
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): CliOptions {
	const opts: CliOptions = { yes: false, skipInstall: false, skipVerify: false, dryRun: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--help':
			case '-h':
				opts.help = true;
				break;
			case '--yes':
			case '-y':
				opts.yes = true;
				break;
			case '--skip-install':
				opts.skipInstall = true;
				break;
			case '--skip-verify':
				opts.skipVerify = true;
				break;
			case '--dry-run':
				opts.dryRun = true;
				break;
			case '--type':
				opts.type = argv[++i] as BlockType;
				break;
			case '--dir':
				opts.dir = argv[++i];
				break;
			case '--scope':
				opts.scope = argv[++i];
				break;
			default:
				if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`);
				if (opts.className) throw new Error(`Unexpected extra argument: ${arg}`);
				opts.className = arg;
		}
	}
	return opts;
}

function printUsage(): void {
	console.log(`
create-block — scaffold a new AWS Blocks Building Block

Usage:
  npm create @aws-blocks/block@latest <ClassName> [options]
  npx @aws-blocks/create-block <ClassName> [options]

Arguments:
  <ClassName>            PascalCase block class name, no "BB" prefix (e.g. SearchIndex)

Options:
  --type <type>          primitive | composite | client-facing  (default: primitive)
  --dir <path>           target directory (default: derived from the package name)
  --scope <npm-scope>    npm scope for external mode (default: your-org)
  --yes, -y              accept defaults / skip confirmation
  --skip-install         do not run npm install (external mode)
  --skip-verify          do not build + test the generated block afterward
  --dry-run              print what would be generated without writing anything
  --help, -h             show this help

Modes (auto-detected):
  contributor   run inside the aws-blocks monorepo → generates packages/bb-<name>
                and wires it into @aws-blocks/blocks, the root workspaces, the
                comprehensive test app, and a changeset.
  external      run anywhere else → generates a standalone @<scope>/bb-<name>
                package (keywords: ["aws-blocks"]), no monorepo wiring.
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function run(argv: string[], cwd: string): Promise<number> {
	let opts: CliOptions;
	try {
		opts = parseArgs(argv);
	} catch (e) {
		console.error(`Error: ${(e as Error).message}`);
		printUsage();
		return 1;
	}
	if (opts.help) {
		printUsage();
		return 0;
	}

	// Resolve the block name.
	let className = opts.className ? normalizeClassName(opts.className) : '';
	if (!className && !opts.yes) {
		className = normalizeClassName(await ask('Block class name (PascalCase, e.g. SearchIndex):', ''));
	}
	const nameCheck = validateClassName(className);
	if (!nameCheck.ok) {
		console.error(`Error: ${nameCheck.reason}`);
		return 1;
	}

	// Resolve the block type.
	let type = opts.type;
	if (type && !BLOCK_TYPES.includes(type)) {
		console.error(`Error: --type must be one of ${BLOCK_TYPES.join(', ')}`);
		return 1;
	}
	if (!type) {
		if (opts.yes) type = 'primitive';
		else {
			const answer = await ask(`Block type — ${BLOCK_TYPES.join(' / ')}? [primitive]:`, 'primitive');
			if (!BLOCK_TYPES.includes(answer as BlockType)) {
				console.error(`Error: "${answer}" is not a valid type (${BLOCK_TYPES.join(', ')})`);
				return 1;
			}
			type = answer as BlockType;
		}
	}

	// Detect mode.
	const root = await findMonorepoRoot(cwd);
	const mode: Mode = root ? 'contributor' : 'external';
	const scope = opts.scope ?? 'your-org';
	const names = deriveNames(className, mode, scope);

	// Resolve target directory.
	const targetDir =
		mode === 'contributor'
			? join(root as string, 'packages', names.folder)
			: resolve(cwd, opts.dir ?? names.folder);

	if (await exists(targetDir)) {
		const isEmpty = (await readdir(targetDir).catch(() => [])).length === 0;
		if (!isEmpty) {
			console.error(`Error: target directory already exists and is not empty: ${targetDir}`);
			return 1;
		}
	}

	// Summary + confirm.
	console.log('');
	console.log(`  Block:     ${names.className}  (${type})`);
	console.log(`  Package:   ${names.pkgName}`);
	console.log(`  Mode:      ${mode}${mode === 'contributor' ? ` (monorepo: ${root})` : ''}`);
	console.log(`  Target:    ${targetDir}`);
	console.log('');
	if (opts.dryRun) console.log('  (--dry-run: no files will be written)\n');
	if (!opts.yes && !opts.dryRun && !(await confirm('Scaffold this block?'))) {
		console.log('Aborted.');
		return 0;
	}

	// Generate.
	const planned: PlannedWrite[] = [];
	await copyTemplate(type, targetDir, { className: names.className, pkgName: names.pkgName }, opts.dryRun, planned);
	if (mode === 'external') await fixupForExternal(targetDir, names.className, opts.dryRun);

	let wire: WireResult | null = null;
	if (mode === 'contributor') {
		wire = await wireContributor(root as string, names, opts.dryRun);
	}

	if (opts.dryRun) {
		console.log('Would create:');
		for (const p of planned) console.log(`  + ${relative(cwd, p.path)}`);
		if (wire) {
			console.log('Would wire:');
			for (const e of wire.edits) console.log(`  ~ ${e}`);
		}
		return 0;
	}

	console.log(`\nCreated ${planned.length} files in ${relative(cwd, targetDir) || '.'}`);
	if (wire) {
		console.log('Wired:');
		for (const e of wire.edits) console.log(`  ~ ${e}`);
		for (const w of wire.warnings) console.log(`  ! ${w}`);
		// Regenerate the README catalog table (idempotent, safe to fail).
		try {
			execSync('npm run sync-docs', { cwd: root as string, stdio: 'pipe' });
			console.log('  ~ packages/blocks/README.md catalog (npm run sync-docs)');
		} catch (e) {
			console.log(`  ! npm run sync-docs failed (run it manually): ${(e as Error).message.split('\n')[0]}`);
		}
	}

	// External install.
	if (mode === 'external' && !opts.skipInstall) {
		try {
			execSync('npm install', { cwd: targetDir, stdio: 'inherit' });
		} catch {
			console.log('! npm install failed — run it manually in the new package.');
		}
	}

	// Verify.
	if (mode === 'contributor' && !opts.skipVerify) {
		console.log('\nVerifying (build + test)...');
		if (!verify(root as string, names.pkgName)) {
			console.log('! Verification failed — inspect the build output above.');
		}
	}

	printNextSteps(mode, names, type);
	return 0;
}

function printNextSteps(mode: Mode, names: DerivedNames, type: BlockType): void {
	console.log('\nNext steps:');
	if (mode === 'contributor') {
		console.log(`  1. Implement ${names.className}'s API in packages/${names.folder}/src/.`);
		console.log(`  2. Add a real ${names.className} instance + assertions to test-apps/comprehensive`);
		console.log(`     (aws-blocks/index.ts and test/${names.suffix}.test.ts — zero type casts).`);
		console.log(`  3. Fill in the TODO summaries in packages/blocks/src/index.ts and the changeset.`);
		console.log('  4. npm run build && npm run lint:deps && npm test && npm run test:e2e:local');
	} else {
		console.log(`  1. cd ${names.folder} && npm run build && npm test`);
		console.log(`  2. Implement ${names.className}'s API in src/, then publish (keywords: ["aws-blocks"]).`);
	}
	if (type === 'client-facing') {
		console.log('  * See packages/bb-realtime for the canonical Transferable / client-middleware pattern.');
	}
}

// Only execute when invoked as the CLI (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	run(process.argv.slice(2), process.cwd())
		.then((code) => process.exit(code))
		.catch((e) => {
			console.error(e);
			process.exit(1);
		});
}
