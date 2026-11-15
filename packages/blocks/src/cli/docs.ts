// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `cdk-blocks docs`: the docs that @aws-blocks/blocks ships in its `docs/` folder
 * (generated at prebuild and prepack by scripts/gen-block-docs.mjs), looked up by
 * name instead of by path. A block is named by its class, its folder or its folder
 * without `bb-`; an export or an option by its name in the blocks' API reports.
 *
 * Every doc or excerpt printed starts with the line `# <folder>/<file> (<absolute path>)`,
 * so the reader can cite or re-read the file. Everything below {@link docs} reads a
 * docs folder passed in, so tests run it on a fixture folder.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocksVersion, type Context } from './context.js';
import { BLOCKS_COMMAND, CliError, ExitCode, UsageError } from './errors.js';
import { suggest } from './parse.js';
import type { CommandInput } from './registry.js';

/** The docs command as it runs in an app's shell (`npx --no -- cdk-blocks docs`; see BLOCKS_COMMAND). */
const CLI = `${BLOCKS_COMMAND} docs`;

/**
 * The forms of `<command>` and what each prints, aligned: `cdk-blocks docs` in `--help`, the runnable {@link CLI} in
 * the listing. A function declaration, not a constant: registry.ts calls it while this module is still loading
 * (docs.js → parse.js → registry.js), before its constants exist.
 */
export function docsForms(command: string): string[] {
	const forms: [string, string[]][] = [
		['', ['the blocks, their classes and what each does']],
		[
			' <block>...',
			[
				"each block's README; a block is its class (DistributedTable),",
				'its folder (bb-distributed-table) or the folder without bb-',
			],
		],
		[
			' <name>...',
			[
				'an export, an option or Owner.member (ApiError, ifFieldEquals,',
				'Secret.get): its import line, declaration and the docs about it',
			],
		],
	];
	const width = command.length + 23;
	return forms.flatMap(([form, [first, ...rest]]) => [
		`  ${`${command}${form}`.padEnd(width)}${first}`,
		...rest.map((line) => `  ${' '.repeat(width)}${line}`),
	]);
}

/** The options as the listing names them; `--help` prints the same from the registry's flags. */
const DOCS_OPTIONS = [
	"  --api                  the block's API report (exact signatures) instead of its README",
	'  --section <topic>      the part of the docs about a topic; repeatable; with no topic, the headings',
	'  --exports [filter...]  the names @aws-blocks/blocks and its entries export, and which entry to use',
	'  --search <term>        matching lines in every doc, or in the named blocks, with their section',
];

/** Lines of a README section a card prints before pointing at `--section`. */
const CARD_SECTION_LINES = 60;
/** Blocks a card prints in full; it names the others with the lookup that prints each. */
const CARD_OWNERS = 3;
const SEARCH_HITS = 40;
const SEARCH_HITS_PER_FILE = 4;
/** Section slugs a `--section` miss lists (headings of levels 2 and 3). */
const SECTIONS_LISTED = 40;
/** Lines an unknown name's error prints from the docs that mention it. */
const UNKNOWN_NAME_HITS = 5;
/** Exports an unknown name's error lists that have every word of it. */
const NAMES_LISTED = 8;
const SEARCH_LINE_LENGTH = 200;
/** A search hit names its section by slug; `--section` takes a slug prefix, so a long one is cut. */
const SEARCH_SLUG_LENGTH = 40;
const LISTED_CLASSES = 4;

/** A docs folder of one block, or one of the root docs (`guide`, `troubleshooting`). */
export interface DocsBlock {
	/** `bb-distributed-table`, `core`, `guide`, `troubleshooting`. */
	name: string;
	purpose: string;
	dir: string;
	/** Prefix of the block's files in the docs folder: `bb-kv-store/`, or `''` for a root doc. */
	prefix: string;
	/** File printed without --api or a doc path. */
	main: string;
	/** Markdown files of the block's folder (README.md, API.md, DESIGN.md, ...), `main` first. */
	files: string[];
	/** Class names that name the block (the vendorize map's): `cdk-blocks docs DistributedTable` prints its README. */
	named: string[];
	/** Classes shown in the listing: the named ones, else the classes (and class-like constants) it declares. */
	classes: string[];
}

/** A top-level declaration of a block's API report. */
export interface Declaration {
	name: string;
	kind: string;
	block: string;
	/** The declaration as the report has it, without the report's `// @public` comment lines. */
	lines: string[];
	/** Names of the declaration's members (methods, properties, option fields). */
	members: string[];
	/**
	 * For a declaration the report only names (`ae-forgotten-export`: SecretImpl, the type `Secret` stands for): the
	 * installed type file it was read from, its doc comment, and the report declarations that stand for it. Its
	 * `lines` keep the doc comments of its members.
	 */
	file?: string;
	doc?: string[];
	standsFor?: string[];
	/** Constructor consts whose `new (…)` returns this declaration: RealtimeServer is what `new Realtime(…)` returns. */
	returnedBy?: string[];
}

/** An API report's warning that a declaration it uses is not exported, which leaves its members out of the report. */
const FORGOTTEN = /The symbol "([\w$]+)" needs to be exported by the entry point/g;

export interface DocsIndex {
	dir: string;
	blocks: DocsBlock[];
	/** Export name → declarations, in block order. */
	declarations: Map<string, Declaration[]>;
	/** Member name → the declarations that have it. */
	members: Map<string, Declaration[]>;
	/**
	 * Every name `import { … } from '@aws-blocks/blocks'` takes, with the declaration it resolves to: the umbrella's
	 * own declarations, then the names it exports one by one (`import { PutOptions as DTPutOptions } from
	 * '@aws-blocks/bb-distributed-table'` and `export { DTPutOptions }`), then everything of the packages it
	 * re-exports whole (`export * from "@aws-blocks/core"`), each followed to the package that declares it (core's
	 * `config` is hosting's). An earlier name shadows a later one, as in TypeScript.
	 */
	umbrellaExports: Map<string, ExportRef>;
	/** Blocks whose exports @aws-blocks/blocks re-exports whole, directly or through another such block. */
	wildcardBlocks: Set<string>;
	/**
	 * What the installed @aws-blocks/blocks exports outside its main entry, read from its package.json and type files:
	 * each app-facing subpath entry (`@aws-blocks/blocks/client`, `/ui`, `/utils`, …; not `/cdk`, which is the main
	 * entry for CDK code) and the main entry under the browser condition, which browser code and tests get
	 * (`npm run test:e2e` runs `tsx -C browser`). Each maps a name to whether it is a type only. `files` has the type
	 * file of every entry, the main one included, for the declarations no API report in the docs has. Undefined when
	 * the package's type files could not be read.
	 */
	entries?: {
		subpaths: Map<string, Map<string, boolean>>;
		browserMain: Map<string, boolean>;
		files: Map<string, string>;
	};
	/** Names the API reports import from packages outside AWS Blocks (`StandardSchemaV1`): the package, the blocks. */
	externals: Map<string, { from: string; type: boolean; blocks: string[] }>;
	/**
	 * A report declaration's lowercase name → the unexported declarations it stands for, with the members it omits
	 * from them: `secret` → SecretImpl without `put` (`Omit<SecretImpl<T>, 'put'>`).
	 */
	aliases: Map<string, { name: string; omit: string[] }[]>;
}

/** The declaration an exported name is: a docs folder (or the umbrella) and the name declared there. */
export interface ExportRef {
	block: string;
	name: string;
}

export interface DocsRequest {
	names: string[];
	api: boolean;
	/** The headings instead of the text: a bare `--section`, with no topic after it. */
	toc: boolean;
	sections: string[];
	search?: string;
	/** List the names @aws-blocks/blocks exports; `names` filter the list. */
	exports?: boolean;
}

interface Section {
	level: number;
	title: string;
	slug: string;
	/** 1-based first line (the heading) and last line of the section, subsections included. */
	start: number;
	end: number;
}

/** The root doc that owns @aws-blocks/blocks' own API report (`cdk-blocks docs guide --api`). */
const UMBRELLA = 'guide';

/** The package a declaration is in: the umbrella's own are @aws-blocks/blocks'. */
function packageOf(block: string): string {
	return `@aws-blocks/${block === UMBRELLA ? 'blocks' : block}`;
}

const ROOT_DOCS = [
	{
		name: 'guide',
		file: 'README.md',
		aliases: ['guide', 'readme', 'blocks', '@aws-blocks/blocks'],
		purpose: 'How an app fits together, the block catalog, local dev, deploy and testing.',
	},
	{
		name: 'troubleshooting',
		file: 'TROUBLESHOOTING.md',
		aliases: ['troubleshooting'],
		purpose: 'Common errors and their fixes.',
	},
];

/** `cdk-blocks docs [name...]`. */
export async function docs(ctx: Context, input: CommandInput): Promise<number> {
	const request: DocsRequest = {
		names: input.positionals,
		api: input.flags.api === true,
		// The `bare` meaning of `--section` (registry.ts): a `--section` with no topic asks for the headings.
		toc: input.flags.toc === true,
		sections: Array.isArray(input.flags.section) ? input.flags.section : [],
		search: typeof input.flags.search === 'string' ? input.flags.search : undefined,
		exports: input.flags.exports === true,
	};
	ctx.out.text(renderDocs(loadDocs(shippedDocsDir()), request, blocksVersion()));
	return ExitCode.Ok;
}

/** The docs folder of this installed @aws-blocks/blocks (compiled to dist/cli/, so two levels up). */
export function shippedDocsDir(): string {
	return fileURLToPath(new URL('../../docs/', import.meta.url));
}

