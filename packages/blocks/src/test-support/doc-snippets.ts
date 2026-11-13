// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Checks the TypeScript / JavaScript code samples of the shipped docs against
 * the built packages, so a renamed or removed export can't silently leave a
 * stale sample behind. Used by `doc-snippets.test.ts`; not part of the
 * package's public entries.
 *
 * Every ```ts / ```js block gets the light check, which suits fragments:
 *  - each name imported from an `@aws-blocks/*` entry is exported by it;
 *  - `new X(…)` and `X.member` on such a name exist;
 *  - a PascalCase name used with `new` or `.` that the doc neither declares nor
 *    imports, and that is not a global, is exported by an `@aws-blocks/blocks`
 *    entry (the umbrella an app imports from) with that member, or by some
 *    module the docs import elsewhere (`Duration` from `aws-cdk-lib`). This is
 *    what catches a fragment that still constructs a removed block.
 *
 * A block that is one complete file — its first line names the file
 * (`// aws-blocks/index.ts`), no other line does, and it has an import — is
 * typechecked in full instead. Complete files under the same heading form one
 * app, as in bb-auth's README recipes: `'aws-blocks'` resolves to that app's
 * `aws-blocks/index.ts`.
 *
 * Markers, each with its reason:
 *  - `<!-- doc-snippet: skip — "before" code of a migration -->`, directly above
 *    a fence, checks nothing in that block;
 *  - `<!-- doc-snippet: fragment — assumes the scope from above -->`, directly
 *    above a fence, keeps the light check for a block that names its file but
 *    is not complete;
 *  - `<!-- doc-snippet: skip-file — reason -->`, anywhere in a doc, checks none
 *    of its blocks (a changelog, whose samples show the API of past releases).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';

/** One markdown document to check. `source` is the path findings report (the repo path). */
export interface DocInput {
	readonly source: string;
	readonly text: string;
}

/** A problem in one code block: where it is and what is wrong. */
export interface Finding {
	/** `<source>:<line>` of the block's opening fence (or of a marker). */
	readonly at: string;
	readonly message: string;
}

const MARKER = /^\s*<!--\s*doc-snippet:\s*(\S+)(.*?)-->\s*$/;
const CODE_LANGS: Record<string, true> = {
	ts: true,
	typescript: true,
	tsx: true,
	js: true,
	javascript: true,
	jsx: true,
	mjs: true,
	mts: true,
};
/** A file label: `// src/main.ts`, optionally followed by a description (`// src/main.ts — the browser`). */
const FILE_COMMENT = /^\/\/ (\S+\.(?:ts|tsx|mts))(?:\s.*)?$/;
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w-]*)/;

type Mode = 'check' | 'fragment' | 'skip';

interface Block {
	readonly at: string;
	readonly lang: string;
	readonly code: string;
	/** Index of the heading the block sits under (for grouping complete files). */
	readonly section: number;
	readonly mode: Mode;
}

/** A blockquote prefix (`> `, `>> `, `> > `): a fence inside a quote is still a fenced sample. */
const QUOTE = /^(\s*>\s?)+/;

