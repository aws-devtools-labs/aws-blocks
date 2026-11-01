// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `cdk-blocks migrate`: move an app that create-blocks-app scaffolded with
 * `aws-blocks/scripts/*.ts` lifecycle wrappers to the `cdk-blocks` CLI.
 *
 * - A wrapper is "generated" when its text, with whitespace normalised, matches
 *   a version that a create-blocks-app template shipped (the hashes below come
 *   from the git history of `packages/create-blocks-app/templates/<name>/aws-blocks/scripts/`).
 *   Any other text is "customized" (reported as an unrecognised version: only
 *   the public create-blocks-app releases are recognised), and migrate never deletes it.
 * - A `package.json` script is rewritten only when its value is exactly the
 *   command a template generated (`tsx aws-blocks/scripts/deploy.ts`) and the
 *   wrapper it runs is generated or absent, and the wrapper does not start a
 *   customized one (`sandbox.ts` starts `server.ts`; see
 *   {@link WRAPPER_RUNTIME_DEPENDENCIES}) or match one ({@link VERSION_DEPENDENCIES}:
 *   the Amplify `stop.ts` stops the port of `server.ts`). Every other script stays as it is.
 * - The options of a generated `server.ts` move to `package.json#blocks.dev`.
 * - A generated wrapper is deleted once nothing references it any more.
 *
 * Exit codes: 0 when the app is fully migrated (or there was nothing to do);
 * 1 when kept items remain for the user to finish by hand (a report, not a
 * crash: everything that could be migrated was migrated), or when migrate
 * refused and wrote nothing, which `--output json` tells apart by printing
 * `{"error": {"message", "hint"}}` instead of the result; 2 for a usage error.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	lstatSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	type Stats,
	writeFileSync,
} from 'node:fs';
import { join, posix as posixPath, relative } from 'node:path';
import { type DevPackageConfig, detectFrontend } from '../config.js';
import type { Context } from '../context.js';
import { CliError, ExitCode } from '../errors.js';
import type { CommandInput } from '../registry.js';

/** The wrapper files that the CLI replaces, under `aws-blocks/scripts/`. */
export type WrapperFile =
	| 'server.ts'
	| 'stop.ts'
	| 'sandbox.ts'
	| 'sandbox-destroy.ts'
	| 'console.ts'
	| 'cleanup.ts'
	| 'deploy.ts'
	| 'destroy.ts'
	| 'secret.ts'
	| 'typegen.ts';

/**
 * SHA-256 of every generated version of each wrapper, after {@link normalizeSource}.
 * Includes the amplify overlay's `server.ts` and `stop.ts`.
 */
export const GENERATED_WRAPPERS: Readonly<Record<WrapperFile, readonly string[]>> = {
	'server.ts': [
		'89f85b0d08c86a4abf19d4da337d47edde6c83f59091bf901035fe7e40940415',
		'08368ac37a213cd51b519c6e36f31b0c278185661c2d72cc7ebe1255f8ac5ec7',
		'dec68f268cc8295cae77c9a3fa073dff55e429dbfb5aeeee60facf081edb8b21',
		'7eff7ae484259a0aa43c0722678bd02ed77d058d82cb3948815015db9b4d157f',
		'aeec58bfc5630ee29c3c0223acda29ccae381a18afd85c653d3efddcd53500ab',
		'2d82415d360635fa1a4dfe88e5b8626fca676ac52b773d6f1ab7bd617bb1dfbf',
	],
	'stop.ts': [
		'cce9579010fa07686477746f78d6fa6c461da5fead9666c0ac6b86616a8b6030',
		'bfb72af67409a3abf32786e5f503ee2a18a44d619a05b39c81f68584db755eb8',
	],
	'sandbox.ts': [
		'6ea538ba47ad6a3ec6d8a3a8111aaba6748dfa65e1ef4f7c5e02d6961b0f0d79',
		'360346ab0203995c7dfc1a527bd5f6c0bed51263c7045d5a12009122c74b6840',
		'6c7f02a18f471dffe0b05a6d3b3268c4b72f23b69f30e5de2340ea47edebc9f2',
		'7bd6e8de71492519ab097519184958fa757814584992319bf03acd283e4324ab',
		'20a5edd57df5b084efb3e94356b2ff2f03d6a02651509e09c85a9eadb448bc3d',
		'26152ff314923cca4a2017db560b3595d3f95ccb8735a5503ef1588fa3bcb5c6',
		'7000753eaf3891c3b6d2837b3be808634050985ed37f30d25ba6db0d331ec992',
		'1dfcd1b6084d5c13cf8506284cd625f9bd44ba521b4100b1dc6eced3c2585fb7',
	],
	'sandbox-destroy.ts': ['b4951480ea7b8c83ec9ef77cfda8c0baa9c2ef3aedfa44875231b714ab781451'],
	'console.ts': ['a654b02820cd0385a4db22050085ab3e17311fee2088231ea7a7807f55773e29'],
	'cleanup.ts': [
		'90139430e1b79e56f52effc9a14e94dc79e9a9bea256d9ddafa7765c6be4f455',
		'618df55152d620598f8b40657062807f42a47687f4a28e823cf963662c632a54',
		'3eb5bd34c58c6df081b62b65d3aef9846d1a9ca883e0d4abfbadb9bcbd9a6244',
	],
	'deploy.ts': ['cd26e18f6b5ac1a5d42e5a18e4d34074d5ea538827870e21da9fb46c956f4b52'],
	'destroy.ts': ['f40c4ea9e6083029233fd1d1930c464ad7df1e78840568f0675e0cd4c6379a6c'],
	'secret.ts': ['ffdde3f52f3aafdce8d4744e9ab7dab83bd5914492af25cc80097675bbf3cbba'],
	'typegen.ts': ['80a25e1754a7d2607f440d306aeea970a59b9480eefa7b1e17b73c88b2b4cdbe'],
};

/**
 * The `package.json#blocks.dev` settings that migrate moves out of a generated `server.ts`.
 * `generateClient` is read by the dev server in `@aws-blocks/core`, not by the CLI.
 */
export type MigratedDevConfig = Pick<DevPackageConfig, 'port' | 'frontendCommand' | 'frontendPort' | 'frontend'> & {
	generateClient?: false;
};

