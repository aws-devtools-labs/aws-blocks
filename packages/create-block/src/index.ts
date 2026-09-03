#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
	// Strip a leading BB prefix only when it's unambiguously a prefix: an explicit
	// separator (`bb-`, `bb_`) or `bb` immediately followed by an uppercase letter
	// (`BBKVStore` → `KVStore`). Leaves names like `BBox` untouched.
	// `[Bb]{2}` matches the prefix in any case; the `(?=[A-Z])` lookahead stays
	// case-sensitive (no `i` flag) so `BBox` isn't mangled into `ox`.
	return raw.replace(/^[Bb]{2}(?:[-_]|(?=[A-Z]))/, '');
}

/** Validate an npm scope (the part after `@`, before `/`). */
export function validateScope(scope: string): { ok: true } | { ok: false; reason: string } {
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(scope)) {
		return {
			ok: false,
			reason: `--scope "${scope}" is not a valid npm scope (lowercase letters, digits, and ._- ; must not start with ._-)`,
		};
	}
	return { ok: true };
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

export type Mode = 'contributor' | 'customer' | 'external';

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

/** npm `workspaces` may be a string array or `{ packages: [...] }`. Return the globs. */
export function normalizeWorkspaces(ws: unknown): string[] {
	if (Array.isArray(ws)) return ws.filter((w): w is string => typeof w === 'string');
	if (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)) {
		return (ws as { packages: unknown[] }).packages.filter((w): w is string => typeof w === 'string');
	}
	return [];
}

/**
 * Walk up from `startDir` for a *customer* monorepo root: a `package.json` that
 * declares npm `workspaces` but is NOT the AWS Blocks framework repo (that's
 * contributor mode). Returns `{ root, pkg }` or `null` (→ standalone external).
 */