/** The fenced code blocks of `doc`; problems with its markers go to `findings`. */
function parseBlocks(doc: DocInput, findings: Finding[]): Block[] {
	const lines = doc.text.split('\n');
	const blocks: Block[] = [];
	let section = 0;
	let mode: Mode = 'check';
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		const at = `${doc.source}:${i + 1}`;
		const marker = MARKER.exec(line);
		if (marker) {
			const kind = marker[1];
			const reason = (marker[2] ?? '').replace(/^\s*[—:-]\s*/, '').trim();
			if (kind !== 'skip' && kind !== 'fragment' && kind !== 'skip-file') {
				findings.push({
					at,
					message: `unknown doc-snippet marker "${kind}" (use skip, fragment or skip-file)`,
				});
			} else if (!reason) {
				findings.push({ at, message: `doc-snippet ${kind} marker without a reason` });
			} else if (kind === 'skip-file') {
				return [];
			} else if (!FENCE.test((lines[i + 1] ?? '').replace(QUOTE, ''))) {
				findings.push({ at, message: `doc-snippet ${kind} marker is not directly above a code fence` });
			} else {
				mode = kind;
			}
			continue;
		}
		if (/^#{1,6}\s/.test(line)) section++;
		// Inside a blockquote, the fence and every line of the block carry the quote prefix: strip it from
		// all of them. An unquoted block keeps its lines as written (code may start with `>`).
		const quoted = QUOTE.exec(line)?.[0] ?? '';
		const unquote = (l: string) => (quoted ? l.replace(QUOTE, '') : l);
		const open = FENCE.exec(unquote(line));
		if (!open) {
			mode = 'check';
			continue;
		}
		const indent = open[1] ?? '';
		const fence = open[2] ?? '```';
		// A closing fence is the opening fence's character, repeated at least as often, alone on its line.
		const closes = (l: string) => {
			const t = unquote(l).trim();
			return t.length >= fence.length && [...t].every((c) => c === fence[0]);
		};
		const body: string[] = [];
		let j = i + 1;
		for (; j < lines.length && !closes(lines[j] ?? ''); j++) {
			const l = unquote(lines[j] ?? '');
			body.push(l.startsWith(indent) ? l.slice(indent.length) : l.trimStart());
		}
		const lang = (open[3] ?? '').toLowerCase();
		if (CODE_LANGS[lang]) blocks.push({ at, lang, code: body.join('\n'), section, mode });
		mode = 'check';
		i = j;
	}
	return blocks;
}

interface Analysis {
	readonly block: Block;
	/** `@aws-blocks/*` import declarations, one per line; a repeated local name is aliased. */
	readonly blocksImports: string[];
	/** Local name → `@aws-blocks/*` specifier it was imported from. */
	readonly blocksNames: Set<string>;
	/** Every name the block declares or imports (from any module). */
	readonly declared: Set<string>;
	/** Bare (non-relative, non-`aws-blocks`) module specifiers the block imports. */
	readonly modules: Set<string>;
	/** `new X` / `X.member` uses on bare identifiers: name → members (`''` for `new`). */
	readonly uses: Map<string, Set<string>>;
	/** The path of a complete file, if the block is one. */
	readonly completeFile: string | undefined;
	/** Value imports from `@aws-blocks/*` in browser files (`// src/…`, `// test/…`, `// frontend/…`), one per line. */
	readonly browserImports: string[];
}

/** Files that run under the `browser` condition: the frontend and the e2e tests (`tsx -C browser`). */
const BROWSER_FILE = /^(src|test|frontend)\//;

function collectBindingNames(name: ts.BindingName, into: Set<string>): void {
	if (ts.isIdentifier(name)) into.add(name.text);
	else for (const el of name.elements) if (!ts.isOmittedExpression(el)) collectBindingNames(el.name, into);
}