/** Read a docs folder: its blocks and root docs, the declarations of every API report and what each exports. */
export function loadDocs(
	dir: string,
	vendorize?: Record<string, string[]>,
	entries: DocsIndex['entries'] = readEntries(join(dir, '..')),
): DocsIndex {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) {
		throw new CliError(`no docs folder at ${dir}.`, {
			hint: 'it is generated when @aws-blocks/blocks is built or packed; reinstall the package',
		});
	}
	const classMap = vendorize ?? readVendorize(dir);
	const rootFiles = markdownFiles(dir);
	const readme = rootFiles.includes('README.md') ? readFileSync(join(dir, 'README.md'), 'utf-8') : '';
	const purposes = parseCatalog(readme);
	const blocks: DocsBlock[] = [];
	for (const root of ROOT_DOCS) {
		if (!rootFiles.includes(root.file)) continue;
		// `guide` also owns the other root files: `cdk-blocks docs guide --api` is the umbrella API report.
		const files =
			root.name === 'guide'
				? [root.file, ...rootFiles.filter((f) => f !== root.file && f !== 'TROUBLESHOOTING.md')]
				: [root.file];
		blocks.push({
			name: root.name,
			purpose: root.purpose,
			dir,
			prefix: '',
			main: root.file,
			files,
			named: [],
			classes: [],
		});
	}
	const declarations = new Map<string, Declaration[]>();
	const members = new Map<string, Declaration[]>();
	const folders = readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const reports = new Map<string, Report>();
	const reportTexts: [string, string][] = [];
	const aliases: DocsIndex['aliases'] = new Map();
	// Block packages resolve from the package that ships these docs, as the app's own imports do.
	const blocksRequire = createRequire(join(dir, '..', 'package.json'));
	for (const folder of folders) {
		const blockDir = join(dir, folder);
		const files = markdownFiles(blockDir);
		if (files.length === 0) continue;
		const report = files.includes('API.md') ? readFileSync(join(blockDir, 'API.md'), 'utf-8') : '';
		const declared = parseApiReport(report, folder);
		if (report) {
			reports.set(folder, { own: exportedNames(report), ...parseReexports(report) });
			reportTexts.push([folder, report]);
		}
		for (const decl of declared) {
			push(declarations, decl.name, decl);
			for (const member of decl.members) push(members, member, decl);
		}
		// What the report only names: its members come from the block's installed type file.
		for (const symbol of new Set([...report.matchAll(FORGOTTEN)].map((m) => m[1]))) {
			const file = blockTypesFile(blocksRequire, folder);
			const found = file ? typesDeclaration(file, symbol, new Set(), true) : undefined;
			if (!found) continue;
			const escaped = escapeRegExp(symbol);
			const mentions = new RegExp(`(^|[^\\w$])${escaped}([^\\w$]|$)`);
			const omits = new RegExp(`Omit<\\s*${escaped}\\b(?:<[^>]*>)?\\s*,\\s*([^>]+)>`);
			// `export type Secret<T> = Omit<SecretImpl<T>, 'put'>` and `export const ApiNamespace: ApiNamespaceConstructor`
			// stand for it as their type; `export class Agent<T> extends AgentBase<T>` has it as a base.
			const relation = (d: Declaration) => {
				const head = d.lines[0];
				if (
					(d.kind === 'class' || d.kind === 'interface') &&
					new RegExp(`\\bextends\\s+${escaped}\\b`).test(head)
				)
					return `a base of ${d.name}`;
				if ((d.kind === 'type' || d.kind === 'const') && mentions.test(head)) return `the type of ${d.name}`;
				return undefined;
			};
			const standing = declared.filter((d) => relation(d) !== undefined);
			const standsFor = standing.map((d) => relation(d) as string);
			const body = found.lines.slice(found.doc);
			const decl: Declaration = {
				name: symbol,
				kind: found.kind,
				block: folder,
				lines: body,
				members: membersOf(body),
				file: found.file,
				doc: found.lines.slice(0, found.doc),
				standsFor,
			};
			push(declarations, symbol, decl);
			for (const member of decl.members) push(members, member, decl);
			for (const alias of standing) {
				const omit = [...(omits.exec(alias.lines[0])?.[1] ?? '').matchAll(/['"]([\w$]+)['"]/g)].map(
					(m) => m[1],
				);
				push(aliases, alias.name.toLowerCase(), { name: symbol, omit });
			}
		}
		// What `new X(…)` returns for a constructor const, inline (`Realtime: { new …: RealtimeServer<T> }`) or through
		// its interface (`Secret: SecretConstructor`, whose `new` returns WritableSecret or Secret): X's members are
		// that type's.
		for (const d of declared.filter((x) => x.kind === 'const')) {
			const ctor = /^export const [\w$]+:\s*([\w$]+)\s*;/.exec(d.lines[0])?.[1];
			const source = ctor
				? (declarations.get(ctor) ?? []).filter((x) => x.block === folder).flatMap((x) => x.lines)
				: d.lines;
			for (const type of constructed(source.join('\n'))) {
				if (type === d.name) continue;
				push(aliases, d.name.toLowerCase(), { name: type, omit: [] });
				for (const target of declarations.get(type) ?? []) {
					if (target.block !== folder) continue;
					target.returnedBy = [...(target.returnedBy ?? []), d.name];
				}
			}
		}
		const named = classMap[`@aws-blocks/${folder}`] ?? [];
		const declaredClasses = declared
			.filter((d) => d.kind === 'class' || (d.kind === 'const' && /:\s*\w+Constructor\b/.test(d.lines[0])))
			.map((d) => d.name);
		blocks.push({
			name: folder,
			purpose: purposes.get(folder) ?? '',
			dir: blockDir,
			prefix: `${folder}/`,
			main: files.includes('README.md') ? 'README.md' : files[0],
			files,
			named,
			classes: named.length ? named : declaredClasses,
		});
	}
	const umbrella = rootFiles.includes('API.md') ? readFileSync(join(dir, 'API.md'), 'utf-8') : '';
	// The umbrella's own declarations (getSdkIdentifiers' typed overloads) belong to the guide: they are
	// @aws-blocks/blocks' own exports, and they shadow the same name from a package it re-exports whole.
	const own = parseApiReport(umbrella, UMBRELLA);
	for (const decl of own) {
		push(declarations, decl.name, decl);
		for (const member of decl.members) push(members, member, decl);
	}
	reports.set(UMBRELLA, { own: exportedNames(umbrella), ...parseReexports(umbrella) });
	const wildcardBlocks = new Set<string>();
	const reach = (block: string) => {
		for (const w of reports.get(block)?.wildcards ?? []) {
			if (!wildcardBlocks.has(w)) {
				wildcardBlocks.add(w);
				reach(w);
			}
		}
	};
	reach(UMBRELLA);
	const externals = new Map<string, { from: string; type: boolean; blocks: string[] }>();
	for (const [block, report] of [...reportTexts, [UMBRELLA, umbrella] as [string, string]]) {
		for (const m of report.matchAll(/^import (type )?\{ ([\w$]+) \} from ['"]([^'"]+)['"]/gm)) {
			if (m[3].startsWith('@aws-blocks/')) continue;
			const known = externals.get(m[2]);
			if (known) known.blocks.push(block);
			else externals.set(m[2], { from: m[3], type: m[1] !== undefined, blocks: [block] });
		}
	}
	return {
		dir,
		blocks,
		declarations,
		members,
		umbrellaExports: exportsOf(reports, UMBRELLA),
		wildcardBlocks,
		entries,
		externals,
		aliases,
	};
}

/** The type file of a block's installed package: the `.d.ts` beside the file its main entry resolves to. */
function blockTypesFile(require: NodeJS.Require, folder: string): string | undefined {
	try {
		const file = require.resolve(`@aws-blocks/${folder}`).replace(/\.c?js$/, '.d.ts');
		return existsSync(file) ? file : undefined;
	} catch {
		return undefined;
	}
}

/** What one API report declares and re-exports. */
interface Report {
	own: Set<string>;
	/** Names it exports one by one from another package: `import { A as B } from '@aws-blocks/x'` + `export { B }`. */
	named: Map<string, ExportRef>;
	/** Packages it re-exports whole: `export * from '@aws-blocks/x'`. */
	wildcards: string[];
}

/**
 * Every name an API report declares as an export, `_reset…` helpers included: what `import { … }` can take. Cards
 * leave the `_` names out (parseApiReport), the list of importable names does not.
 */
function exportedNames(report: string): Set<string> {
	return new Set(
		[
			...report.matchAll(
				/^export (?:declare )?(?:abstract )?(?:class|interface|type|function|const|enum|namespace) ([A-Za-z_$][\w$]*)/gm,
			),
		].map((m) => m[1]),
	);
}

function parseReexports(report: string): Pick<Report, 'named' | 'wildcards'> {
	const imported = new Map(
		[...report.matchAll(/^import \{ ([\w$]+)(?: as ([\w$]+))? \} from ['"]@aws-blocks\/([^'"]+)['"]/gm)].map(
			(m) => [m[2] ?? m[1], { block: m[3], name: m[1] }],
		),
	);
	const named = new Map<string, ExportRef>();
	for (const m of report.matchAll(/^export \{ ([^}]+) \}/gm)) {
		for (const n of m[1].split(',').map((s) => s.trim())) {
			const ref = imported.get(n);
			if (ref) named.set(n, ref);
		}
	}
	const wildcards = [...report.matchAll(/^export \* from ['"]@aws-blocks\/([^'"]+)['"]/gm)].map((m) => m[1]);
	return { named, wildcards };
}

/**
 * The names a package exports, each followed to the declaring package: own declarations first, then names it
 * exports one by one, then the packages it re-exports whole. A package without an API report in the docs
 * (hosting) ends a chain: the name stays its own.
 */
function exportsOf(reports: Map<string, Report>, block: string, seen = new Set<string>()): Map<string, ExportRef> {
	const out = new Map<string, ExportRef>();
	const report = reports.get(block);
	if (!report || seen.has(block)) return out;
	seen.add(block);
	for (const name of report.own) out.set(name, { block, name });
	for (const [pub, ref] of report.named) {
		if (!out.has(pub)) out.set(pub, exportsOf(reports, ref.block, new Set(seen)).get(ref.name) ?? ref);
	}
	for (const w of report.wildcards) {
		for (const [pub, ref] of exportsOf(reports, w, seen)) if (!out.has(pub)) out.set(pub, ref);
	}
	return out;
}

/** The umbrella package, and its entry that browser code and tests import values from. */
const BLOCKS = '@aws-blocks/blocks';
const CLIENT = `${BLOCKS}/client`;

/**
 * {@link DocsIndex.entries} of the package at `root`: every subpath of its package.json `exports` with a `types` file
 * (except `./cdk`), the type file of the main entry's `browser` file, and each entry's type file.
 */
function readEntries(root: string): DocsIndex['entries'] {
	const pkgFile = join(root, 'package.json');
	if (!existsSync(pkgFile)) return undefined;
	const exportsMap: Record<string, unknown> = JSON.parse(readFileSync(pkgFile, 'utf-8')).exports ?? {};
	const field = (value: unknown, key: string) =>
		typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
	const subpaths = new Map<string, Map<string, boolean>>();
	const files = new Map<string, string>();
	for (const [key, value] of Object.entries(exportsMap)) {
		const file = field(value, 'types');
		if (key === './cdk' || key.includes('*') || typeof file !== 'string') continue;
		files.set(`${BLOCKS}${key.slice(1)}`, join(root, file));
		if (key !== '.') subpaths.set(`${BLOCKS}${key.slice(1)}`, typesExports(join(root, file)));
	}
	const browser = field(exportsMap['.'], 'browser');
	const browserMain =
		typeof browser === 'string' ? typesExports(join(root, browser.replace(/\.c?js$/, '.d.ts'))) : new Map();
	return { subpaths, browserMain, files };
}

/** A declaration read from an installed type file: `name` is the name the file declares, which a rename can change. */
interface TypesDeclaration {
	file: string;
	name: string;
	kind: string;
	lines: string[];
	/** Lines of the doc comment of its first overload, which `lines` starts with. */
	doc: number;
}

/**
 * The declaration of `name` in a type file, with the doc comment above each of its lines (overloads), followed
 * through `export { … } from` (and its `as` renames) and `export * from`. With `local`, also a declaration the file
 * does not export (`declare class SecretImpl`), followed through its imports.
 */