export async function findCustomerWorkspaceRoot(startDir: string): Promise<{ root: string; pkg: WorkspacePkg } | null> {
	let dir = resolve(startDir);
	for (;;) {
		const pkgPath = join(dir, 'package.json');
		if (await exists(pkgPath)) {
			try {
				const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as WorkspacePkg;
				const ws = normalizeWorkspaces(pkg.workspaces);
				const isBlocksRepo = ws.includes('packages/blocks') && (await exists(join(dir, 'packages', 'blocks')));
				if (ws.length > 0 && !isBlocksRepo) return { root: dir, pkg };
			} catch {
				// Unparseable package.json — keep walking up.
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

interface WorkspacePkg {
	name?: string;
	workspaces?: string[] | { packages?: string[] };
}

/** Extract an npm scope from a package name (`@acme/app` → `acme`). */
export function scopeFromPkgName(name: unknown): string | null {
	if (typeof name !== 'string') return null;
	const m = name.match(/^@([^/]+)\//);
	return m ? m[1] : null;
}

/** Does an existing `workspaces` glob already cover `packages/<folder>`? */
export function workspacesCover(ws: string[], entry: string): boolean {
	if (ws.includes(entry)) return true;
	const slash = entry.lastIndexOf('/');
	if (slash < 0) return false;
	const parent = entry.slice(0, slash);
	return ws.includes(`${parent}/*`) || ws.includes(`${parent}/**`);
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
 * Copy one template directory into `targetDir`, substituting tokens in every
 * file's contents. Overlaying (calling twice) overwrites files with the same
 * relative path and records the write once. In `--dry-run` mode nothing is
 * written; `planned` collects the resulting file set.
 */
async function copyDir(
	templateDir: string,
	targetDir: string,
	tokens: { className: string; pkgName: string },
	dryRun: boolean,
	planned: Map<string, PlannedWrite>,
): Promise<void> {
	if (!(await exists(templateDir))) {
		throw new Error(`Template not found: ${templateDir} (is create-block built?)`);
	}
	for (const src of await listFiles(templateDir)) {
		const rel = relative(templateDir, src);
		const dest = join(targetDir, rel);
		planned.set(dest, { path: dest, action: planned.has(dest) ? 'overwrite' : 'create' });
		if (dryRun) continue;
		await mkdir(dirname(dest), { recursive: true });
		await writeFile(dest, substituteTokens(await readFile(src, 'utf-8'), tokens));
	}
}

/**
 * Materialize `templates/<type>/` into `targetDir`. `client-facing` has no
 * standalone copy of the runtime/cdk/mock files — it is the `primitive`
 * skeleton with only its browser entry (and docs) overlaid — so the two never
 * drift out of sync.
 */
async function copyTemplate(
	type: BlockType,
	targetDir: string,
	tokens: { className: string; pkgName: string },
	dryRun: boolean,
	planned: Map<string, PlannedWrite>,
): Promise<void> {
	if (type === 'client-facing') {
		await copyDir(join(TEMPLATES_DIR, 'primitive'), targetDir, tokens, dryRun, planned);
		await copyDir(join(TEMPLATES_DIR, 'client-facing'), targetDir, tokens, dryRun, planned);
		return;
	}
	await copyDir(join(TEMPLATES_DIR, type), targetDir, tokens, dryRun, planned);
}

/**
 * Resolve a registry-installable range for an `@aws-blocks/*` dependency. The
 * templates pin the versions used *inside the monorepo*, which don't match the
 * published registry — so outside contributor mode we re-pin to the latest
 * published version (`^x.y.z`). Falls back to `latest` when offline / unknown.
 */
function resolvePublishedRange(pkgName: string): string {
	// Escape hatch for hermetic tests (avoid a network call to the registry).
	if (process.env.CREATE_BLOCK_SKIP_REGISTRY) return 'latest';
	try {
		// execFileSync (argv array, no shell) — pkgName never touches a shell string.
		const v = execFileSync('npm', ['view', pkgName, 'version'], {
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
		if (/^\d+\.\d+\.\d+/.test(v)) return `^${v}`;
	} catch {
		// Offline or unpublished — fall back to the floating tag.
	}
	return 'latest';
}

/** A standalone `scripts/generate-version.mjs` for out-of-monorepo packages. */
const STANDALONE_VERSION_SCRIPT = `#!/usr/bin/env node
// Auto-generated by @aws-blocks/create-block. Regenerates src/version.ts from
// the block name (argv[2]) and this package's version. Standalone — no monorepo.
import { readFileSync, writeFileSync } from 'node:fs';

const bbName = process.argv[2];
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
writeFileSync(
	new URL('../src/version.ts', import.meta.url),
	\`// Auto-generated — do not edit manually\\nexport const BB_NAME = '\${bbName}';\\nexport const BB_VERSION = '\${pkg.version}';\\n\`,
);
`;

/**
 * External / customer mode fixup: make the generated package build and install
 * outside the monorepo. The shipped template's `prebuild` calls the monorepo's
 * `scripts/generate-version.mjs` and its deps pin monorepo-internal versions —
 * neither works from the registry. Point `prebuild` at a standalone
 * `scripts/generate-version.mjs`, re-pin `@aws-blocks/*` deps to published
 * versions, add the `aws-blocks` discovery keyword, drop the core-coupled CDK
 * synth test, and swap the tsconfig for a standalone one.
 */
async function fixupForExternal(targetDir: string, className: string, dryRun: boolean): Promise<void> {
	if (dryRun) return; // nothing on disk to fix up in a preview
	const pkgPath = join(targetDir, 'package.json');
	const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as {
		scripts?: Record<string, string>;
		keywords?: string[];
		dependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	};
	pkg.scripts ??= {};
	// Point prebuild at a small standalone .mjs (written below) instead of the
	// monorepo's scripts/ — a real file avoids cross-shell quoting issues (npm
	// runs scripts through cmd.exe on Windows).
	pkg.scripts.prebuild = `node scripts/generate-version.mjs ${className}`;
	pkg.keywords = Array.from(new Set([...(pkg.keywords ?? []), 'aws-blocks']));
	// Re-pin @aws-blocks/* deps to versions that exist on the registry.
	for (const deps of [pkg.dependencies, pkg.peerDependencies]) {
		if (!deps) continue;
		for (const name of Object.keys(deps)) {
			if (name.startsWith('@aws-blocks/')) deps[name] = resolvePublishedRange(name);
		}
	}
	if (!dryRun) await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

	// Write the standalone prebuild helper referenced by pkg.scripts.prebuild.
	if (!dryRun) {
		const scriptPath = join(targetDir, 'scripts', 'generate-version.mjs');
		await mkdir(dirname(scriptPath), { recursive: true });
		await writeFile(scriptPath, STANDALONE_VERSION_SCRIPT);
	}

	// The CDK *synth test's* harness depends on how @aws-blocks/core attaches a
	// block to its Stack, which varies by core version — so it isn't portable to
	// an arbitrary installed core. Drop it from out-of-monorepo packages; the
	// runtime + parity tests (the customer-relevant, portable ones) still ship,
	// and the CDK construct itself (index.cdk.ts) is unchanged. Author a CDK test
	// against your own stack setup if you need one.
	const cdkTest = join(targetDir, 'src', 'index.cdk.test.ts');
	if (!dryRun && (await exists(cdkTest))) await rm(cdkTest);

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

/**
 * Contributor fixup: re-pin the generated block's `@aws-blocks/*` deps to the
 * monorepo's *current local* versions (`^x.y.z`, as sibling BBs do). The
 * templates carry a snapshot version that drifts as core is bumped; without this
 * the pinned range stops matching the local workspace and npm won't link it.
 */
async function repinContributorDeps(root: string, targetDir: string, dryRun: boolean): Promise<void> {
	if (dryRun) return; // nothing on disk to re-pin in a preview
	const pkgPath = join(targetDir, 'package.json');
	const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as {
		dependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	};
	let changed = false;
	for (const deps of [pkg.dependencies, pkg.peerDependencies]) {
		if (!deps) continue;
		for (const name of Object.keys(deps)) {
			if (!name.startsWith('@aws-blocks/')) continue;
			const local = name.slice('@aws-blocks/'.length);
			try {
				const sibling = JSON.parse(await readFile(join(root, 'packages', local, 'package.json'), 'utf-8')) as {
					version?: string;
				};
				if (sibling.version) {
					deps[name] = `^${sibling.version}`;
					changed = true;
				}
			} catch {
				// Not a local package (or unreadable) — leave the template pin as-is.
			}
		}
	}
	if (changed && !dryRun) await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
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

	// Both editors record whether they actually changed anything, so the printed
	// summary distinguishes a real edit from "already present".
	const editJson = async (path: string, mutate: (o: any) => void, label: string): Promise<void> => {
		const obj = JSON.parse(await readFile(path, 'utf-8'));
		const before = JSON.stringify(obj);
		mutate(obj);
		const changed = JSON.stringify(obj) !== before;
		if (changed && !dryRun) await writeFile(path, `${JSON.stringify(obj, null, 2)}\n`);
		edits.push(changed ? label : `${label} (already present)`);
	};
	const editText = async (path: string, mutate: (s: string) => string, label: string): Promise<void> => {
		const before = await readFile(path, 'utf-8');
		const after = mutate(before);
		if (after !== before && !dryRun) await writeFile(path, after);
		edits.push(after !== before ? label : `${label} (already present)`);
	};

	// All touchpoints run inside try/finally so a mid-way failure still returns
	// the edits that already landed (the caller prints them + the warning).
	try {
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
	} catch (e) {
		warnings.push(
			`wiring stopped early: ${(e as Error).message}. ` +
				`Completed: ${edits.join('; ') || 'nothing'}. Finish the remaining touchpoints by hand (see AGENTS.md).`,
		);
	}

	return { edits, warnings };
}

/**
 * Customer-mode wiring: register `packages/<folder>` in the customer's root
 * `workspaces` so `npm install` links it and their app can import it without
 * publishing. Skips the edit when an existing glob (e.g. `packages/*`) already
 * covers it. Does not touch the app's own package.json or source.
 */
async function wireCustomer(
	root: string,
	customerPkg: WorkspacePkg,
	names: DerivedNames,
	dryRun: boolean,
): Promise<WireResult> {
	const edits: string[] = [];
	const warnings: string[] = [];
	const entry = `packages/${names.folder}`;
	const ws = normalizeWorkspaces(customerPkg.workspaces);

	if (workspacesCover(ws, entry)) {
		edits.push(`workspaces already cover ${entry} (no package.json edit needed)`);
	} else {
		const pkgPath = join(root, 'package.json');
		const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
		if (Array.isArray(pkg.workspaces)) {
			pkg.workspaces.push(entry);
		} else if (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) {
			pkg.workspaces.packages.push(entry);
		} else {
			pkg.workspaces = [entry];
		}
		if (!dryRun) await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
		edits.push(`root package.json → workspaces += "${entry}"`);
	}
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
		// Consume the next token as this flag's value, rejecting a missing value
		// or another flag (so `--dir --yes` errors instead of silently eating --yes).
		const takeValue = (): string => {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('-')) {
				throw new Error(`${arg} requires a value`);
			}
			i++;
			return next;
		};
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
				opts.type = takeValue() as BlockType;
				break;
			case '--dir':
				opts.dir = takeValue();
				break;
			case '--scope':
				opts.scope = takeValue();
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
  customer      run inside your own npm-workspaces repo → generates
                packages/bb-<name>, registers it in your root workspaces, and
                npm-installs so your app can import it (no publish). App code
                is not modified.
  external      run anywhere else → generates a standalone @<scope>/bb-<name>
                package (keywords: ["aws-blocks"]), no workspace wiring.
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

	// Validate a user-supplied --scope up front (it flows into package.json).
	if (opts.scope) {
		const scopeCheck = validateScope(opts.scope);
		if (!scopeCheck.ok) {
			console.error(`Error: ${scopeCheck.reason}`);
			return 1;
		}
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

	// Detect mode: AWS Blocks monorepo (contributor) → customer workspace → standalone.
	const monorepoRoot = await findMonorepoRoot(cwd);
	const customer = monorepoRoot ? null : await findCustomerWorkspaceRoot(cwd);
	const mode: Mode = monorepoRoot ? 'contributor' : customer ? 'customer' : 'external';

	// Resolve the npm scope + derived names.
	const scope =
		mode === 'customer'
			? (opts.scope ?? scopeFromPkgName(customer?.pkg?.name) ?? 'app')
			: (opts.scope ?? 'your-org');
	const names = deriveNames(className, mode, scope);

	// Resolve target directory.
	const targetDir =
		mode === 'contributor'
			? join(monorepoRoot as string, 'packages', names.folder)
			: mode === 'customer'
				? join((customer as { root: string }).root, 'packages', names.folder)
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
	const contextRoot =
		mode === 'contributor' ? monorepoRoot : mode === 'customer' ? (customer as { root: string }).root : null;
	console.log(
		`  Mode:      ${mode}${contextRoot ? ` (${mode === 'contributor' ? 'monorepo' : 'workspace'}: ${contextRoot})` : ''}`,
	);
	console.log(`  Target:    ${targetDir}`);
	console.log('');
	if (opts.dryRun) console.log('  (--dry-run: no files will be written)\n');
	if (!opts.yes && !opts.dryRun && !(await confirm('Scaffold this block?'))) {
		console.log('Aborted.');
		return 0;
	}

	// Generate.
	const planned = new Map<string, PlannedWrite>();
	await copyTemplate(type, targetDir, { className: names.className, pkgName: names.pkgName }, opts.dryRun, planned);
	// Contributor mode uses the monorepo's shared build (scripts/, tsconfig.base);
	// customer + external need a self-contained build.
	if (mode !== 'contributor') await fixupForExternal(targetDir, names.className, opts.dryRun);

	let wire: WireResult | null = null;
	if (mode === 'contributor') {
		await repinContributorDeps(monorepoRoot as string, targetDir, opts.dryRun);
		wire = await wireContributor(monorepoRoot as string, names, opts.dryRun);
	} else if (mode === 'customer') {
		const c = customer as { root: string; pkg: WorkspacePkg };
		wire = await wireCustomer(c.root, c.pkg, names, opts.dryRun);
	}

	if (opts.dryRun) {
		console.log('Would create:');
		for (const p of planned.values()) console.log(`  + ${relative(cwd, p.path)}`);
		if (wire) {
			console.log('Would wire:');
			for (const e of wire.edits) console.log(`  ~ ${e}`);
		}
		return 0;
	}

	console.log(`\nCreated ${planned.size} files in ${relative(cwd, targetDir) || '.'}`);
	if (wire) {
		console.log(mode === 'contributor' ? 'Wired:' : 'Linked:');
		for (const e of wire.edits) console.log(`  ~ ${e}`);
		for (const w of wire.warnings) console.log(`  ! ${w}`);
		if (mode === 'contributor') {
			// Regenerate the README catalog table (idempotent, safe to fail).
			try {
				execSync('npm run sync-docs', { cwd: monorepoRoot as string, stdio: 'pipe' });
				console.log('  ~ packages/blocks/README.md catalog (npm run sync-docs)');
			} catch (e) {
				console.log(`  ! npm run sync-docs failed (run it manually): ${(e as Error).message.split('\n')[0]}`);
			}
		}
	}

	// Install so the workspace symlink / package deps resolve. Customer installs
	// at the workspace root (links the sub-package); external installs in-package.
	const installCwd =
		mode === 'customer' ? (customer as { root: string }).root : mode === 'external' ? targetDir : null;
	if (installCwd && !opts.skipInstall) {
		try {
			execSync('npm install', { cwd: installCwd, stdio: 'inherit' });
		} catch {
			console.log('! npm install failed — run it manually.');
		}
	}

	// Verify (build + test the new package). Skipped when install was skipped in
	// customer/external mode, since the workspace link wouldn't exist yet.
	const verifyRoot =
		mode === 'contributor'
			? (monorepoRoot as string)
			: mode === 'customer'
				? (customer as { root: string }).root
				: null;
	const canVerify = mode === 'contributor' || !opts.skipInstall;
	if (verifyRoot && canVerify && !opts.skipVerify) {
		console.log('\nVerifying (build + test)...');
		if (!verify(verifyRoot, names.pkgName)) {
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
	} else if (mode === 'customer') {
		console.log(`  1. Implement ${names.className}'s API in packages/${names.folder}/src/.`);
		console.log(`  2. Import it in your backend: import { ${names.className} } from '${names.pkgName}';`);
		console.log(`     (it's linked into your workspace — no publish needed).`);
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