/**
 * The `startDevServer` options of each generated `server.ts`, as `package.json#blocks.dev`.
 * A backend-only `server.ts` passed no frontend, so it ran none whatever the app installed:
 * `"frontend": false` keeps that. The Amplify overlay's `server.ts` (the first entry) also
 * gets `"generateClient": false`: its app commits its own `aws-blocks/client.js` (the Cognito
 * token and the `amplify_outputs.json` API URL), which the dev server would otherwise replace.
 */
export const SERVER_DEV_OPTIONS: Readonly<Record<string, MigratedDevConfig>> = {
	'89f85b0d08c86a4abf19d4da337d47edde6c83f59091bf901035fe7e40940415': { port: 3001, frontend: false, generateClient: false },
	'08368ac37a213cd51b519c6e36f31b0c278185661c2d72cc7ebe1255f8ac5ec7': { port: 3001, frontend: false },
	dec68f268cc8295cae77c9a3fa073dff55e429dbfb5aeeee60facf081edb8b21: {
		frontendCommand: 'npx vite --port 3100 --strictPort',
		frontendPort: 3100,
	},
	'7eff7ae484259a0aa43c0722678bd02ed77d058d82cb3948815015db9b4d157f': {
		frontendCommand: 'npx next dev --webpack --hostname 127.0.0.1 --port 3100',
		frontendPort: 3100,
	},
	aeec58bfc5630ee29c3c0223acda29ccae381a18afd85c653d3efddcd53500ab: {
		frontendCommand: 'npx next dev --webpack --port 3100',
		frontendPort: 3100,
	},
	'2d82415d360635fa1a4dfe88e5b8626fca676ac52b773d6f1ab7bd617bb1dfbf': {
		frontendCommand: 'npx next dev --port 3100',
		frontendPort: 3100,
	},
};

/** The generated npm-script commands, and the `cdk-blocks` alias that replaces each one. */
export const SCRIPT_REWRITES: Readonly<Record<string, { alias: string; wrapper: WrapperFile }>> = {
	'tsx watch aws-blocks/scripts/server.ts': { alias: 'cdk-blocks dev', wrapper: 'server.ts' },
	'tsx aws-blocks/scripts/stop.ts': { alias: 'cdk-blocks dev stop', wrapper: 'stop.ts' },
	'tsx aws-blocks/scripts/sandbox.ts': { alias: 'cdk-blocks sandbox', wrapper: 'sandbox.ts' },
	'tsx aws-blocks/scripts/sandbox.ts --deploy-only': { alias: 'cdk-blocks sandbox deploy', wrapper: 'sandbox.ts' },
	'tsx aws-blocks/scripts/sandbox.ts --preview': { alias: 'cdk-blocks sandbox preview', wrapper: 'sandbox.ts' },
	'tsx -C cdk aws-blocks/scripts/sandbox-destroy.ts': {
		alias: 'cdk-blocks sandbox destroy',
		wrapper: 'sandbox-destroy.ts',
	},
	'tsx aws-blocks/scripts/console.ts': { alias: 'cdk-blocks sandbox console', wrapper: 'console.ts' },
	'tsx aws-blocks/scripts/cleanup.ts': { alias: 'cdk-blocks dev stop --all', wrapper: 'cleanup.ts' },
	'tsx aws-blocks/scripts/deploy.ts': { alias: 'cdk-blocks deploy', wrapper: 'deploy.ts' },
	'tsx aws-blocks/scripts/destroy.ts': { alias: 'cdk-blocks destroy', wrapper: 'destroy.ts' },
	'tsx aws-blocks/scripts/secret.ts': { alias: 'cdk-blocks secret', wrapper: 'secret.ts' },
	'tsx aws-blocks/scripts/typegen.ts': { alias: 'cdk-blocks generate types', wrapper: 'typegen.ts' },
};

/**
 * The `cdk-blocks` scripts that a prerelease build scaffolded under the
 * command's earlier name, `blocks` (`"dev": "blocks dev"`). That command no
 * longer exists, so migrate renames them.
 */
const RENAMED_ALIASES: ReadonlySet<string> = new Set([
	...Object.values(SCRIPT_REWRITES).map(({ alias }) => alias),
	'cdk-blocks generate client',
	'cdk-blocks generate spec',
	'cdk-blocks config',
	'cdk-blocks vendorize',
]);

/**
 * Wrappers a wrapper runs at runtime, beyond what its import statements show.
 * Every generated `sandbox.ts` starts `server.ts` as the sandbox's local dev
 * server, through `devCommand` or core's default
 * (`npx tsx watch aws-blocks/scripts/server.ts`), and so does a customized one
 * unless it changed that. The `cdk-blocks sandbox` alias uses the CLI's own dev
 * runner instead, so a customized `server.ts` would be silently bypassed; and a
 * `sandbox.ts` that stays keeps its `server.ts`.
 */
export const WRAPPER_RUNTIME_DEPENDENCIES: Readonly<Partial<Record<WrapperFile, readonly WrapperFile[]>>> = {
	'sandbox.ts': ['server.ts'],
};

/**
 * Generated wrapper versions, by hash, that equal their alias only while
 * another wrapper is generated. The Amplify overlay's `stop.ts` defaults to the
 * port of the overlay's `server.ts`; `cdk-blocks dev stop` takes the port from
 * `package.json#blocks.dev`, which migrate writes from a generated `server.ts`
 * only, so with a customized `server.ts` the alias would stop the wrong port.
 */
export const VERSION_DEPENDENCIES: Readonly<Record<string, readonly WrapperFile[]>> = {
	cce9579010fa07686477746f78d6fa6c461da5fead9666c0ac6b86616a8b6030: ['server.ts'],
};

/**
 * Wrappers whose alias needs `.blocks/config.json#stackId`: `cdk-blocks deploy` and
 * `cdk-blocks destroy` name the production stack `<stackId>-prod`, while the
 * wrappers call core's deploy and destroy, which do not. Apps scaffolded before
 * create-blocks-app wrote that file keep these wrappers until it exists.
 */
const STACK_ID_WRAPPERS: readonly WrapperFile[] = ['deploy.ts', 'destroy.ts'];

const STACK_ID_HINT =
	'create .blocks/config.json with {"stackId": "<id>"}, where "<id>-prod" must equal the name of the production stack that your aws-blocks/index.cdk.ts defines (an app whose index.cdk.ts hard-codes "my-blocks-stack-prod" uses {"stackId": "my-blocks-stack"}), commit it, and run cdk-blocks migrate again';