function typesDeclaration(
	file: string,
	name: string,
	seen = new Set<string>(),
	local = false,
): TypesDeclaration | undefined {
	const key = `${file}#${name}`;
	if (seen.has(key) || !existsSync(file)) return undefined;
	seen.add(key);
	const text = readTypeFile(file);
	const lines = text.split('\n');
	const pattern = new RegExp(
		`^${local ? '(?:export )?' : 'export '}(?:declare )?(?:abstract )?(function|class|const|let|var|interface|type|enum|namespace) ${escapeRegExp(name)}(?![\\w$])`,
	);
	const out: string[] = [];
	let kind: string | undefined;
	let doc = 0;
	for (let i = 0; i < lines.length; i++) {
		const m = pattern.exec(lines[i]);
		if (!m) continue;
		const comment = docComment(lines, i);
		if (!kind) doc = comment.length;
		kind ??= m[1];
		const end = declarationEnd(lines, i);
		out.push(...comment, ...lines.slice(i, end + 1));
		i = end;
	}
	if (kind) return { file, name, kind, lines: out, doc };
	const require = createRequire(file);
	const resolve = (spec: string) => {
		try {
			return require.resolve(spec).replace(/\.c?js$/, '.d.ts');
		} catch {
			return undefined;
		}
	};
	const clauses = local
		? /^(?:export|import) (?:type )?\{([^}]*)\} from ['"]([^'"]+)['"]/gm
		: /^export (?:type )?\{([^}]*)\} from ['"]([^'"]+)['"]/gm;
	for (const m of text.matchAll(clauses)) {
		for (const part of m[1].split(',')) {
			const [original, alias] = part
				.trim()
				.replace(/^type\s+/, '')
				.split(/\s+as\s+/);
			if ((alias ?? original) !== name) continue;
			const target = resolve(m[2]);
			return target ? typesDeclaration(target, original, seen, local) : undefined;
		}
	}
	for (const m of text.matchAll(/^export \* from ['"]([^'"]+)['"]/gm)) {
		const target = resolve(m[1]);
		const found = target ? typesDeclaration(target, name, seen, local) : undefined;
		if (found) return found;
	}
	// A declaration the package does not export can be in any of its type files the entry reaches: core's
	// ApiNamespaceConstructor is in api.d.ts, which index.d.ts names only for ApiNamespace.
	if (local) {
		for (const m of text.matchAll(/^(?:export|import)\b[^'"]*?\bfrom ['"](\.[^'"]+)['"]/gm)) {
			const target = resolve(m[1]);
			const found = target ? typesDeclaration(target, name, seen, local) : undefined;
			if (found) return found;
		}
	}
	return undefined;
}

/** A type file's text, read once per process: one lookup can reach the same files many times. */
const typeFiles = new Map<string, string>();
function readTypeFile(file: string): string {
	let text = typeFiles.get(file);
	if (text === undefined) {
		text = readFileSync(file, 'utf-8');
		typeFiles.set(file, text);
	}
	return text;
}

/**
 * The types the construct signatures in `text` return, each part of an intersection or union:
 * `new <T = string>(scope, id, options?: O): Secret<T>` → Secret; `…): Scope & RealtimeServer<T>` → Scope and
 * RealtimeServer. Parameters may nest brackets (`handler: () => void`); a type parameter list may not hold `>`.
 */
function constructed(text: string): string[] {
	const out = new Set<string>();
	for (const m of text.matchAll(/\bnew\s*(?:<[^>]*>)?\s*\(/g)) {
		let depth = 0;
		let i = (m.index ?? 0) + m[0].length - 1;
		for (; i < text.length; i++) {
			if (text[i] === '(') depth++;
			else if (text[i] === ')' && --depth === 0) break;
		}
		const returned = /^\)\s*:\s*([^;\n]+)/.exec(text.slice(i))?.[1] ?? '';
		for (const part of returned.split(/[&|]/)) {
			const type = /^\s*([A-Za-z_$][\w$]*)/.exec(part)?.[1];
			if (type) out.add(type);
		}
	}
	return [...out];
}

/** The member names on a declaration's lines after its first, as an API report's members are read. */
function membersOf(lines: string[]): string[] {
	const out = new Set<string>();
	for (const line of lines.slice(1)) {
		const member = MEMBER.exec(line);
		if (member && member[1] !== 'constructor') out.add(member[1]);
	}
	return [...out];
}

/** The `/** … *\/` comment that ends on the line above `i`, if any. */
function docComment(lines: string[], i: number): string[] {
	if (i === 0 || !lines[i - 1].trim().endsWith('*/')) return [];
	let start = i - 1;
	while (start > 0 && !lines[start].trim().startsWith('/**')) start--;
	return lines[start].trim().startsWith('/**') ? lines.slice(start, i) : [];
}

/**
 * The last line of the declaration that starts on line `i`: where its brackets close and it ends with `;` or `}`.
 * Comment lines inside it count no brackets and end nothing (a doc comment's prose or example code).
 */
function declarationEnd(lines: string[], i: number): number {
	let depth = 0;
	let end = i;
	for (let j = i; j < lines.length; j++) {
		end = j;
		if (j > i && COMMENT_LINE.test(lines[j])) continue;
		for (const ch of lines[j]) {
			if (ch === '{' || ch === '(' || ch === '[') depth++;
			else if (ch === '}' || ch === ')' || ch === ']') depth--;
		}
		if (depth <= 0 && /[;}]\s*$/.test(lines[j])) break;
		if (depth <= 0 && j > i && lines[j].trim() === '') break;
	}
	return end;
}

/** The names a type file exports, each with whether it is a type only, followed through `export * from`. */
function typesExports(file: string, seen = new Set<string>()): Map<string, boolean> {
	const out = new Map<string, boolean>();
	if (seen.has(file) || !existsSync(file)) return out;
	seen.add(file);
	const text = readFileSync(file, 'utf-8');
	const require = createRequire(file);
	for (const m of text.matchAll(/^export \* from ['"]([^'"]+)['"]/gm)) {
		let target: string | undefined;
		try {
			target = require.resolve(m[1]).replace(/\.c?js$/, '.d.ts');
		} catch {
			target = undefined;
		}
		if (target) for (const [n, type] of typesExports(target, seen)) out.set(n, type);
	}
	// `export { A, type B }` and `export type { C }`: a name is a type when the clause or the name says so.
	for (const m of text.matchAll(/^export (type )?\{([^}]*)\}/gm)) {
		for (const part of m[2].split(',')) {
			const spec = part.trim();
			const name = spec
				.replace(/^type\s+/, '')
				.split(/\s+as\s+/)
				.pop();
			if (name) out.set(name, m[1] !== undefined || spec.startsWith('type '));
		}
	}
	for (const m of text.matchAll(
		/^export (?:declare )?(?:abstract )?(function|class|const|let|var|interface|type|enum|namespace) ([A-Za-z_$][\w$]*)/gm,
	)) {
		out.set(m[2], m[1] === 'interface' || m[1] === 'type');
	}
	return out;
}

/** The text `cdk-blocks docs` prints for a request. */
export function renderDocs(index: DocsIndex, request: DocsRequest, version: string): string {
	const { names } = request;
	if (request.exports) {
		if (request.search !== undefined || request.toc || request.sections.length || request.api) {
			throw new UsageError('--exports does not combine with --search, --section or --api.');
		}
		return exportsList(index, names);
	}
	if (request.search !== undefined) {
		// A bare `--section` adds nothing a search lacks (each hit names its section): `core --section --search withAuth`
		// searches core.
		if (request.sections.length || request.api) {
			throw new UsageError('--search does not combine with a --section topic or --api.');
		}
		return search(
			index,
			request.search,
			names.flatMap((name) => searchScope(index, name)),
		);
	}
	if (names.length === 0) {
		// A bare `--section` alone asks for an overview: the list of blocks is the docs' table of contents.
		if (request.api || request.sections.length) {
			throw new UsageError(`name a block, for example: ${CLI} DistributedTable --api`, { hint: CLI });
		}
		return listing(index, version);
	}
	// `--section` with several blocks reads each: `KVStore DistributedTable --section ttl`.
	return names.map((name) => renderName(index, name, request)).join('\n');
}

function renderName(index: DocsIndex, name: string, request: DocsRequest): string {
	const block = findBlock(index, name);
	if (!block) {
		const decls = findDeclarations(index, name);
		if (decls) return `${decls.note ? `${decls.note}\n` : ''}${card(index, decls.name, decls.found, decls.member)}`;
		const imported = importCard(index, name);
		if (imported) return imported;
		const entry = entryListing(index, name) ?? valueCard(index, name);
		if (entry) return entry;
		throw unknownName(index, name);
	}
	// A doc path or a doc's own name names its file too: `bb-cron-job/DESIGN.md`, `CUSTOMIZING-AUTH-UI`. A path to a
	// file the block lacks fails, instead of printing the README.
	const path = /\/([^/]+\.md)$/i.exec(name.trim())?.[1];
	const fileName = (path ?? `${name.trim()}.md`).toLowerCase();
	const own = block.files.find((f) => f.toLowerCase() === fileName);
	const files = [request.api ? 'API.md' : (own ?? path ?? block.main)];
	const out: string[] = [];
	const read = (file: string) => {
		const path = join(block.dir, file);
		return { path, text: readFileSync(path, 'utf-8'), header: `# ${block.prefix}${file} (${path})` };
	};
	for (const file of files) {
		if (!block.files.includes(file)) {
			throw new CliError(`${block.name} has no ${file}. Its files: ${block.files.join(', ')}.`, {
				hint: `${CLI} ${block.name}${block.files.includes('API.md') ? ' --api' : ''}`,
			});
		}
		const { text, header } = read(file);
		if (request.toc) {
			out.push(toc(block, file, text));
		} else if (request.sections.length) {
			// The block's README is its default doc, not its only one. A heading of the README answers first; else a
			// heading of another doc that names the topic (bb-auth's CUSTOMIZING-AUTH-UI.md, by its title); else the
			// README's looser answers. A subsection of another doc that one word starts is not one: `Auth --section
			// password` answers with the README's lines on sign-in options, not DESIGN.md's "Password reset ends every
			// session".
			const others =
				file === block.main && !own && !request.api
					? block.files.filter((f) => f !== file && !/^(changelog|api)\.md$/i.test(f))
					: [];
			let shown: string | undefined;
			const candidates = [{ file, text, header }, ...others.map((f) => ({ file: f, ...read(f) }))];
			for (const raw of request.sections) {
				// grep's alternatives (`deepEqual\|equal`): the first one a heading names, else the first.
				const options = decodeEntities(raw)
					.split(/\\?\|/)
					.map((a) => a.trim())
					.filter(Boolean);
				const wanted =
					options.find((a) => candidates.some((d) => namedSection(d.text, a))) ?? options[0] ?? raw;
				const readme = candidates[0];
				const named = namedSection(readme.text, wanted)
					? readme
					: (candidates.find((d) => namedSection(d.text, wanted, true)) ?? readme);
				// Else the README's own answer (a word-start heading, the lines that mention the topic), then the block's
				// other docs: `atomic` can be in DESIGN.md only. The first error, the README's, lists its sections.
				const found = withOtherBlocks(index, block, wanted, () => {
					let first: unknown;
					for (const doc of [named, ...candidates.filter((d) => d !== named)]) {
						try {
							return { doc, text: sectionText(block, doc.file, doc.text, wanted) };
						} catch (error) {
							if (!(error instanceof UsageError)) throw error;
							first ??= error;
						}
					}
					throw first;
				});
				if (found.doc.header !== shown) out.push(found.doc.header);
				shown = found.doc.header;
				out.push(found.text);
			}
		} else {
			out.push(header, text.endsWith('\n') ? text.slice(0, -1) : text);
		}
	}
	return `${out.join('\n')}\n`;
}