function analyze(block: Block): Analysis {
	const kind = block.lang === 'tsx' || block.lang === 'jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sf = ts.createSourceFile('snippet.tsx', block.code, ts.ScriptTarget.ES2022, true, kind);
	const blocksImports: string[] = [];
	const blocksNames = new Set<string>();
	const declared = new Set<string>();
	const modules = new Set<string>();
	const uses = new Map<string, Set<string>>();
	let hasImport = false;
	let dup = 0;
	const browserImports: string[] = [];
	const codeLines = block.code.split('\n');
	/** The file a line belongs to: the nearest `// path` comment line at or above it. */
	const fileAt = (line: number): string | undefined => {
		for (let l = line; l >= 0; l--) {
			const path = FILE_COMMENT.exec(codeLines[l] ?? '')?.[1];
			if (path) return path;
		}
		return undefined;
	};
	const use = (name: string, member: string) => {
		const set = uses.get(name) ?? new Set<string>();
		set.add(member);
		uses.set(name, set);
	};
	/** `name`, or a fresh alias when the block already imports `name` (a block listing alternative entries). */
	const local = (name: string): string => {
		if (!blocksNames.has(name)) {
			blocksNames.add(name);
			return name;
		}
		return `__dup${dup++}`;
	};
	const binding = (exported: string, name: string): string => {
		const as = local(name);
		return as === exported ? exported : `${exported} as ${as}`;
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			hasImport = true;
			const spec = node.moduleSpecifier.text;
			const clause = node.importClause;
			if (!spec.startsWith('.') && spec !== 'aws-blocks') modules.add(spec);
			if (clause?.name) declared.add(clause.name.text);
			const nb = clause?.namedBindings;
			if (nb && ts.isNamespaceImport(nb)) declared.add(nb.name.text);
			if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) declared.add(el.name.text);
			// In a browser file, each value it imports must exist under the `browser` condition too (a namespace
			// import of an empty module is not an error, so only named and default imports are checked).
			const file = fileAt(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line);
			if (spec.startsWith('@aws-blocks/') && clause && !clause.isTypeOnly && file && BROWSER_FILE.test(file)) {
				const names = [
					...(clause.name ? ['default'] : []),
					...(nb && ts.isNamedImports(nb)
						? nb.elements.filter((el) => !el.isTypeOnly).map((el) => (el.propertyName ?? el.name).text)
						: []),
				];
				const n = browserImports.length;
				const bindings = names.map((name, k) => `${name} as __b${n}_${k}`).join(', ');
				if (names.length > 0) browserImports.push(`import { ${bindings} } from '${spec}';`);
			}
			if (spec.startsWith('@aws-blocks/') && clause) {
				const parts: string[] = [];
				if (clause.name) parts.push(`default as ${local(clause.name.text)}`);
				if (nb && ts.isNamespaceImport(nb))
					blocksImports.push(`import * as ${local(nb.name.text)} from '${spec}';`);
				if (nb && ts.isNamedImports(nb)) {
					for (const el of nb.elements) {
						const exported = (el.propertyName ?? el.name).text;
						parts.push(`${el.isTypeOnly ? 'type ' : ''}${binding(exported, el.name.text)}`);
					}
				}
				if (parts.length > 0) {
					blocksImports.push(
						`import ${clause.isTypeOnly ? 'type ' : ''}{ ${parts.join(', ')} } from '${spec}';`,
					);
				}
			}
			return;
		}
		if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && node.name) {
			collectBindingNames(node.name, declared);
		} else if (
			(ts.isFunctionDeclaration(node) ||
				ts.isClassDeclaration(node) ||
				ts.isClassExpression(node) ||
				ts.isFunctionExpression(node) ||
				ts.isInterfaceDeclaration(node) ||
				ts.isTypeAliasDeclaration(node) ||
				ts.isEnumDeclaration(node) ||
				ts.isModuleDeclaration(node)) &&
			node.name &&
			ts.isIdentifier(node.name)
		) {
			declared.add(node.name.text);
		}
		if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) use(node.expression.text, '');
		if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && ts.isIdentifier(node.name)) {
			use(node.expression.text, node.name.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	const path = FILE_COMMENT.exec(codeLines[0] ?? '')?.[1];
	const oneFile = codeLines.slice(1).every((l) => !FILE_COMMENT.test(l));
	const completeFile = block.mode === 'check' && path && oneFile && hasImport ? path : undefined;
	return { block, blocksImports, blocksNames, declared, modules, uses, completeFile, browserImports };
}

/** Compiler options of an AWS Blocks app (strict, ESM, bundler resolution, default conditions). */
const COMPILER_OPTIONS: ts.CompilerOptions = {
	strict: true,
	noEmit: true,
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	lib: ['lib.es2022.d.ts', 'lib.esnext.array.d.ts', 'lib.dom.d.ts'],
	types: ['node'],
	jsx: ts.JsxEmit.Preserve,
	skipLibCheck: true,
	esModuleInterop: true,
};

/** A compiler host that parses each declaration file once across programs. */
function cachingHost(): ts.CompilerHost {
	const host = ts.createCompilerHost(COMPILER_OPTIONS);
	const cache = new Map<string, ts.SourceFile | undefined>();
	const getSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
		if (!fileName.endsWith('.d.ts')) return getSourceFile(fileName, languageVersion, onError, shouldCreate);
		if (!cache.has(fileName)) cache.set(fileName, getSourceFile(fileName, languageVersion, onError, shouldCreate));
		return cache.get(fileName);
	};
	return host;
}