/**
 * Why `.blocks/config.json` lacks the stackId that `cdk-blocks deploy` and
 * `cdk-blocks destroy` need, and how to fix it; `null` when it has one. A file
 * that exists but does not parse is not a missing file: say so, as core's
 * `getStackId` and `cdk-blocks whoami` do.
 */
function stackIdProblem(root: string): string | null {
	const path = join(root, '.blocks', 'config.json');
	let text: string | undefined;
	try {
		text = unlessGone(() => readFileSync(path, 'utf-8'));
	} catch (error) {
		return `.blocks/config.json cannot be read (${(error as Error).message}): fix ${path}, then run cdk-blocks migrate again`;
	}
	if (text === undefined) return `this app has no .blocks/config.json: ${STACK_ID_HINT}`;
	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch (error) {
		return `.blocks/config.json is not valid JSON (${(error as Error).message}): fix ${path}, then run cdk-blocks migrate again`;
	}
	const stackId = (config as { stackId?: unknown } | null)?.stackId;
	return typeof stackId === 'string' && stackId !== ''
		? null
		: `.blocks/config.json has no string "stackId": ${STACK_ID_HINT}`;
}

const SCRIPTS_DIR = join('aws-blocks', 'scripts');

/** Whitespace-insensitive form of a source file: CRLF, indentation and blank lines do not matter. */
export function normalizeSource(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

export function sourceHash(text: string): string {
	return createHash('sha256').update(normalizeSource(text)).digest('hex');
}

export interface KeptItem {
	file: string;
	reason: string;
}

/** The `--output json` result. */
export interface MigrateResult {
	/** Files that were (or, with --dry-run, would be) modified. */
	changed: string[];
	/** Files that were (or would be) deleted. */
	removed: string[];
	/** Items left for the user to finish by hand. */
	kept: KeptItem[];
	/** Rewritten scripts, by name. */
	scriptsRewritten: Record<string, { from: string; to: string }>;
	/**
	 * The `blocks.dev` config added (or, with --dry-run, that would be added) to
	 * `package.json`, moved from a generated `server.ts`; `null` when none is added.
	 */
	devConfig: MigratedDevConfig | null;
}

interface PackageJson {
	scripts?: Record<string, string>;
	blocks?: { dev?: unknown; [key: string]: unknown };
	[key: string]: unknown;
}

interface Wrapper {
	file: WrapperFile;
	/** The path relative to the project root, with `/` separators. */
	path: string;
	generated: boolean;
	hash: string;
}

function posix(path: string): string {
	return path.split('\\').join('/');
}

/**
 * `read()`, or `undefined` when the file is gone: another `cdk-blocks migrate`
 * run (or the user) can delete a wrapper while this one plans.
 */
function unlessGone<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

/** Generated and customized wrappers present in the app. */
function findWrappers(root: string): Wrapper[] {
	const dir = join(root, SCRIPTS_DIR);
	const wrappers: Wrapper[] = [];
	for (const file of Object.keys(GENERATED_WRAPPERS) as WrapperFile[]) {
		const path = join(dir, file);
		const text = unlessGone(() => readFileSync(path, 'utf-8'));
		if (text === undefined) continue;
		const hash = sourceHash(text);
		wrappers.push({
			file,
			path: posix(relative(root, path)),
			generated: GENERATED_WRAPPERS[file].includes(hash),
			hash,
		});
	}
	return wrappers;
}

/**
 * Outside git: directories that hold no app source (dependencies, version
 * control, build output, tool state and caches), skipped at any depth.
 */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
	'node_modules',
	'.git',
	'.hg',
	'.svn',
	'dist',
	'build',
	'build-temp',
	'coverage',
	'cdk.out',
	'.blocks-sandbox',
	'.amplify',
	'.next',
	'.nuxt',
	'.output',
	'.svelte-kit',
	'.astro',
	'.vite',
	'.turbo',
	'.cache',
	'.parcel-cache',
]);

/** Larger files are data or generated output, not something that runs a wrapper. */
const MAX_SCANNED_BYTES = 1024 * 1024;

/** Markdown docs and editor rules: prose that names a wrapper does not run it (the backend template's README shows a wrapper script). */
const DOC_FILE = /\.(md|mdx|mdc)$/i;

/**
 * CI configuration, shell scripts, Makefiles and Dockerfiles: files that run
 * commands from a working directory of their own (`working-directory:
 * aws-blocks`, `cd aws-blocks/scripts && …`), so a bare `scripts/deploy.ts` or
 * `deploy.ts` there can name a wrapper.
 */
const RUNNER_FILE =
	/(^|\/)(\.github\/(workflows|actions)\/.+|\.circleci\/.+|\.buildkite\/.+|\.gitlab-ci\.ya?ml|\.travis\.ya?ml|azure-pipelines[^/]*\.ya?ml|bitbucket-pipelines\.ya?ml|buildspec[^/]*\.ya?ml|amplify\.ya?ml|Jenkinsfile|(GNU)?[Mm]akefile|[^/]*\.mk|[Jj]ustfile|Procfile|(Docker|Container)file[^/]*|[^/]*\.dockerfile|(docker-)?compose[^/]*\.ya?ml|[^/]*\.(sh|bash|zsh|ps1|bat|cmd))$/;

/** A file that names at least one wrapper, and the project paths of the wrappers it names. */
interface WrapperUser {
	/** Relative to the project root: `../../.github/workflows/ci.yml` for a file above it. */
	path: string;
	uses: ReadonlySet<string>;
}

/**
 * The files of a git work tree above the project that can run its wrappers:
 * `files` relative to the work tree's `top`, and the project's `prefix` there
 * (`apps/web/`). The work tree is the project's own, when the project is a
 * subdirectory of it (a monorepo), or a superproject of a submodule that
 * holds the project.
 */
export interface RepoFiles {
	top: string;
	prefix: string;
	files: string[];
}