/**
 * `section()`, or when the block has no such section, the same error naming the other blocks whose README has a
 * heading for it (`DistributedTable --section transaction`: bb-data has "Transactions").
 */
function withOtherBlocks<T>(index: DocsIndex, block: DocsBlock, wanted: string, section: () => T): T {
	try {
		return section();
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		const others = index.blocks
			.filter((b) => b.prefix && b !== block && b.files.includes('README.md'))
			.flatMap((b) => {
				const s = namedSection(readFileSync(join(b.dir, 'README.md'), 'utf-8'), wanted);
				return s ? [`${CLI} ${b.name} --section ${s.slug}`] : [];
			});
		if (!others.length) throw error;
		throw new UsageError(`${error.message}\nOther blocks have it: ${others.slice(0, CARD_OWNERS).join('; ')}`, {
			hint: error.hint,
		});
	}
}

/** `&amp;` and the other entities an agent can copy from rendered HTML into a heading or a search term. */
function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}

// ── Lookup ───────────────────────────────────────────────────────────────────

/**
 * A block by folder name, folder without `bb-`, the class that names it, or a root doc's name; a doc path names its
 * folder (`bb-cron-job/DESIGN.md`, `node_modules/@aws-blocks/blocks/docs/bb-kv-store/README.md`).
 */