interface Probe {
	readonly globals: Set<string>;
	/** Module specifier → its exported names (empty when it doesn't resolve). */
	readonly exports: Map<string, Set<string>>;
}

/** The global value names, and what each of `specifiers` exports. */
function probe(dir: string, host: ts.CompilerHost, specifiers: readonly string[]): Probe {
	const file = join(dir, 'probe.ts');
	writeFileSync(file, `${specifiers.map((s, i) => `import * as e${i} from '${s}';`).join('\n')}\nexport {};\n`);
	const program = ts.createProgram([file], COMPILER_OPTIONS, host);
	const checker = program.getTypeChecker();
	const sf = program.getSourceFile(file);
	if (!sf) throw new Error('probe file missing');
	const globals = new Set<string>();
	for (const s of checker.getSymbolsInScope(sf, ts.SymbolFlags.Value | ts.SymbolFlags.Namespace)) globals.add(s.name);
	const exports = new Map<string, Set<string>>();
	sf.statements.filter(ts.isImportDeclaration).forEach((decl, i) => {
		const spec = specifiers[i];
		if (spec === undefined) return;
		const moduleSymbol = checker.getSymbolAtLocation(decl.moduleSpecifier);
		const names = new Set<string>();
		if (moduleSymbol) for (const s of checker.getExportsOfModule(moduleSymbol)) names.add(s.name);
		exports.set(spec, names);
	});
	return { globals, exports };
}

interface Origin {
	readonly at: string;
	readonly what: string;
}

/**
 * Check every code block of `docs` against the packages resolvable from
 * `scratchBase` (a directory inside a package's `dist/`, so `@aws-blocks/*`
 * resolve through the workspace `node_modules` as an app's would).
 *
 * @param entrySpecifiers - The `@aws-blocks/blocks` entries an undeclared name may come from, root first.
 */