/**
 * Every app file that names one of `wrappers`. `files` are the ones git lists
 * for the project directory: tracked files and untracked files that are not
 * ignored, under any directory name. A directory that git lists (a submodule,
 * or an untracked repository inside the app) is walked. With `files` `null`
 * (outside git, or where git does not track the app), every file under the
 * project root is read, dot directories included (`.github`, `.vscode`),
 * other than the {@link SKIPPED_DIRS}. Either way, shell scripts, Dockerfiles
 * and CI workflows count; `*.md`, `*.mdx` and `*.mdc` files, files over
 * {@link MAX_SCANNED_BYTES}, binary files (a NUL byte), the root
 * `package.json` (its scripts are checked after the rewrite) and symbolic
 * links, which are not followed, do not. Each file is read once, and only the
 * wrappers it names are kept. Above the project root, only the `repos` files
 * are read: the `package.json` files and CI, shell and Docker files of a
 * monorepo or a superproject, from {@link gitRepoFiles}.
 */
function wrapperUsers(
	root: string,
	wrappers: readonly Wrapper[],
	files: readonly string[] | null,
	repos: readonly RepoFiles[],
): WrapperUser[] {
	const users: WrapperUser[] = [];
	const walk = (dir: string): void => {
		for (const entry of unlessGone(() => readdirSync(dir, { withFileTypes: true })) ?? []) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRS.has(entry.name)) walk(path);
			} else if (entry.isFile()) {
				scan(posix(relative(root, path)));
			}
		}
	};
	/** The text of a file worth reading, or `undefined`; walks a directory instead, with `walkDirs`. */
	const read = (path: string, walkDirs = true): string | undefined => {
		let stats: Stats;
		try {
			stats = lstatSync(path);
		} catch {
			return undefined; // A tracked file deleted from the work tree.
		}
		if (stats.isDirectory()) {
			// Above the project, a directory that git lists is a submodule: another work tree, not this project's.
			if (!walkDirs) return undefined;
			walk(path);
			return undefined;
		}
		if (!stats.isFile() || stats.size > MAX_SCANNED_BYTES) return undefined;
		const bytes = unlessGone(() => readFileSync(path));
		return bytes === undefined || bytes.includes(0) ? undefined : bytes.toString('utf-8');
	};
	const scan = (rel: string): void => {
		if (rel === 'package.json' || DOC_FILE.test(rel)) return;
		const text = read(join(root, rel));
		if (text === undefined) return;
		const bare = RUNNER_FILE.test(rel);
		const uses = new Set(wrappers.filter((w) => refersTo(text, rel, w, { bare })).map((w) => w.path));
		if (uses.size > 0) users.push({ path: rel, uses });
	};
	if (files === null) walk(root);
	// git lists an untracked repository as `dir/`.
	else for (const rel of files) scan(rel.replace(/\/$/, ''));
	for (const { top, prefix, files: repoFiles } of repos) {
		// From the project up to the top, without resolving symbolic links that git resolved in `top`.
		const up = prefix.split('/').filter((segment) => segment !== '').map(() => '..');
		for (const rel of repoFiles) {
			const text = read(join(top, rel), false);
			if (text === undefined) continue;
			const uses = new Set(wrappers.filter((w) => refersTo(text, rel, w, { bare: true, prefix })).map((w) => w.path));
			if (uses.size > 0) users.push({ path: [...up, rel].join('/'), uses });
		}
	}
	return users;
}

const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;

/** A word starts after one of these (or at the start): in a command line, a YAML value, a JSON string. */
const WORD_START = `(?<![^\\s'"\`=;&|()])`;

/**
 * A path from a variable that names a checkout's top in CI: `$GITHUB_WORKSPACE/`,
 * `${CI_PROJECT_DIR}/`, `$(pwd)/`, `$(git rev-parse --show-toplevel)/` or
 * `${{ github.workspace }}/`, of which a word holds only the `}}/` after the space.
 */
const VARIABLE_ROOT = /^(\$\{\{[^}]*\}\}|\}\}|\$\{\w+\}|\$\([^()]*\)|\$\w+)\//;