export function findBlock(index: DocsIndex, name: string): DocsBlock | undefined {
	const key = name
		.trim()
		.toLowerCase()
		.replace(/^.*\/docs\//, '')
		.replace(/\/[^/]+\.md$/, '')
		.replace(/^@aws-blocks\//, '')
		.replace(/\/+$/, '');
	const root = ROOT_DOCS.find((r) => r.aliases.includes(key));
	if (root) return index.blocks.find((b) => b.name === root.name);
	return (
		index.blocks.find((b) => b.prefix && (b.name === key || b.name === `bb-${key}`)) ??
		index.blocks.find((b) => b.named.some((c) => c.toLowerCase() === key)) ??
		// A doc of its own (auth-common's CUSTOMIZING-AUTH-UI.md), not a name every block has.
		(/^(readme|api|design|changelog)$/.test(key)
			? undefined
			: index.blocks.find((b) => b.prefix && b.files.some((f) => f.toLowerCase() === `${key}.md`)))
	);
}

/**
 * The names of a subpath entry named as `ui`, `/ui`, `blocks/ui` or `@aws-blocks/blocks/ui`, with the import they take;
 * undefined for any other name.
 */
function entryListing(index: DocsIndex, name: string): string | undefined {
	const key = name
		.trim()
		.toLowerCase()
		.replace(/^@aws-blocks\//, '')
		.replace(/^blocks\//, '')
		.replace(/^\//, '');
	const entry = [...(index.entries?.subpaths ?? [])].find(([e]) => e.toLowerCase() === `${BLOCKS}/${key}`);
	if (!entry) return undefined;
	const [path, names] = entry;
	const sorted = [...names.keys()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
	return `${[
		`${path} (${sorted.length} names): import { <name> } from '${path}';${path === CLIENT ? ' browser code and tests import values from it' : ''}`,
		`  ${sorted.join(', ')}`,
		`A name's declaration: ${CLI} <name>`,
	].join('\n')}\n`;
}

/**
 * A string a declaration's member holds (`ConditionalCheckFailedException`, the error name of
 * `DistributedTableErrors.ConditionalCheckFailed` and others): the members that hold it, and the first one's
 * declaration. Undefined when no report declaration holds it.
 */
function valueCard(index: DocsIndex, input: string): string | undefined {
	const name = input.trim();
	if (!/^[\w$.-]+$/.test(name)) return undefined;
	const holds = new RegExp(`^\\s+(?:readonly\\s+)?([\\w$]+)\\??:\\s*["']${escapeRegExp(name)}["']`);
	const holders = [...new Set([...index.declarations.values()].flat())]
		.filter((d) => !d.file)
		.flatMap((d) => d.lines.flatMap((line) => holds.exec(line)?.[1] ?? []).map((member) => ({ decl: d, member })));
	if (!holders.length) return undefined;
	const first = holders[0].decl;
	const block = index.blocks.find((b) => b.name === first.block) as DocsBlock;
	const names = holders.slice(0, NAMES_LISTED).map((h) => `${h.decl.name}.${h.member} (${packageOf(h.decl.block)})`);
	return `${[`${name}: the value of ${names.join(', ')}`, '', `# ${block.prefix}API.md (${join(block.dir, 'API.md')})`, ...first.lines].join('\n')}\n`;
}

/**
 * The blocks `--search` reads for a name: the block it names, else the blocks that declare the export or option
 * (`--search isBlocksError isBlocksError` reads core).
 */
function searchScope(index: DocsIndex, name: string): DocsBlock[] {
	const block = findBlock(index, name);
	if (block) return [block];
	const decls = findDeclarations(index, name);
	if (!decls) throw unknownName(index, name);
	const owners = new Set(decls.found.map((d) => d.block));
	return index.blocks.filter((b) => owners.has(b.name));
}

/**
 * Declarations named `name` (exact case first), else the declaration a public name of @aws-blocks/blocks is
 * (`DTPutOptions`), else the declarations that have a member `name`; `Owner.member` (`FileBucket.put`) is that
 * member of that declaration only, else of the nearest base it inherits the member from (`Auth.protect` is
 * AuthBase's protect), with a note that says so. `name` in the result is the name looked up (export, public or
 * member name). When the owner is an alias that leaves the member out (`Secret.put`), the block's report
 * declarations that have it (WritableSecret), with a note that says so.
 */
function findDeclarations(
	index: DocsIndex,
	input: string,
): { found: Declaration[]; member: boolean; name: string; note?: string } | undefined {
	const name = input.trim();
	const lower = name.toLowerCase();
	const dot = name.lastIndexOf('.');
	if (dot > 0) {
		const owner = lower.slice(0, dot);
		const member = name.slice(dot + 1);
		// The owner, or what a report declaration of that name stands for unless it omits the member (`Secret.get`
		// is SecretImpl's get; `Secret.put` is not, since Secret is `Omit<SecretImpl<T>, 'put'>`).
		const stands = (index.aliases.get(owner) ?? []).filter((a) => !a.omit.includes(member));
		const owners = new Set([owner, ...stands.map((a) => a.name.toLowerCase())]);
		const of = (decls: Declaration[] | undefined) => (decls ?? []).filter((d) => owners.has(d.name.toLowerCase()));
		const exact = of(index.members.get(member));
		if (exact.length) return { found: exact, member: true, name: member };
		for (const [key, decls] of index.members) {
			if (key.toLowerCase() === member.toLowerCase() && of(decls).length)
				return { found: of(decls), member: true, name: key };
		}
		const inherited = inheritedMember(
			index,
			[...index.declarations].filter(([key]) => owners.has(key.toLowerCase())).flatMap(([, decls]) => decls),
			member,
		);
		if (inherited) return { ...inherited, member: true };
		const omitting = (index.aliases.get(owner) ?? []).filter((a) => a.omit.includes(member));
		const alias = omitting.length
			? [...index.declarations]
					.filter(([key]) => key.toLowerCase() === owner)
					.flatMap(([, decls]) => decls)
					.find((d) => !d.file && omitting.some((a) => d.lines[0].includes(a.name)))
			: undefined;
		if (alias) {
			const found = (index.members.get(member) ?? []).filter((d) => d.block === alias.block && !d.file);
			const note = `${alias.name} leaves out ${member}: ${alias.lines[0].trim()}`;
			if (found.length) return { found, member: true, name: member, note };
		}
	}
	// A declaration of the umbrella's own hides the same name from a package it re-exports whole, as in TypeScript.
	const visible = (decls: Declaration[]) =>
		decls.some((d) => d.block === UMBRELLA)
			? decls.filter((d) => d.block === UMBRELLA || !index.wildcardBlocks.has(d.block))
			: decls;
	const exact = index.declarations.get(name);
	if (exact?.length) return { found: visible(exact), member: false, name };
	for (const [key, decls] of index.declarations)
		if (key.toLowerCase() === lower) return { found: visible(decls), member: false, name: key };
	const alias = exportName(index.umbrellaExports.keys(), name);
	const ref = alias === undefined ? undefined : index.umbrellaExports.get(alias);
	if (alias !== undefined && ref) {
		const found = (index.declarations.get(ref.name) ?? []).filter((d) => d.block === ref.block);
		if (found.length) return { found, member: false, name: alias };
	}
	const member = index.members.get(name);
	if (member?.length) return { found: member, member: true, name };
	for (const [key, decls] of index.members)
		if (key.toLowerCase() === lower) return { found: decls, member: true, name: key };
	return undefined;
}

/** A declaration a member lookup reaches through bases: the chain from the owner to it, and what an `Omit` left out. */
interface Ancestor {
	decl: Declaration;
	chain: Declaration[];
	omit: Set<string>;
}

/**
 * What a class or interface head extends, each base without its generic arguments: AuthBase for
 * `export class Auth<const O extends AuthOptions = AuthOptions> extends AuthBase<O> {`, every base of an interface
 * that extends several, and AuthUser without displayName for `extends Omit<AuthUser, 'displayName'>`. The type
 * parameters' own `extends` is not a base, and `implements` adds no members.
 */
function basesOf(decl: Declaration): { name: string; omit: string[] }[] {
	if (decl.kind !== 'class' && decl.kind !== 'interface') return [];
	const head = decl.lines[0] ?? '';
	const named = /^\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface)\s+[\w$]+/.exec(head);
	if (!named) return [];
	// The head's text at bracket depth 0 after the name and its type parameters, split at its commas.
	const parts: string[] = [''];
	let depth = 0;
	let start = named[0].length;
	if (head[start] === '<') {
		for (let i = start; i < head.length; i++) {
			if (head[i] === '<') depth++;
			else if (head[i] === '>' && head[i - 1] !== '=') depth--;
			if (depth === 0) {
				start = i + 1;
				break;
			}
		}
	}
	for (let i = start; i < head.length; i++) {
		const ch = head[i];
		if (depth === 0 && (ch === '{' || /^\s+implements\b/.test(head.slice(i)))) break;
		if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++;
		else if ((ch === '>' && head[i - 1] !== '=') || ch === ')' || ch === ']' || ch === '}') depth--;
		if (depth === 0 && ch === ',') parts.push('');
		else parts[parts.length - 1] += ch;
	}
	const bases = /^\s*extends\s+([\s\S]*)$/.exec(parts[0]);
	if (!bases) return [];
	return [bases[1], ...parts.slice(1)].flatMap((part) => {
		const omit = /^\s*Omit<\s*([\w$]+)\b(?:<.*?>)?\s*,(.*)>\s*$/.exec(part);
		if (omit) return [{ name: omit[1], omit: [...omit[2].matchAll(/['"]([\w$]+)['"]/g)].map((m) => m[1]) }];
		const name = /^\s*([\w$]+)\s*(?:<.*>)?\s*$/.exec(part)?.[1];
		return name ? [{ name, omit: [] }] : [];
	});
}

/**
 * The declarations `decls` inherit from, one list per level, nearest first. A base resolves to its declarations in
 * the same block, else to those of the one block that declares that name. Each declaration once, so a cycle ends.
 */
function ancestorsOf(index: DocsIndex, decls: Declaration[]): Ancestor[][] {
	const seen = new Set(decls);
	const levels: Ancestor[][] = [];
	let level: Ancestor[] = decls.map((decl) => ({ decl, chain: [decl], omit: new Set<string>() }));
	while (level.length) {
		const next: Ancestor[] = [];
		for (const child of level) {
			for (const base of basesOf(child.decl)) {
				const named = index.declarations.get(base.name) ?? [];
				const local = named.filter((d) => d.block === child.decl.block);
				const elsewhere = new Set(named.map((d) => d.block)).size === 1 ? named : [];
				for (const decl of local.length ? local : elsewhere) {
					if (seen.has(decl)) continue;
					seen.add(decl);
					next.push({ decl, chain: [...child.chain, decl], omit: new Set([...child.omit, ...base.omit]) });
				}
			}
		}
		if (next.length) levels.push(next);
		level = next;
	}
	return levels;
}

/**
 * `member` of the nearest base of `owners` that has it (exact case first), with a note naming the base and the
 * heads that extend it: `Auth inherits protect from AuthBase: export class Auth<…> extends AuthBase<O>`.
 */
function inheritedMember(
	index: DocsIndex,
	owners: Declaration[],
	member: string,
): { found: Declaration[]; name: string; note: string } | undefined {
	const levels = ancestorsOf(index, owners);
	const matches = [(m: string) => m === member, (m: string) => m.toLowerCase() === member.toLowerCase()];
	for (const match of matches) {
		for (const level of levels) {
			const hits = level.flatMap((a) =>
				a.decl.members.filter((m) => match(m) && !a.omit.has(m)).map((m) => ({ a, m })),
			);
			if (!hits.length) continue;
			const { a, m } = hits[0];
			const heads = a.chain.slice(0, -1).map((d) => d.lines[0].trim().replace(/\s*\{$/, ''));
			return {
				found: [...new Set(hits.filter((h) => h.m === m).map((h) => h.a.decl))],
				name: m,
				note: `${a.chain[0].name} inherits ${m} from ${a.decl.name}: ${heads.join('; ')}`,
			};
		}
	}
	return undefined;
}

function unknownName(index: DocsIndex, name: string): UsageError {
	// `Owner.member` with a known owner: its members, then those it inherits from each base.
	const dot = name.lastIndexOf('.');
	const owner = dot > 0 ? findDeclarations(index, name.slice(0, dot)) : undefined;
	if (owner && !owner.member) {
		const member = name.slice(dot + 1).trim();
		const own = [...new Set(owner.found.flatMap((d) => d.members))].filter((m) => m !== 'constructor');
		const members = new Set(own);
		const groups = own.length ? [own.join(', ')] : [];
		for (const a of ancestorsOf(index, owner.found).flat()) {
			const added = a.decl.members.filter((m) => m !== 'constructor' && !a.omit.has(m) && !members.has(m));
			if (!added.length) continue;
			for (const m of added) members.add(m);
			groups.push(`from ${a.decl.name}: ${added.join(', ')}`);
		}
		const close = suggest(member, [...members]);
		return new UsageError(
			[
				`${owner.name} has no member "${member}" in its API report.${close ? ` Did you mean "${owner.name}.${close}"?` : ''}`,
				...(groups.length ? [`Its members: ${groups.join('; ')}`] : []),
			].join('\n'),
			{ hint: `${CLI} ${owner.name}` },
		);
	}
	const candidates = [
		...index.blocks.map((b) => b.name),
		...index.blocks.flatMap((b) => b.classes),
		...index.declarations.keys(),
	];
	const near = suggest(name, candidates);
	// The lines that mention the name are the next lead: print them instead of sending the reader to search.
	const { hits } = searchHits(index, name.trim().toLowerCase(), [], UNKNOWN_NAME_HITS);
	// So are the names that have every word of it: AuthErrors → AuthBasicErrors, AuthCognitoErrors, ….
	const parts = name.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g)?.map((p) => p.toLowerCase()) ?? [];
	const importable = [
		...index.umbrellaExports.keys(),
		...[...(index.entries?.subpaths.values() ?? [])].flatMap((names) => [...names.keys()]),
	];
	const containing =
		parts.length > 1
			? [...new Set(importable)]
					.filter((n) => parts.every((p) => n.toLowerCase().includes(p)))
					.slice(0, NAMES_LISTED)
			: [];
	return new UsageError(
		[
			`no block, export or option named "${name}".${near ? ` Did you mean "${near}"?` : ''}`,
			...(containing.length ? [`Exports with every word of it: ${containing.join(', ')}`] : []),
			...(hits.length ? ['The docs mention it here:', ...hits] : []),
		].join('\n'),
		{ hint: `${CLI} --search ${JSON.stringify(name)}, or ${CLI} for the list of blocks` },
	);
}

// ── Output ───────────────────────────────────────────────────────────────────

/** `name` among `names`, exact case first: the spelling the package exports it under. */
function exportName(names: Iterable<string>, name: string): string | undefined {
	const all = [...names];
	return all.find((n) => n === name) ?? all.find((n) => n.toLowerCase() === name.toLowerCase());
}

/** A name at runtime: a type (erased, so `import type` of it works anywhere), a value, or not known (no declaration). */
type NameKind = 'type' | 'value' | 'unknown';

/** Declaration kinds that are types only. */
const TYPE_KINDS = new Set(['type', 'interface']);

/** The subpath entries that export `name`, each with whether the name is a type there. */
function subpathsOf(index: DocsIndex, name: string): [string, boolean][] {
	return [...(index.entries?.subpaths ?? [])].flatMap(([entry, names]) => {
		const type = names.get(name);
		return type === undefined ? [] : [[entry, type] as [string, boolean]];
	});
}

/**
 * How code imports `publicName`. From @aws-blocks/blocks when it exports the name (`backend`): a type with
 * `import type`, which browser code and tests can use too (the import is erased, and TypeScript reads the types
 * entry); a value in backend code, with the @aws-blocks/blocks/client import for browser code and tests when that
 * entry has it, since their browser condition gets no value from @aws-blocks/blocks. Otherwise from each subpath
 * entry that exports it.
 */
function importLine(index: DocsIndex, publicName: string, backend: boolean, kind: NameKind): string {
	const from = (entry: string, type: boolean) => `import ${type ? 'type ' : ''}{ ${publicName} } from '${entry}';`;
	const subs = subpathsOf(index, publicName);
	if (backend) {
		if (kind === 'type') return `${from(BLOCKS, true)} (a type: the same import works in browser code and tests)`;
		if (!index.entries || index.entries.browserMain.has(publicName)) return from(BLOCKS, false);
		const client = subs.find(([entry]) => entry === CLIENT);
		if (client) return `Backend: ${from(BLOCKS, false)} Browser code and tests: ${from(CLIENT, client[1])}`;
		const missing = `${CLIENT}, which browser code and tests import values from, does not export it`;
		return `${from(BLOCKS, false)} (${kind === 'value' ? `backend only: ${missing}` : missing})`;
	}
	const lines = subs.map(([entry, type]) =>
		entry === CLIENT ? `Browser code and tests: ${from(entry, type)}` : from(entry, type),
	);
	return `${lines.join(' Or: ')} (${BLOCKS} itself does not export it)`;
}

/**
 * The spelling `input` has among the names @aws-blocks/blocks (`backend`) or a subpath entry exports, with its
 * declaration from the installed type file of the first entry that has one, and that entry.
 */
function entryName(
	index: DocsIndex,
	input: string,
): { publicName: string; backend: boolean; entry?: string; declaration?: TypesDeclaration } | undefined {
	const subNames = [...(index.entries?.subpaths.values() ?? [])].flatMap((names) => [...names.keys()]);
	const backend = exportName(index.umbrellaExports.keys(), input);
	const publicName = backend ?? exportName(subNames, input);
	if (publicName === undefined) return undefined;
	const entries = [...(backend === undefined ? [] : [BLOCKS]), ...subpathsOf(index, publicName).map(([e]) => e)];
	for (const entry of entries) {
		const file = index.entries?.files.get(entry);
		const declaration = file ? typesDeclaration(file, publicName) : undefined;
		if (declaration) return { publicName, backend: backend !== undefined, entry, declaration };
	}
	return { publicName, backend: backend !== undefined };
}

/**
 * A name no API report in the docs declares: one that @aws-blocks/blocks or a subpath entry exports (hosting's
 * `config`, `onAuthChange` of /ui), or one that the API reports import from another package (`StandardSchemaV1`).
 * Its import, its declaration and doc comment from the installed type file when one has it, then the doc lines
 * that mention it.
 */
function importCard(index: DocsIndex, input: string): string | undefined {
	const name = input.trim();
	const named = entryName(index, name);
	let first: string;
	let declaration: { file: string; kind: string; lines: string[] } | undefined;
	if (named) {
		const { publicName, backend } = named;
		declaration = named.declaration;
		const ref = backend ? index.umbrellaExports.get(publicName) : undefined;
		const source = declaration ? typeFile(declaration.file) : undefined;
		const of = ref ? ` of ${packageOf(ref.block)}` : '';
		const what = source
			? `${declaration?.kind} in ${source.pkg}.`
			: `export${of}, with no declaration in the docs.`;
		const kind: NameKind = !declaration ? 'unknown' : TYPE_KINDS.has(declaration.kind) ? 'type' : 'value';
		first = `${publicName}: ${what} ${importLine(index, publicName, backend, kind)}`;
	} else {
		const external = exportName(index.externals.keys(), name);
		const x = external === undefined ? undefined : index.externals.get(external);
		if (external !== undefined && x) {
			const reports = x.blocks.map((b) => (b === UMBRELLA ? BLOCKS : b)).join(', ');
			first = `${external}: from ${x.from}, not an AWS Blocks package. The API reports of ${reports} import it: import ${x.type ? 'type ' : ''}{ ${external} } from '${x.from}';`;
		} else {
			// A package the reports import from (zod): what they import from it.
			const from = [...index.externals].filter(([, e]) => e.from.toLowerCase() === name.toLowerCase());
			if (!from.length) return undefined;
			const names = from.map(
				([n, e]) => `${n} (${e.blocks.map((b) => (b === UMBRELLA ? BLOCKS : b)).join(', ')})`,
			);
			first = `${from[0][1].from}: a package outside AWS Blocks. The API reports import from it: ${names.join('; ')}`;
		}
	}
	const lines = [first];
	if (declaration) {
		lines.push('', `# ${typeFile(declaration.file).path} (${declaration.file})`, ...declaration.lines);
	}
	const { hits } = searchHits(index, name.toLowerCase(), [], UNKNOWN_NAME_HITS);
	if (hits.length) lines.push(...(declaration ? [''] : []), 'The docs mention it here:', ...hits);
	return `${lines.join('\n')}\n`;
}

/** A type file's package (the nearest package.json's name) and its path in that package: `@aws-blocks/auth-common/dist/ui.d.ts`. */
function typeFile(file: string): { pkg: string; path: string } {
	for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
		const pkgFile = join(dir, 'package.json');
		if (!existsSync(pkgFile)) continue;
		const pkg = String(JSON.parse(readFileSync(pkgFile, 'utf-8')).name ?? basename(dir));
		return { pkg, path: `${pkg}/${relative(dir, file).split(sep).join('/')}` };
	}
	return { pkg: basename(dirname(file)), path: file };
}

/**
 * Every name `import { … } from '@aws-blocks/blocks'` can take ({@link DocsIndex.umbrellaExports}), with the
 * declaration an alias stands for, and the names of its subpath entries (`/client`, which browser code and tests
 * import values from, `/ui`, `/utils`, …). Without filters, one line per package and per entry; with filters
 * (case-insensitive substrings), one line per name. A filter that names an entry (`utils`, `/client`) lists that
 * entry's names instead.
 */
function exportsList(index: DocsIndex, filters: string[]): string {
	const entryLists = filters.map((f) => entryListing(index, f));
	if (entryLists.some(Boolean)) {
		const rest = filters.filter((_, i) => !entryLists[i]);
		return `${entryLists.filter(Boolean).join('')}${rest.length ? exportsList(index, rest) : ''}`;
	}
	const entries = new Map<string, { kind: string; block?: string; original?: string; subpaths: string[] }>();
	const subpaths = (name: string) => subpathsOf(index, name).map(([entry]) => entry);
	for (const [name, ref] of index.umbrellaExports) {
		const kind = index.declarations.get(ref.name)?.find((d) => d.block === ref.block)?.kind ?? 'export';
		entries.set(name, {
			kind,
			block: ref.block,
			subpaths: subpaths(name),
			...(ref.name === name ? {} : { original: ref.name }),
		});
	}
	for (const names of index.entries?.subpaths.values() ?? []) {
		for (const name of names.keys()) {
			if (!entries.has(name)) entries.set(name, { kind: 'export', subpaths: subpaths(name) });
		}
	}
	const wanted = filters.map((f) => f.toLowerCase());
	const quoted = filters.map((f) => JSON.stringify(f)).join(' or ');
	const byName = ([a]: [string, unknown], [b]: [string, unknown]) =>
		a.localeCompare(b, 'en', { sensitivity: 'base' });
	const shown = [...entries]
		.filter(([name]) => !wanted.length || wanted.some((f) => name.toLowerCase().includes(f)))
		.sort(byName);
	if (!shown.length) {
		// No export has it, but a member or another package's name can: ConditionalCheckFailed is a member of
		// DistributedTableErrors and the others, StandardSchemaV1 comes from @standard-schema/spec.
		const has = (n: string) => wanted.some((f) => n.toLowerCase().includes(f));
		const members = [...index.members]
			.filter(([m]) => has(m))
			.slice(0, NAMES_LISTED)
			.map(([m, ds]) => `${m} (of ${[...new Set(ds.map((d) => d.name))].slice(0, CARD_OWNERS).join(', ')})`);
		const external = [...index.externals]
			.filter(([n, x]) => has(n) || has(x.from))
			.map(([n, x]) => `${n} (from ${x.from})`);
		// Declared by a block that @aws-blocks/blocks does not re-export it from: RealtimeErrors of bb-realtime.
		const unexported = [...index.declarations]
			.filter(([n]) => has(n))
			.flatMap(([n, ds]) =>
				ds
					.filter((d) => !d.file && d.block !== UMBRELLA)
					.map((d) => `${n} (import from ${packageOf(d.block)})`),
			)
			.slice(0, NAMES_LISTED);
		if (!members.length && !external.length && !unexported.length) {
			throw new CliError(`@aws-blocks/blocks exports no name containing ${quoted}.`, {
				hint: `${CLI} --exports, or ${CLI} --search ${JSON.stringify(filters[0])}`,
			});
		}
		return `${[
			`@aws-blocks/blocks exports no name containing ${quoted}.`,
			...(unexported.length ? [`Declared by a block it does not re-export: ${unexported.join('; ')}`] : []),
			...(members.length ? [`Members that contain it: ${members.join('; ')}`] : []),
			...(external.length ? [`Names from other packages: ${external.join('; ')}`] : []),
			`A name's declaration and docs: ${CLI} <name>`,
		].join('\n')}\n`;
	}
	const backend = shown.filter(([, e]) => e.block !== undefined);
	const head = `Names you can import from @aws-blocks/blocks in backend code${wanted.length ? ` containing ${quoted}` : ''} (${backend.length}): import { <name> } from '@aws-blocks/blocks';`;
	let browser: string | undefined;
	if (index.entries) {
		const values = [...index.entries.browserMain].filter(([, type]) => !type).map(([name]) => name);
		browser = `Browser code and tests (npm run test:e2e runs tsx -C browser) get ${values.length ? `only ${values.join(', ')}` : 'no value'} from ${BLOCKS} (import type of its types works); they import values from ${CLIENT}.`;
	}
	const foot = `Its declaration and docs: ${CLI} <name>`;
	if (wanted.length) {
		const width = Math.max(...shown.map(([name]) => name.length));
		const rows = shown.map(([name, e]) => {
			const where = e.block
				? `${e.kind} in ${packageOf(e.block)}${e.original ? ` (${e.original} there)` : ''}${e.subpaths.length ? `; also from ${e.subpaths.join(', ')}` : ''}`
				: `only from ${e.subpaths.join(' or ')}`;
			return `  ${name.padEnd(width)}  ${where}`;
		});
		return `${[head, ...(browser ? [`${browser} Other entries as marked.`] : []), ...rows, foot].join('\n')}\n`;
	}
	const byPackage = new Map<string, string[]>();
	for (const [name, e] of backend) {
		const pkg = packageOf(e.block as string);
		const list = byPackage.get(pkg) ?? [];
		list.push(e.original ? `${name} (${e.original})` : name);
		byPackage.set(pkg, list);
	}
	const groups = [...byPackage]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([pkg, names]) => `  ${pkg}: ${names.join(', ')}`);
	const others = [...(index.entries?.subpaths ?? [])]
		.filter(([, names]) => names.size)
		.map(
			([entry, names]) =>
				`  ${entry} (${names.size}): ${[...names]
					.sort(byName)
					.map(([name]) => name)
					.join(', ')}`,
		);
	const tail = others.length ? ["The other entries' names: import { <name> } from '<entry>';", ...others] : [];
	return `${[head, ...groups, ...(browser ? [browser] : []), ...tail, foot].join('\n')}\n`;
}

function listing(index: DocsIndex, version: string): string {
	const blocks = index.blocks.filter((b) => b.prefix);
	const roots = index.blocks.filter((b) => !b.prefix);
	const width = Math.max(...index.blocks.map((b) => b.name.length));
	const rows = blocks.map((b) => {
		const classes = b.classes.slice(0, LISTED_CLASSES).join(', ');
		const more = b.files.filter((f) => f === 'API.md' || f === 'DESIGN.md');
		const what = [classes && `${classes}:`, b.purpose, more.length ? `[${more.join(', ')}]` : '']
			.filter(Boolean)
			.join(' ');
		return `  ${b.name.padEnd(width)}  ${what}`;
	});
	// A root doc is a name for a file, not a folder: `guide` is the package README.
	const files = roots.map((b) => `  ${b.name.padEnd(width)}  ${b.main} of @aws-blocks/blocks: ${b.purpose}`);
	return [
		`AWS Blocks docs for @aws-blocks/blocks ${version} (folder: ${index.dir})`,
		'',
		`Usage: ${CLI} [name...] [options]`,
		'',
		...docsForms(CLI),
		'',
		...DOCS_OPTIONS,
		'',
		'ApiNamespace, ApiError and the typed client are in core.',
		`A block's other files: --api prints its API.md, a doc path the others (${CLI} bb-cron-job/DESIGN.md).`,
		'',
		'Blocks (class: what it does [other files]):',
		...rows,
		'',
		'Framework docs (each name is one file of the docs folder, not a folder):',
		...files,
		'',
	].join('\n');
}

function card(index: DocsIndex, name: string, decls: Declaration[], member: boolean): string {
	const out: string[] = [];
	// The blocks a class of which names the block (DistributedTable.put) come first, then the rest; at most
	// CARD_OWNERS print in full and the others are named, each with the lookup that prints it.
	const named = (block: string) => index.blocks.find((b) => b.name === block)?.named ?? [];
	const owners = [...new Set(decls.map((d) => d.block))].sort(
		(a, b) =>
			Number(!decls.some((d) => d.block === a && named(a).includes(d.name))) -
			Number(!decls.some((d) => d.block === b && named(b).includes(d.name))),
	);
	const declNames = [...new Set(decls.map((d) => d.name))];
	if (member) {
		const shown = declNames.map((n) => {
			const decl = decls.find((d) => d.name === n);
			const phrases = [
				...(decl?.standsFor ?? []),
				...(decl?.returnedBy ?? []).map((c) => `what new ${c}(…) returns`),
			];
			return phrases.length ? `${n} (${phrases.join(', ')})` : n;
		});
		out.push(`${name}: member of ${shown.join(', ')} (${owners.map(packageOf).join(', ')})`);
	} else {
		// One line per declaration shown (once for overloads), with the name @aws-blocks/blocks exports it under
		// (DTPutOptions for bb-distributed-table's PutOptions), or its own package when the umbrella does not.
		const lines = new Set<string>();
		for (const decl of decls.filter((d) => owners.slice(0, CARD_OWNERS).includes(d.block))) {
			const refs = [...index.umbrellaExports].filter(([, v]) => v.block === decl.block && v.name === decl.name);
			const publicName = (refs.find(([key]) => key === decl.name) ?? refs[0])?.[0];
			const what = decl.name === name ? decl.kind : `${decl.kind} ${decl.name}`;
			const where = packageOf(decl.block);
			lines.add(
				decl.file
					? `${name}: ${what} in ${where}, not exported${decl.standsFor?.length ? `: it is ${decl.standsFor.join(', ')}` : ''}.`
					: publicName
						? `${name}: ${what} in ${where}. ${importLine(index, publicName, true, TYPE_KINDS.has(decl.kind) ? 'type' : 'value')}`
						: `${name}: ${what} in ${where}. import ${TYPE_KINDS.has(decl.kind) ? 'type ' : ''}{ ${decl.name} } from '${where}'; (not re-exported by @aws-blocks/blocks)`,
			);
		}
		out.push(...lines);
	}
	const rest = owners.slice(CARD_OWNERS);
	if (rest.length) {
		const lookups = rest.flatMap((o) =>
			decls.filter((d) => d.block === o).map((d) => (member ? `${CLI} ${d.name}.${name}` : `${CLI} ${o} --api`)),
		);
		out.push(`Also in ${rest.join(', ')}: ${[...new Set(lookups)].join('; ')}`);
	}
	for (const owner of owners.slice(0, CARD_OWNERS)) {
		const block = index.blocks.find((b) => b.name === owner) as DocsBlock;
		const own = decls.filter((d) => d.block === owner);
		const reported = own.filter((d) => !d.file);
		// A member comes from the block's installed type file when it has the member: there it has its doc comment.
		const typed = new Map(reported.map((d) => [d, member ? typedMember(index, d, name) : undefined]));
		const fromReport = reported.filter((d) => !typed.get(d));
		if (fromReport.length) out.push('', `# ${block.prefix}API.md (${join(block.dir, 'API.md')})`);
		for (const decl of fromReport) out.push(...(member ? memberLines(decl, name) : decl.lines));
		for (const t of typed.values()) if (t) out.push('', `# ${typeFile(t.file).path} (${t.file})`, ...t.lines);
		// Declarations the report only names, and those a report declaration shown here stands for.
		const standIns = member
			? []
			: reported.flatMap((d) =>
					(index.aliases.get(d.name.toLowerCase()) ?? []).flatMap(
						(a) => index.declarations.get(a.name)?.filter((x) => x.block === owner && x.file) ?? [],
					),
				);
		for (const decl of [...own.filter((d) => d.file), ...standIns]) {
			const file = decl.file as string;
			const whole = [...(decl.doc ?? []), ...decl.lines];
			const shown = member
				? memberLines(decl, name)
				: whole.length > WHOLE_DECLARATION_LINES
					? withoutDocComments(decl.lines)
					: whole;
			out.push('', `# ${typeFile(file).path} (${file}): ${decl.name}, not exported by its package`, ...shown);
		}
		if (block.files.includes('README.md')) {
			const path = join(block.dir, 'README.md');
			const text = readFileSync(path, 'utf-8');
			const words = member ? [name] : [...new Set([decls[0].name, name])];
			const section = sectionMentioning(text, words);
			if (section) {
				out.push('', `# ${block.prefix}README.md (${path})`, ...excerpt(block, text, section));
			} else {
				out.push('', `${block.prefix}README.md does not mention ${name}; try ${CLI} --search ${name}`);
			}
		}
	}
	return `${out.join('\n')}\n`;
}

/**
 * The lines a member card prints for `member` of a report declaration from its block's installed type file: the
 * member with the doc comment above it. Undefined when the file has no such declaration, or no doc comment on that
 * member, where the report's lines say the same with the public parameter names (the mock types have `_options`).
 */
function typedMember(
	index: DocsIndex,
	decl: Declaration,
	member: string,
): { file: string; lines: string[] } | undefined {
	const file = blockTypesFile(createRequire(join(index.dir, '..', 'package.json')), decl.block);
	const found = file ? typesDeclaration(file, decl.name) : undefined;
	if (!found) return undefined;
	const body = found.lines.slice(found.doc);
	const lines = memberLines({ ...decl, lines: body, members: membersOf(body) }, member);
	const names = new RegExp(
		`^\\s+(?:(?:readonly|static|protected|abstract|get|set|async)\\s+)*${escapeRegExp(member)}\\b`,
	);
	const at = lines.findIndex((l) => names.test(l));
	return at > 0 && lines[at - 1].trim().endsWith('*/') ? { file: found.file, lines } : undefined;
}

/** A declaration this long prints only the members that name the looked-up option. */
const WHOLE_DECLARATION_LINES = 25;

/**
 * The declaration, or for a long one its first and last line around the top-level members that name `member`:
 * the member itself (each overload) or a member with a nested field of that name (`global` in
 * `signOut(context, options?: { global?: boolean }): Promise<void>`), each from its first line through the line
 * that closes it.
 */
function memberLines(decl: Declaration, member: string): string[] {
	if (decl.lines.length <= WHOLE_DECLARATION_LINES) return decl.lines;
	const names = new RegExp(
		`^\\s+(?:(?:readonly|static|protected|abstract|get|set|async)\\s+)*${escapeRegExp(member)}\\b`,
	);
	const spans: string[] = [];
	let span: string[] = [];
	// A type file's members carry doc comments: the one above a member goes with it, and comments count no brackets.
	let comment: string[] = [];
	let depth = 0;
	for (const line of decl.lines.slice(1, -1)) {
		const open = comment.length > 0 && !comment[comment.length - 1].includes('*/');
		if (depth === 0 && span.length === 0 && (open || line.trim().startsWith('/**'))) {
			comment.push(line);
			continue;
		}
		span.push(line);
		if (COMMENT_LINE.test(line)) continue;
		for (const ch of line) {
			if (ch === '{' || ch === '(' || ch === '[') depth++;
			else if (ch === '}' || ch === ')' || ch === ']') depth--;
		}
		if (depth > 0) continue;
		if (span.some((l) => names.test(l))) spans.push(...comment, ...span);
		span = [];
		comment = [];
		depth = 0;
	}
	return [decl.lines[0], '    // ...', ...spans, '    // ...', decl.lines[decl.lines.length - 1]];
}

/** A line of a comment: `/**`, ` * text`, ` *\/` or `// text`, whose brackets are prose. */
const COMMENT_LINE = /^\s*(?:\/\*\*?|\*|\/\/)/;

/** The lines without their `/** … *\/` doc comments. */
function withoutDocComments(lines: string[]): string[] {
	const out: string[] = [];
	let open = false;
	for (const line of lines) {
		const t = line.trim();
		if (open || t.startsWith('/**')) open = !t.includes('*/');
		else out.push(line);
	}
	return out;
}

function excerpt(block: DocsBlock, text: string, section: Section): string[] {
	const lines = text.split('\n').slice(section.start - 1, section.end);
	const shown = lines.slice(0, CARD_SECTION_LINES);
	const out = [`(lines ${section.start}-${section.end})`, ...shown];
	if (lines.length > shown.length) {
		out.push(`... ${lines.length - shown.length} more lines: ${CLI} ${block.name} --section ${section.slug}`);
	}
	return out;
}

function toc(block: DocsBlock, file: string, text: string): string {
	const sections = parseSections(text);
	const lines = [
		`${block.prefix}${file}: ${text.split('\n').length} lines; ${CLI} ${docArgs(block, file)} --section <topic>`,
	];
	for (const s of sections)
		lines.push(`${'  '.repeat(Math.max(0, s.level - 1))}${s.title}  [${s.slug}]  lines ${s.start}-${s.end}`);
	return lines.join('\n');
}

/** The arguments that print a block's file: `core`, `core --api`, or the doc path `bb-cron-job/DESIGN.md`. */
function docArgs(block: DocsBlock, file: string): string {
	if (file === 'API.md') return `${block.name} --api`;
	return file === block.main || !block.prefix ? block.name : `${block.prefix}${file}`;
}

/**
 * The section a heading names as written: its slug or title, a slug it starts, or a title with a word it starts.
 * `exact` keeps the doc's own title (level 1) at every tier (`production`: "DistributedTable: production settings")
 * but a subsection only by its slug or title, or a slug that a topic of several words starts (`Depth 3`: "Depth 3:
 * Fully custom UI"); one word that starts a subsection (`password`: "Password reset ends every session") is not it.
 */
function namedSection(text: string, wanted: string, exact = false): Section | undefined {
	const sections = parseSections(text);
	const key = wanted.trim().toLowerCase();
	const slug = slugify(key);
	const wordStart = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(key)}`, 'iu');
	return (
		sections.find((s) => s.slug === slug || s.title.toLowerCase() === key) ??
		sections.find((s) => (!exact || s.level === 1 || slug.includes('-')) && s.slug.startsWith(slug)) ??
		sections.find((s) => (!exact || s.level === 1) && wordStart.test(s.title))
	);
}

function sectionText(block: DocsBlock, file: string, text: string, wanted: string): string {
	const sections = parseSections(text);
	const key = wanted.trim().toLowerCase();
	const lines = text.split('\n');
	const print = (s: Section, end: number, label?: string) =>
		[`(lines ${s.start}-${end}${label ? `; ${label}` : ''})`, ...lines.slice(s.start - 1, end)].join('\n');
	const named = namedSection(text, wanted);
	if (named) return print(named, named.end);
	// Not named as written. Every word that carries meaning has to match, so "read caching" never lands on
	// "Read-only by default": first a heading with every word by stem (`querying` → Query), then the section whose
	// own lines mention every word, most mentions first. Both say they are not the heading asked for.
	const words = meaningfulWords(key);
	if (words.length) {
		// Two words share a stem when either starts with the other's (`querying` and `query`, `writes` and `write`).
		const byHeading = sections.find((s) => {
			const title = meaningfulWords(s.title);
			return words.every((w) => title.some((t) => t.startsWith(stem(w)) || w.startsWith(stem(t))));
		});
		if (byHeading) return print(byHeading, byHeading.end, `closest heading to "${wanted}"`);
		const own = (s: Section) => {
			const child = sections.find((c) => c.start > s.start && c.start <= s.end);
			return child ? child.start - 1 : s.end;
		};
		let best: { s: Section; end: number; mentions: number } | undefined;
		// A level-1 heading spans the whole doc, so its own lines (the intro) are never the answer.
		for (const s of sections.filter((c) => c.level > 1)) {
			const end = own(s);
			const body = lines.slice(s.start - 1, end).join('\n');
			const counts = words.map(
				(w) => (body.match(new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(stem(w))}`, 'giu')) ?? []).length,
			);
			const mentions = counts.reduce((a, b) => a + b, 0);
			if (counts.every((n) => n > 0) && (!best || mentions > best.mentions)) best = { s, end, mentions };
		}
		if (best) return print(best.s, best.end, `no heading names "${wanted}"; these lines mention every word of it`);
	}
	// "Quick start", "getting started", "usage": the first section with an example, its own lines.
	if (/\bquick|get(ting)?\s*-?\s*started|usage|examples?|overview|basics|tutorial|intro/i.test(wanted)) {
		const own = (s: Section) => {
			const child = sections.find((c) => c.start > s.start && c.start <= s.end);
			return child ? child.start - 1 : s.end;
		};
		const first = sections
			.filter((s) => s.level > 1)
			.find((s) => lines.slice(s.start - 1, own(s)).some((l) => l.trim().startsWith('```')));
		if (first) return print(first, own(first), `no "${wanted}" heading; the first section with an example`);
	}
	// The headings are the answer to a wrong guess: list them, so the next call can name one.
	const near = suggest(
		wanted,
		sections.map((s) => s.slug),
	);
	const listed = sections.filter((s) => s.level > 1 && s.level <= 3).map((s) => s.slug);
	const shown = listed.slice(0, SECTIONS_LISTED);
	throw new UsageError(
		[
			`${block.prefix}${file} has no section "${wanted}".${near ? ` Did you mean "${near}"?` : ''}`,
			`Its sections: ${shown.join(', ')}${listed.length > shown.length ? `, … (${listed.length - shown.length} more)` : ''}`,
		].join('\n'),
		{
			hint: `${CLI} --search ${JSON.stringify(wanted)} ${block.name}, or ${CLI} ${docArgs(block, file)} --section`,
		},
	);
}