export function checkDocs(
	docs: readonly DocInput[],
	scratchBase: string,
	entrySpecifiers: readonly string[],
): Finding[] {
	const findings: Finding[] = [];
	const perDoc = docs.map((doc) =>
		parseBlocks(doc, findings)
			.filter((b) => b.mode !== 'skip')
			.map(analyze),
	);
	// Undeclared names resolve against the umbrella first, then Blocks packages, then anything else the docs import.
	const imported = [...new Set(perDoc.flat().flatMap((a) => [...a.modules]))].filter(
		(m) => !entrySpecifiers.includes(m),
	);
	const candidates = [
		...entrySpecifiers,
		...imported.filter((m) => m.startsWith('@aws-blocks/')),
		...imported.filter((m) => !m.startsWith('@aws-blocks/')),
	];

	mkdirSync(scratchBase, { recursive: true });
	const dir = mkdtempSync(join(scratchBase, 'run-'));
	try {
		const host = cachingHost();
		const { globals, exports } = probe(dir, host, candidates);
		const roots: string[] = [];
		/** Light-check file → line (1-based) → what it checks. */
		const origins = new Map<string, Map<number, Origin>>();
		/** Written complete file → the block it came from. */
		const appFiles = new Map<string, Origin>();
		let n = 0;
		/** Browser-condition check files (value imports of browser files) → the block they came from. */
		const browserFiles = new Map<string, Origin>();

		for (const analyses of perDoc) {
			const docDeclared = new Set(analyses.flatMap((a) => [...a.declared]));
			let app: { dir: string; section: number; files: Map<string, string> } | undefined;
			const apps: { dir: string; files: Map<string, string> }[] = [];

			for (const a of analyses) {
				const { at } = a.block;
				if (a.browserImports.length > 0) {
					const file = join(dir, `browser-${n++}.ts`);
					writeFileSync(file, `${a.browserImports.join('\n')}\nexport {};\n`);
					browserFiles.set(file, {
						at,
						what: 'under the `browser` condition (browser bundles, `tsx -C browser` tests)',
					});
				}
				if (a.completeFile) {
					// Complete files under one heading are one app; a repeated path starts another.
					if (!app || app.section !== a.block.section || app.files.has(a.completeFile)) {
						app = { dir: join(dir, `app-${n++}`), section: a.block.section, files: new Map() };
						apps.push(app);
					}
					app.files.set(a.completeFile, a.block.code);
					appFiles.set(join(app.dir, a.completeFile), { at, what: `complete file ${a.completeFile}` });
					continue;
				}

				const header: string[] = [];
				const body: string[] = [];
				const bodyOrigins: Origin[] = [];
				for (const imp of a.blocksImports) header.push(imp);
				const headerOrigins: Origin[] = a.blocksImports.map((imp) => ({ at, what: imp }));
				for (const [name, members] of a.uses) {
					if (!a.blocksNames.has(name)) {
						if (!/^[A-Z]/.test(name) || docDeclared.has(name) || globals.has(name)) continue;
						const from = candidates.find((s) => exports.get(s)?.has(name));
						if (!from) {
							findings.push({
								at,
								message: `uses \`${name}\`, which this doc never declares or imports and no @aws-blocks/blocks entry exports`,
							});
							continue;
						}
						if (!from.startsWith('@aws-blocks/')) continue;
						header.push(`import { ${name} } from '${from}';`);
						headerOrigins.push({ at, what: `${name} (from ${from})` });
					}
					for (const member of members) {
						if (member === '') body.push(`type __New${body.length} = InstanceType<typeof ${name}>;`);
						else body.push(`void ${name}.${member};`);
						bodyOrigins.push({ at, what: member === '' ? `new ${name}(…)` : `${name}.${member}` });
					}
				}
				if (header.length === 0 && body.length === 0) continue;
				const file = join(dir, `block-${n++}.ts`);
				const lineOrigins = new Map<number, Origin>();
				[...headerOrigins, ...bodyOrigins].forEach((o, k) => {
					lineOrigins.set(k + 1, o);
				});
				writeFileSync(file, `${[...header, ...body].join('\n')}\nexport {};\n`);
				origins.set(file, lineOrigins);
				roots.push(file);
			}

			for (const a of apps) {
				const backend = a.files.has('aws-blocks/index.ts') ? join(a.dir, 'aws-blocks', 'index.js') : undefined;
				for (const [path, code] of a.files) {
					const abs = join(a.dir, path);
					mkdirSync(dirname(abs), { recursive: true });
					let text = code;
					if (backend && path !== 'aws-blocks/index.ts') {
						let rel = relative(dirname(abs), backend);
						if (!rel.startsWith('.')) rel = `./${rel}`;
						text = text.replace(/(['"])aws-blocks\1/g, `'${rel}'`);
					}
					writeFileSync(abs, `${text}\nexport {};\n`);
					roots.push(abs);
				}
			}
		}

		const program = ts.createProgram(roots, COMPILER_OPTIONS, host);
		for (const d of ts.getPreEmitDiagnostics(program)) {
			const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
			if (!d.file || d.start === undefined) {
				findings.push({ at: '(program)', message: msg });
				continue;
			}
			const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
			const light = origins.get(d.file.fileName)?.get(line + 1);
			const full = appFiles.get(d.file.fileName);
			if (light) findings.push({ at: light.at, message: `${light.what}: ${msg}` });
			else if (full)
				findings.push({ at: full.at, message: `${full.what}, line ${line + 1}:${character + 1}: ${msg}` });
			else findings.push({ at: d.file.fileName, message: msg });
		}

		// Browser files again, resolved as a browser bundle (and `tsx -C browser`) resolves them: the root
		// `@aws-blocks/blocks` is an empty module there, so a value import from it is undefined at runtime.
		const browserProgram = ts.createProgram(
			[...browserFiles.keys()],
			{ ...COMPILER_OPTIONS, customConditions: ['browser'] },
			host,
		);
		for (const d of ts.getPreEmitDiagnostics(browserProgram)) {
			const origin = d.file && browserFiles.get(d.file.fileName);
			const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
			findings.push(
				origin
					? { at: origin.at, message: `${origin.what}: ${msg}` }
					: { at: '(browser program)', message: msg },
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return findings;
}

/** Read `path` as a {@link DocInput} reported as `source`. */
export function readDoc(path: string, source: string): DocInput {
	return { source, text: readFileSync(path, 'utf8') };
}