/** A path from the directory of the shell script itself: `$(dirname "$0")/`, `$(dirname "${BASH_SOURCE[0]}")/`, `${0%/*}/`. */
const SCRIPT_DIR = /^(\$\(\s*dirname\s+("?)(\$0|\$\{0\}|\$\{BASH_SOURCE(\[0\])?\})\2\s*\)|\$\{0%\/\*\})\//;

/**
 * The directories that a file above the project changes into: `working-directory:`
 * (GitHub Actions), `cd` and `pushd` (shell, Makefile, npm script) and `WORKDIR` (Dockerfile).
 * A double-quoted value can hold escaped quotes (`"apps/we\"b"`) and a command
 * substitution with quotes of its own (`"$(dirname "$0")/../apps/web"`). Each piece
 * of a double-quoted value matches one way only (an escape, a `$(…)`, a `$` not before
 * `(`, or another character), so an unclosed value fails in linear time.
 */
const ENTERED_DIR =
	/(?:\bworking-directory:|(?<![\w-])(?:cd|pushd)(?=\s)|^\s*WORKDIR(?=\s))\s*("(?:\\.|\$\([^)]*\)|\$(?!\()|[^"\\$])*"|'[^']*'|\$\{\{[^}]*\}\}[^\s;&|)]*|\$\([^)]*\)[^\s;&|)]*|[^\s;&|)]+)/gm;

/**
 * True when `path`, written in the file in directory `dir` of the work tree
 * (whose project sits at `prefix`, `apps/web/`), names the project directory:
 * relative to the top (where CI and root scripts run) or to `dir` (where npm
 * runs a `package.json` script, or from a shell script's {@link SCRIPT_DIR}),
 * from a {@link VARIABLE_ROOT}, or as the end of an absolute path (the work
 * tree copied into a container). With `within`, a directory inside the project
 * counts as well (`apps/web/aws-blocks/scripts`). A double-quoted `path` is
 * unescaped as the shell does (`\"`, `\\`, `\$`, `` \` ``), and then any other
 * backslash is a Windows separator (`cd apps\web`).
 */
function namesProject(path: string, dir: string, prefix: string, within: boolean): boolean {
	const project = prefix.replace(/\/$/, '');
	const quoted = /^(['"])(.*)\1$/s.exec(path);
	const value = quoted ? (quoted[1] === '"' ? quoted[2].replace(/\\(["\\$`])/g, '$1') : quoted[2]) : path;
	const unquoted = value.replace(/\\+/g, '/');
	const matches = (candidate: string): boolean => {
		const trimmed = candidate.replace(/\/+$/, '');
		return trimmed === project || (within && trimmed.startsWith(`${project}/`));
	};
	if (SCRIPT_DIR.test(unquoted)) return matches(posixPath.join(dir, unquoted.replace(SCRIPT_DIR, '')));
	if (VARIABLE_ROOT.test(unquoted)) return matches(posixPath.normalize(unquoted.replace(VARIABLE_ROOT, '')));
	if (posixPath.isAbsolute(unquoted)) {
		const trimmed = posixPath.normalize(unquoted).replace(/\/+$/, '');
		return trimmed.endsWith(`/${project}`) || (within && trimmed.includes(`/${project}/`));
	}
	return matches(posixPath.normalize(unquoted)) || matches(posixPath.join(dir, unquoted));
}

/** True when `text`, a file in directory `dir` of the work tree, changes into the project (at `prefix`) or a directory inside it. */
function entersProject(text: string, dir: string, prefix: string): boolean {
	for (const match of text.matchAll(ENTERED_DIR)) {
		if (namesProject(match[1], dir, prefix, true)) return true;
	}
	return false;
}

/**
 * True when `text`, the content of the file at `sourcePath` (relative to the
 * project root, or to the work tree top for a file above it, whose project
 * then sits at `prefix`; `package.json` for a script), refers to `wrapper`: by
 * its project path (`aws-blocks/scripts/server.ts`, as npm scripts and
 * `devCommand` strings name it), or by any quoted relative path that resolves
 * to it from the file's directory (`'./server.js'`, `'../server.js'`,
 * `import('../../aws-blocks/scripts/server')`), with or without an extension.
 * With `bare` (CI, shell and Docker files, and scripts, which run commands
 * from another working directory), a word `deploy.ts`, `scripts/deploy.ts` or
 * `./scripts/deploy.ts` counts as well. A path counts with backslashes too
 * (`aws-blocks\scripts\deploy.ts` in a `.cmd`, `.bat` or `.ps1` file, or
 * escaped in JSON and YAML strings).
 *
 * In the project, the project path also counts as the end of a longer path.
 * Above it, the project path counts only after the project's own directory
 * ({@link namesProject}: `apps/web/aws-blocks/scripts/deploy.ts`,
 * `../../apps/web/aws-blocks/…` from `tools/release/package.json`); without a
 * directory, the project path and the `bare` words count only in a file that
 * changes into the project ({@link entersProject}). So another app's
 * `apps/api/aws-blocks/scripts/deploy.ts`, or a bare
 * `aws-blocks/scripts/deploy.ts` under `working-directory: apps/api`, does not
 * count for `apps/web`.
 */
function refersTo(
	written: string,
	sourcePath: string,
	wrapper: Wrapper,
	{ bare = false, prefix = '' }: { bare?: boolean; prefix?: string } = {},
): boolean {
	// Windows scripts name the wrappers with backslashes: `npx tsx aws-blocks\scripts\deploy.ts`.
	const text = written.replace(/\\+/g, '/');
	const target = wrapper.path.replace(SOURCE_EXTENSION, '');
	const escaped = target.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
	const name = wrapper.file.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
	// Only at the start of a word: `src/server.ts` is another file.
	const bareWord = new RegExp(`${WORD_START}(\\./)?(scripts/)?${name}(?![\\w.-])`);
	const dir = posixPath.dirname(sourcePath);
	if (prefix === '') {
		if (new RegExp(`${escaped}(\\.[cm]?[jt]sx?)?(?![\\w.-])`).test(text)) return true;
		if (bare && bareWord.test(text)) return true;
	} else {
		let entered: boolean | undefined;
		// On the text as written: the `\` → `/` above would turn the escaped quote in `cd "apps/we\"b"` into `/"`.
		const enters = (): boolean => {
			entered ??= entersProject(written, dir, prefix);
			return entered;
		};
		// The directory before the project path, up to the start of the word.
		const projectPath = new RegExp(`${WORD_START}([^\\s'"\`=;&|()]*?)${escaped}(\\.[cm]?[jt]sx?)?(?![\\w.-])`, 'g');
		for (const match of text.matchAll(projectPath)) {
			const lead = match[1].replace(/^(\.\/)+/, '');
			if (lead === '' ? enters() : namesProject(lead, dir, prefix, false)) return true;
		}
		if (bare && bareWord.test(text) && enters()) return true;
	}
	for (const match of text.matchAll(/(['"`])(\.{1,2}\/[^'"`\s]*)\1/g)) {
		if (posixPath.join(dir, match[2]).replace(SOURCE_EXTENSION, '') === prefix + target) return true;
	}
	return false;
}

/**
 * What git knows about the project directory: `outside` a git work tree (or
 * without git); `refused` when git fails to read the repository (it does not
 * trust a directory another user owns), with git's first error line; `unseen`
 * when the work tree does not list the app's `package.json` (a parent repo
 * ignores the app's directory), so git could not undo the migration; or the
 * files git lists for the project, from {@link gitFiles}, and the files above
 * it that can run its wrappers, in a monorepo or a superproject, from
 * {@link gitRepoFiles}.
 */
type GitView =
	| { kind: 'outside' }
	| { kind: 'refused'; message: string }
	| { kind: 'unseen' }
	| { kind: 'listed'; files: string[]; repos: RepoFiles[] };

function gitView(root: string): GitView {
	// The C locale keeps "not a git repository" in English.
	const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
		cwd: root,
		encoding: 'utf-8',
		env: { ...process.env, LC_ALL: 'C' },
	});
	if ((inside.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { kind: 'outside' };
	if (inside.error || inside.status !== 0) {
		if (!inside.error && inside.stderr.includes('not a git repository')) return { kind: 'outside' };
		const message = inside.stderr.trim().split('\n')[0] || inside.error?.message || `exit code ${inside.status}`;
		return { kind: 'refused', message };
	}
	if (inside.stdout.trim() !== 'true') return { kind: 'outside' };
	const files = gitFiles(root);
	return files.includes('package.json') ? { kind: 'listed', files, repos: gitRepoFiles(root) } : { kind: 'unseen' };
}

/** `git status --porcelain` for the project, which must be in a git work tree. */
function gitStatus(root: string): string {
	const status = spawnSync('git', ['status', '--porcelain', '--', '.'], { cwd: root, encoding: 'utf-8' });
	if (status.error || status.status !== 0) {
		throw new CliError(`git status failed in ${root}: ${status.stderr || status.error?.message}`.trim());
	}
	return status.stdout;
}

/**
 * The project's tracked files and its untracked files that git does not
 * ignore, relative to `root` with `/` separators.
 */
function gitFiles(root: string): string[] {
	const list = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
		cwd: root,
		encoding: 'utf-8',
		maxBuffer: Number.POSITIVE_INFINITY,
	});
	if (list.error || list.status !== 0) {
		throw new CliError(`git ls-files failed in ${root}: ${list.stderr || list.error?.message}`.trim());
	}
	// An unmerged path is listed once per stage.
	return [...new Set(list.stdout.split('\0').filter((path) => path !== ''))];
}

/**
 * The files above the project that can run its wrappers: every file that git
 * tracks in the project's work tree outside the project, when the project is a
 * subdirectory of it (a monorepo), and in each superproject when the work tree
 * is a submodule, that is a `package.json` or a CI, shell, Make or Docker file
 * ({@link RUNNER_FILE}: `.github/workflows/*`, `scripts/deploy-web.sh`,
 * `ci/Makefile`, `tools/release/package.json`). Only tracked files, and none
 * under `node_modules`, so a large monorepo costs one `git ls-files` per work
 * tree; {@link wrapperUsers} skips the files over {@link MAX_SCANNED_BYTES}.
 */
function gitRepoFiles(root: string): RepoFiles[] {
	const where = spawnSync('git', ['rev-parse', '--show-toplevel', '--show-prefix'], { cwd: root, encoding: 'utf-8' });
	if (where.error || where.status !== 0) {
		throw new CliError(`git rev-parse failed in ${root}: ${where.stderr || where.error?.message}`.trim());
	}
	let [top = '', prefix = ''] = where.stdout.split('\n');
	// At the top of its work tree, gitFiles lists the project's files already.
	const repos: RepoFiles[] = prefix === '' ? [] : [{ top, prefix, files: filesAbove(top, prefix) }];
	for (;;) {
		// Outside a submodule git prints nothing; a git too old for the option, or a superproject it does not read, ends the search too.
		const sup = spawnSync('git', ['rev-parse', '--show-superproject-working-tree'], { cwd: top, encoding: 'utf-8' });
		const superTop = sup.error || sup.status !== 0 ? '' : sup.stdout.trim();
		if (superTop === '') return repos;
		prefix = `${posix(relative(superTop, top))}/${prefix}`;
		top = superTop;
		repos.push({ top, prefix, files: filesAbove(top, prefix) });
	}
}

/** The {@link gitRepoFiles} that the work tree at `top` tracks outside `prefix`, relative to `top`. */
function filesAbove(top: string, prefix: string): string[] {
	const list = spawnSync('git', ['ls-files', '-z', '--', ':(top)'], {
		cwd: top,
		encoding: 'utf-8',
		maxBuffer: Number.POSITIVE_INFINITY,
	});
	if (list.error || list.status !== 0) {
		throw new CliError(`git ls-files failed in ${top}: ${list.stderr || list.error?.message}`.trim());
	}
	return [
		...new Set(
			list.stdout
				.split('\0')
				.filter(
					(rel) =>
						rel !== '' &&
						!rel.startsWith(prefix) &&
						!rel.split('/').includes('node_modules') &&
						(posixPath.basename(rel) === 'package.json' || RUNNER_FILE.test(rel)),
				),
		),
	];
}

/** A planned migration: the result, the rewritten `package.json`, and the `package.json` text it was planned from. */
export interface MigrationPlan {
	result: MigrateResult;
	pkg: PackageJson;
	pkgText: string;
}

/**
 * Plan the migration of `root`, reading `files` (from {@link gitFiles}), or
 * every file under `root` when `files` is `null`, and the `repos` files above
 * it (from {@link gitRepoFiles}). Pure apart from reading files.
 */
export function planMigration(
	root: string,
	files: readonly string[] | null,
	repos: readonly RepoFiles[] = [],
): MigrationPlan {
	const pkgPath = join(root, 'package.json');
	let pkgText: string;
	let parsed: unknown;
	try {
		pkgText = readFileSync(pkgPath, 'utf-8');
		// JSON.parse rejects the byte order mark that some Windows editors write; writePackageJson keeps it.
		parsed = JSON.parse(pkgText.replace(/^\uFEFF/, ''));
	} catch (error) {
		throw new CliError(`cannot read ${pkgPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		const kind = parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`;
		throw new CliError(`${pkgPath} must be a JSON object, not ${kind}.`);
	}
	const pkg = parsed as PackageJson;
	const wrappers = findWrappers(root);
	const byFile = new Map(wrappers.map((w) => [w.file, w]));
	const result: MigrateResult = { changed: [], removed: [], kept: [], scriptsRewritten: {}, devConfig: null };
	const scripts = { ...(pkg.scripts ?? {}) };
	const stackIdIssue = stackIdProblem(root);
	const stackless = stackIdIssue === null ? [] : STACK_ID_WRAPPERS;

	for (const [name, value] of Object.entries(scripts)) {
		// Own keys only: a script whose value is "toString" or "constructor" is not a generated command.
		const rewrite = Object.hasOwn(SCRIPT_REWRITES, value) ? SCRIPT_REWRITES[value] : undefined;
		if (rewrite) {
			const wrapper = byFile.get(rewrite.wrapper);
			// A customized wrapper keeps its script: the alias would drop the customization.
			if (wrapper && !wrapper.generated) {
				result.kept.push({
					file: `package.json#scripts.${name}`,
					reason: `"${value}" runs ${wrapper.path}, an unrecognised version that migrate keeps; "${rewrite.alias}" would bypass it, so switch the script by hand once you have moved its changes`,
				});
				continue;
			}
			// The deploy and destroy aliases need a stackId that an old app may not have.
			if (stackless.includes(rewrite.wrapper)) {
				result.kept.push({
					file: `package.json#scripts.${name}`,
					reason: `"${rewrite.alias}" needs "stackId" in .blocks/config.json, but ${stackIdIssue}`,
				});
				continue;
			}
			// So does a generated wrapper that runs a customized one: the alias would bypass it.
			const customizedDependency = (WRAPPER_RUNTIME_DEPENDENCIES[rewrite.wrapper] ?? [])
				.map((file) => byFile.get(file))
				.find((dependency) => dependency !== undefined && !dependency.generated);
			if (customizedDependency) {
				result.kept.push({
					file: `package.json#scripts.${name}`,
					reason: `"${value}" runs ${rewrite.wrapper}, which starts the customized ${customizedDependency.path}; "${rewrite.alias}" would bypass it, so move that change by hand`,
				});
				continue;
			}
			// So does a generated version that equals its alias only while another wrapper is generated.
			const partners =
				wrapper && Object.hasOwn(VERSION_DEPENDENCIES, wrapper.hash) ? VERSION_DEPENDENCIES[wrapper.hash] : [];
			const customizedPartner = partners
				.map((file) => byFile.get(file))
				.find((partner) => partner !== undefined && !partner.generated);
			if (customizedPartner) {
				result.kept.push({
					file: `package.json#scripts.${name}`,
					reason: `"${value}" runs ${rewrite.wrapper}, which stops the dev server of the customized ${customizedPartner.path} on its port; "${rewrite.alias}" stops the blocks.dev port instead, which migrate only sets from a generated server.ts, so move that change by hand`,
				});
				continue;
			}
			scripts[name] = rewrite.alias;
			result.scriptsRewritten[name] = { from: value, to: rewrite.alias };
		} else if (RENAMED_ALIASES.has(`cdk-${value}`)) {
			scripts[name] = `cdk-${value}`;
			result.scriptsRewritten[name] = { from: value, to: `cdk-${value}` };
		} else if (wrappers.some((w) => refersTo(value, 'package.json', w, { bare: true }))) {
			result.kept.push({
				file: `package.json#scripts.${name}`,
				reason: `"${value}" is not a generated command; replace it with a cdk-blocks command by hand`,
			});
		}
	}

	const server = byFile.get('server.ts');
	if (server?.generated && pkg.blocks?.dev === undefined) {
		const options = Object.hasOwn(SERVER_DEV_OPTIONS, server.hash) ? SERVER_DEV_OPTIONS[server.hash] : {};
		// `cdk-blocks dev` detects the same command from the dependencies; leaving it out keeps --frontend-port working.
		const { frontendCommand, ...rest } = options;
		const detected =
			frontendCommand !== undefined && options.frontendPort !== undefined
				? detectFrontend(root)?.command(options.frontendPort)
				: undefined;
		result.devConfig = frontendCommand !== undefined && frontendCommand === detected ? rest : options;
	}

	// Delete generated wrappers that nothing references after the rewrite. A
	// kept wrapper can import another one (sandbox.ts names server.ts), or start
	// it at runtime without naming it (WRAPPER_RUNTIME_DEPENDENCIES), so iterate
	// until the set of deletions is stable.
	const candidates = new Set(wrappers.filter((w) => w.generated && !stackless.includes(w.file)).map((w) => w.path));
	for (const wrapper of wrappers) {
		if (wrapper.generated && stackless.includes(wrapper.file)) {
			result.kept.push({
				file: wrapper.path,
				reason: `generated, but kept: the cdk-blocks deploy and destroy commands need "stackId" in .blocks/config.json, but ${stackIdIssue}`,
			});
		}
	}
	const namers = wrapperUsers(root, wrappers, files, repos);
	let changed = true;
	while (changed) {
		changed = false;
		// A wrapper that is going to be deleted uses nothing.
		const sources = namers.filter((namer) => !candidates.has(namer.path));
		for (const wrapper of wrappers) {
			if (!candidates.has(wrapper.path)) continue;
			const scriptUsers = Object.entries(scripts)
				.filter(([, value]) => refersTo(value, 'package.json', wrapper, { bare: true }))
				.map(([name]) => `script "${name}"`);
			const fileUsers = sources.filter((source) => source.uses.has(wrapper.path)).map((source) => source.path);
			// A wrapper that stays (customized, or kept above) still starts its runtime dependencies.
			const runtimeUsers = wrappers
				.filter(
					(user) =>
						!candidates.has(user.path) &&
						!fileUsers.includes(user.path) &&
						WRAPPER_RUNTIME_DEPENDENCIES[user.file]?.includes(wrapper.file),
				)
				.map((user) => `${user.path}, which starts it at runtime`);
			const users = [...scriptUsers, ...fileUsers, ...runtimeUsers];
			if (users.length > 0) {
				candidates.delete(wrapper.path);
				result.kept.push({
					file: wrapper.path,
					reason: `generated, but still used by ${users.join(', ')}`,
				});
				changed = true;
			}
		}
	}
	for (const wrapper of wrappers) {
		if (!wrapper.generated) {
			result.kept.push({
				file: wrapper.path,
				reason:
					'unrecognised version (only public create-blocks-app releases are recognised): it matches no wrapper that a public create-blocks-app release generated, so migrate keeps it; move any changes you made to it by hand, then delete it',
			});
		}
	}
	result.removed = wrappers.filter((w) => candidates.has(w.path)).map((w) => w.path);
	if (Object.keys(result.scriptsRewritten).length > 0 || result.devConfig) result.changed.push('package.json');
	if (pkg.scripts) pkg.scripts = scripts;
	return { result, pkg, pkgText };
}

/**
 * Write `pkg` over `original`, the unchanged `package.json` text it was parsed from, in that text's style.
 * A rename, so that a reader (another migrate run, a dev server) never sees half a file.
 */
function writePackageJson(root: string, pkg: PackageJson, original: string, devConfig: MigratedDevConfig | null): void {
	const path = join(root, 'package.json');
	const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? '  ';
	if (devConfig) pkg.blocks = { ...pkg.blocks, dev: devConfig };
	const text = `${original.startsWith('\uFEFF') ? '\uFEFF' : ''}${JSON.stringify(pkg, null, indent)}`;
	// Keep the file's line endings, so that the diff shows only the lines migrate changed.
	const eol = original.includes('\r\n') ? '\r\n' : '\n';
	const out = text.replace(/\n/g, eol);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, original.endsWith('\n') ? `${out}${eol}` : out);
	renameSync(temporary, path);
}

function describe(result: MigrateResult, dryRun: boolean): string {
	const { devConfig } = result;
	const lines: string[] = [];
	const rewritten = Object.entries(result.scriptsRewritten);
	if (rewritten.length === 0 && result.removed.length === 0 && result.kept.length === 0 && !devConfig) {
		return 'Nothing to migrate: no aws-blocks/scripts wrappers or generated scripts were found.';
	}
	const acted = rewritten.length > 0 || result.removed.length > 0 || devConfig !== null;
	if (acted)
		lines.push(dryRun ? 'Dry run; nothing was written. cdk-blocks migrate would:' : 'Migrated to the cdk-blocks CLI:');
	else lines.push('Nothing could be migrated automatically.');
	for (const [name, { from, to }] of rewritten) lines.push(`  rewrite script "${name}": ${from} -> ${to}`);
	if (devConfig) lines.push(`  set package.json "blocks.dev" to ${JSON.stringify(devConfig)}`);
	for (const file of result.removed) lines.push(`  delete ${file}`);
	if (result.kept.length > 0) {
		lines.push(
			'',
			dryRun
				? 'Would be left for you to finish by hand (exit code 1; everything else would be migrated):'
				: 'Left for you to finish by hand (exit code 1; everything else was migrated):',
		);
		for (const { file, reason } of result.kept) lines.push(`  ${file}: ${reason}`);
	}
	return lines.join('\n');
}

/** How many times {@link removeIfEmpty} tries a directory that Windows reports busy, 50 ms apart. */
const BUSY_DIR_ATTEMPTS = 5;

/**
 * Remove `dir` when it is empty; a directory that is already gone, or that was
 * refilled meanwhile, is fine. On Windows, reading or removing a directory that
 * another process holds open or is deleting (a concurrent `cdk-blocks migrate`)
 * fails with EPERM or EBUSY: try again briefly, then leave it to that process.
 */
export function removeIfEmpty(
	dir: string,
	rmdir: (dir: string) => void = rmdirSync,
	platform: NodeJS.Platform = process.platform,
): void {
	for (let attempt = 1; ; attempt++) {
		try {
			if (readdirSync(dir).length === 0) rmdir(dir);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTEMPTY') return;
			if (platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY')) throw error;
			if (attempt >= BUSY_DIR_ATTEMPTS) return;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		}
	}
}

/**
 * What git knows about `root`, after refusing (unless `force` or `dryRun`) an
 * app outside git (or without git), a repository git fails to read, an app git
 * does not track, or a dirty tree, so that git can undo what migrate writes.
 *
 * @throws {CliError} The refusal, or a git command that failed; nothing was written.
 */
function checkGit(root: string, dryRun: boolean, force: boolean): GitView {
	const git = gitView(root);
	if (dryRun || force) return git;
	if (git.kind === 'outside') {
		throw new CliError(
			'this app is not in a git work tree (or git is not installed), so its changes could not be undone with git.',
			{
				where: [`project: ${root}`],
				hint: '"cdk-blocks migrate --dry-run" to see the plan, then "cdk-blocks migrate --force" to migrate without git',
			},
		);
	}
	if (git.kind === 'refused') {
		throw new CliError(`git failed in ${root}: ${git.message}`, {
			hint: 'fix what git reports, or "cdk-blocks migrate --force" to migrate without git',
		});
	}
	if (git.kind === 'unseen') {
		throw new CliError(
			'git does not track this app (a parent repository may ignore its directory), so its changes could not be undone with git.',
			{ where: [`project: ${root}`], hint: '"cdk-blocks migrate --force" to migrate anyway' },
		);
	}
	if (git.kind === 'listed' && gitStatus(root).trim() !== '') {
		throw new CliError('the git working tree has uncommitted changes; commit or stash them first.', {
			where: [`project: ${root}`],
			hint: 'git stash, or "cdk-blocks migrate --force" to migrate anyway',
		});
	}
	return git;
}

/**
 * Write `plan`: the `package.json` rewrite, then the deletions. Refuses, and
 * writes nothing, when `package.json` is no longer the text the plan was made
 * from (the user or another run changed it meanwhile): the rewrite would
 * overwrite that change, and the deletions were decided from the old scripts.
 * Another run (or the user) may have deleted a wrapper since the plan was
 * made: the result is the same.
 *
 * @throws {CliError} The refusal.
 */
export function applyMigration(root: string, plan: MigrationPlan): void {
	const { result, pkg, pkgText } = plan;
	if (result.changed.length === 0 && result.removed.length === 0) return;
	if (unlessGone(() => readFileSync(join(root, 'package.json'), 'utf-8')) !== pkgText) {
		throw new CliError('package.json changed while cdk-blocks migrate ran; nothing was written.', {
			where: [`project: ${root}`],
			hint: '"cdk-blocks migrate" again, to plan from the current package.json',
		});
	}
	if (result.changed.includes('package.json')) writePackageJson(root, pkg, pkgText, result.devConfig);
	for (const file of result.removed) rmSync(join(root, file), { force: true });
	if (result.removed.length > 0) removeIfEmpty(join(root, SCRIPTS_DIR));
}

/**
 * `error`, after printing it as `{"error": {"message", "hint"}}` under
 * `--output json` when it is a refusal: a JSON consumer tells a refusal
 * (nothing written) from kept items (also exit 1) by this document. `--query`
 * prints one field of the result, which a refusal does not have: the error
 * goes to stderr only.
 */
function refusal(ctx: Context, error: unknown): unknown {
	if (error instanceof CliError && ctx.globals.output === 'json' && ctx.globals.query === undefined) {
		ctx.out.text(JSON.stringify({ error: { message: error.message, hint: error.hint ?? null } }, null, 2));
	}
	return error;
}

export async function migrate(ctx: Context, input: CommandInput): Promise<number> {
	const root = ctx.requireRoot();
	const dryRun = input.flags['dry-run'] === true;
	let git: GitView;
	try {
		git = checkGit(root, dryRun, input.flags.force === true);
	} catch (error) {
		throw refusal(ctx, error);
	}
	const plan = planMigration(root, git.kind === 'listed' ? git.files : null, git.kind === 'listed' ? git.repos : []);
	if (!dryRun) {
		try {
			applyMigration(root, plan);
		} catch (error) {
			throw refusal(ctx, error);
		}
	}
	ctx.out.result(plan.result, describe(plan.result, dryRun));
	return plan.result.kept.length > 0 ? ExitCode.Failure : ExitCode.Ok;
}