const STOP_WORDS: Record<string, true> = {
	the: true,
	and: true,
	for: true,
	with: true,
	how: true,
	what: true,
	when: true,
	from: true,
	into: true,
	use: true,
	using: true,
};

/** The words of a heading or a query that carry meaning: 3 letters or more, not a stop word. */
function meaningfulWords(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w.length >= 3 && !STOP_WORDS[w]);
}

/** A word's stem: all but its last 3 letters, at least 4 (`caching` → cach, `indexes` → inde). */
function stem(word: string): string {
	return word.slice(0, Math.max(4, word.length - 3));
}

/**
 * The lines that contain the term, in the named blocks or every doc. When none do: the lines that contain one of
 * its alternatives (grep's `a|b` or `a\|b`), then those that mention every word of it (`error.message`: error and
 * message), then the same searches in every doc when blocks were named; each fallback says what it searched. When no
 * doc mentions it at all but it is an export or option, its card.
 */
function search(index: DocsIndex, term: string, only: DocsBlock[]): string {
	const needle = decodeEntities(term).trim().toLowerCase();
	if (!needle) throw new UsageError(`--search needs a term, for example: ${CLI} --search ConditionalCheckFailed`);
	const words = [...new Set(meaningfulWords(needle))];
	const alternatives = [...new Set(needle.split(/\\?\|/).map((a) => a.trim()))].filter(Boolean);
	const named = [...new Set(only.map((b) => b.name))].join(', ');
	const attempts: { scope: DocsBlock[]; match: Match; note?: string }[] = [];
	const fallbacks = (scope: DocsBlock[], lead: string) => {
		if (alternatives.length > 1) {
			attempts.push({
				scope,
				match: { any: alternatives },
				note: `${lead} the lines that have ${alternatives.map((a) => JSON.stringify(a)).join(' or ')}:`,
			});
		}
		if (words.length > 1)
			attempts.push({ scope, match: words, note: `${lead} the lines that mention ${words.join(' and ')}:` });
	};
	attempts.push({ scope: only, match: needle });
	fallbacks(only, `no line has "${term}";`);
	if (only.length) {
		const lead = `${named} ${only.length > 1 ? 'do' : 'does'} not mention "${term}";`;
		attempts.push({ scope: [], match: needle, note: `${lead} other docs do:` });
		fallbacks([], `${lead} in other docs,`);
	}
	for (const { scope, match, note } of attempts) {
		const { hits, total, filesHit } = searchHits(index, match, scope, SEARCH_HITS);
		if (total === 0) continue;
		const out = [`search "${term}" in ${index.dir}`, ...(note ? [note] : []), ...hits];
		if (hits.length < total) {
			out.push(
				`${total} matching lines in ${filesHit} files; showing ${hits.length} (at most ${SEARCH_HITS_PER_FILE} per file). Name a block to narrow: ${CLI} --search ${JSON.stringify(term)} <block>`,
			);
		}
		out.push(`Read one: ${CLI} <block> --section <section>`);
		return `${out.join('\n')}\n`;
	}
	// No doc mentions it, but it can be a name the docs never write out: installCookieJar of /utils.
	const decls = findDeclarations(index, term.trim());
	const lookup = decls ? card(index, decls.name, decls.found, decls.member) : importCard(index, term);
	if (lookup) return `no doc mentions "${term}"; it is a name you can look up:\n${lookup}`;
	throw new CliError(`no doc mentions "${term}".`, { hint: `${CLI} for the list of blocks` });
}

/** What a search line has: a lowercase needle, every one of several lowercase words, or any of several needles. */
type Match = string | string[] | { any: string[] };

/** Lines that have `match` as `folder/file:line [section]: text`: READMEs first, then API reports. */
function searchHits(
	index: DocsIndex,
	match: Match,
	only: DocsBlock[],
	maxHits: number,
): { hits: string[]; total: number; filesHit: number } {
	const matches = (line: string) =>
		typeof match === 'string'
			? line.includes(match)
			: Array.isArray(match)
				? match.every((word) => line.includes(word))
				: match.any.some((needle) => line.includes(needle));
	const blocks = only.length
		? only
		: [...index.blocks.filter((b) => b.prefix), ...index.blocks.filter((b) => !b.prefix)];
	// READMEs first, then API reports, then DESIGN.md and the other files; changelogs are skipped.
	const order = (file: string) => ['README.md', 'API.md'].indexOf(file) + 1 || 3;
	const files = blocks
		.flatMap((block) =>
			block.files.filter((file) => !/^changelog\.md$/i.test(file)).map((file) => ({ block, file })),
		)
		.sort((a, b) => order(a.file) - order(b.file));
	const hits: string[] = [];
	let total = 0;
	let filesHit = 0;
	const seen = new Set<string>();
	for (const { block, file } of files) {
		const key = block.prefix + file;
		if (seen.has(key)) continue;
		seen.add(key);
		const text = readFileSync(join(block.dir, file), 'utf-8');
		const sections = parseSections(text);
		let inFile = 0;
		text.split('\n').forEach((line, i) => {
			if (!matches(line.toLowerCase())) return;
			total++;
			inFile++;
			if (inFile > SEARCH_HITS_PER_FILE || hits.length >= maxHits) return;
			const section = innermost(sections, i + 1);
			hits.push(
				`${key}:${i + 1}${section ? ` [${section.slug.slice(0, SEARCH_SLUG_LENGTH)}]` : ''}: ${clip(line)}`,
			);
		});
		if (inFile) filesHit++;
	}
	return { hits, total, filesHit };
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** Headings outside code fences, each with the lines it spans (subsections included). */
export function parseSections(text: string): Section[] {
	const lines = text.split('\n');
	const found: Omit<Section, 'end'>[] = [];
	let fence: string | undefined;
	lines.forEach((line, i) => {
		const f = /^\s*(```+|~~~+)/.exec(line);
		if (f) {
			if (!fence) fence = f[1][0];
			else if (f[1][0] === fence) fence = undefined;
			return;
		}
		if (fence) return;
		const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (h) found.push({ level: h[1].length, title: h[2], slug: slugify(h[2]), start: i + 1 });
	});
	return found.map((s, i) => {
		const next = found.slice(i + 1).find((n) => n.level <= s.level);
		return { ...s, end: next ? next.start - 1 : lines.length };
	});
}

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces as `-`. */
export function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/`/g, '')
		.replace(/[^\p{L}\p{N}\s_-]/gu, '')
		.trim()
		.replace(/\s/g, '-');
}

function innermost(sections: Section[], line: number): Section | undefined {
	let best: Section | undefined;
	for (const s of sections) if (s.start <= line && line <= s.end && (!best || s.start >= best.start)) best = s;
	return best;
}

/**
 * The README section a card prints for `words` (the looked-up name, the declaration's own): the innermost section
 * whose heading names one of them; else one whose heading has a word with the same stem as a word of 5 letters or
 * more (`query` → Queries; shorter words such as `get` would land on "Getting started"); else the innermost
 * section, below the level-1 heading whose own lines are the doc's intro, of the first call (`table.get(`), then of
 * the first mention, since a list of method names (`get`, `put`, …) often comes first; else that of any mention.
 * A section found by a mention ends before its first subsection: the mention is in its own lines (DistributedTable's
 * methods table under `## API`), which the subsections do not add to.
 */
function sectionMentioning(text: string, words: string[]): Section | undefined {
	const sections = parseSections(text);
	const smallest = (found: Section[]) => found.reduce((a, b) => (b.end - b.start < a.end - a.start ? b : a));
	const alternatives = words.map(escapeRegExp).join('|');
	const pattern = new RegExp(`(^|[^\\w$])(${alternatives})([^\\w$]|$)`);
	const titled = sections.filter((s) => pattern.test(s.title));
	if (titled.length) return smallest(titled);
	const stems = words
		.map((w) => w.toLowerCase())
		.filter((w) => w.length >= 5)
		.map(stem);
	const byStem = sections.filter((s) => meaningfulWords(s.title).some((t) => stems.some((st) => t.startsWith(st))));
	if (byStem.length) return smallest(byStem);
	const lines = text.split('\n');
	const at = (re: RegExp) => lines.flatMap((line, i) => (re.test(line) ? [innermost(sections, i + 1)] : []));
	const call = new RegExp(`(^|[^\\w$])(${alternatives})\\s*(<[^>]*>)?\\(`);
	const below = (found: (Section | undefined)[]) => found.find((s) => s && s.level > 1);
	const mentions = at(pattern);
	const found = below(at(call)) ?? below(mentions) ?? mentions.find(Boolean);
	if (!found) return undefined;
	const child = sections.find((c) => c.start > found.start && c.start <= found.end);
	return child ? { ...found, end: child.start - 1 } : found;
}

/**
 * Top-level declarations of an API Extractor report: `export class X ...` through the
 * line that closes it, and the members inside.
 */
export function parseApiReport(report: string, block: string): Declaration[] {
	const lines = report.split('\n');
	const decls: Declaration[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m =
			/^export (?:declare )?(?:abstract )?(class|interface|type|function|const|enum|namespace) ([A-Za-z_$][\w$]*)/.exec(
				lines[i],
			);
		if (!m || m[2].startsWith('_')) continue;
		const end = declarationEnd(lines, i);
		const body = lines.slice(i, end + 1).filter((line) => !REPORT_COMMENT.test(line));
		decls.push({ name: m[2], kind: m[1], block, lines: body, members: membersOf(body) });
		i = end;
	}
	return decls;
}

const REPORT_COMMENT = /^\s*\/\/(?:\s*| (?:@(?:public|beta|alpha|internal)\b.*|\(undocumented\)|Warning: .*))$/;
const MEMBER = /^\s+(?:(?:readonly|static|protected|abstract|get|set|async)\s+)*([A-Za-z_$][\w$]*)\??\s*[(:<]/;

/** `| bb-kv-store | What it does | keywords |` rows between the README's catalog markers. */
function parseCatalog(readme: string): Map<string, string> {
	const purposes = new Map<string, string>();
	const start = readme.indexOf('<!-- BEGIN:block-catalog -->');
	const end = readme.indexOf('<!-- END:block-catalog -->');
	if (start === -1 || end <= start) return purposes;
	for (const line of readme.slice(start, end).split('\n')) {
		const cells = line.split('|').map((c) => c.trim());
		if (cells.length < 4 || cells[1] === 'Block' || /^-+$/.test(cells[1])) continue;
		purposes.set(cells[1], cells[2]);
	}
	return purposes;
}

/** The `aws-blocks.vendorize` map of @aws-blocks/blocks' package.json: package → class names. */
function readVendorize(docsDir: string): Record<string, string[]> {
	try {
		const pkg = JSON.parse(readFileSync(join(docsDir, '..', 'package.json'), 'utf-8')) as {
			'aws-blocks'?: { vendorize?: Record<string, string[]> };
		};
		return pkg['aws-blocks']?.vendorize ?? {};
	} catch {
		return {};
	}
}

/** Markdown files at the root of `dir`: README.md, API.md, DESIGN.md, then the rest by name. */
function markdownFiles(dir: string): string[] {
	const order = new Map(['README.md', 'API.md', 'DESIGN.md'].map((file, i) => [file, i]));
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
		.map((entry) => entry.name)
		.sort((a, b) => (order.get(a) ?? order.size) - (order.get(b) ?? order.size) || a.localeCompare(b));
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clip(line: string): string {
	const text = line.trim().replace(/\s+/g, ' ');
	return text.length > SEARCH_LINE_LENGTH ? `${text.slice(0, SEARCH_LINE_LENGTH - 1)}…` : text;
}
