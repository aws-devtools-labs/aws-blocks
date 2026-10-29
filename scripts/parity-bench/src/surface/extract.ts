// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Static extraction of what each Building Block exposes and which AWS operations stand
 * behind it, read from the source with the TypeScript compiler — nothing is declared by hand.
 *
 * - Public methods: the public instance methods of every class `src/index.aws.ts` exports,
 *   minus `@internal` ones and those inherited from outside the package (`Scope`).
 * - AWS operations: every `new XCommand(…)` from an `@aws-sdk/*` package reachable from a
 *   method's body, following calls into the package's own functions and methods.
 * - AWS error types: the `@throws` tags of each command's declaration in the SDK.
 * - App usage: which of those methods an app's backend source calls.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import ts from 'typescript';
import type { AwsOperation, BlockMethod, BlockSurface } from '../core/coverage.js';

const COMPILER_OPTIONS: ts.CompilerOptions = {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	strict: true,
	skipLibCheck: true,
	noEmit: true,
	allowJs: false,
};

/** `@aws-sdk/lib-dynamodb` document commands → the DynamoDB operation each one sends. */
const DOCUMENT_CLIENT_OPERATIONS: Readonly<Record<string, string>> = {
	Get: 'GetItem',
	Put: 'PutItem',
	Delete: 'DeleteItem',
	Update: 'UpdateItem',
	Query: 'Query',
	Scan: 'Scan',
	BatchGet: 'BatchGetItem',
	BatchWrite: 'BatchWriteItem',
	TransactGet: 'TransactGetItems',
	TransactWrite: 'TransactWriteItems',
	ExecuteStatement: 'ExecuteStatement',
	BatchExecuteStatement: 'BatchExecuteStatement',
	ExecuteTransaction: 'ExecuteTransaction',
};

const THROWS = /@throws \{@link (\w+)\} \((client|server) fault\)/g;

/** Every `packages/bb-*` directory that has an AWS runtime entry. */
export function blockPackages(repoRoot: string): string[] {
	const dir = join(repoRoot, 'packages');
	return readdirSync(dir)
		.filter((name) => name.startsWith('bb-') && existsSync(join(dir, name, 'src', 'index.aws.ts')))
		.sort()
		.map((name) => join(dir, name));
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
	return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function isInternal(node: ts.Node): boolean {
	return ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'internal');
}

/** The package's `BB_NAME` (`src/version.ts`), which is also the `bbName` `trackBlock` records. */
export function blockNameOf(packageDir: string): string {
	const version = join(packageDir, 'src', 'version.ts');
	const match = existsSync(version) ? /BB_NAME = '([^']+)'/.exec(readFileSync(version, 'utf8')) : null;
	return match ? match[1] : (packageDir.split(sep).pop() ?? packageDir);
}

/** The implementation class behind an export: the class itself, or the class a `const` is initialised with. */
function implementationOf(checker: ts.TypeChecker, decl: ts.Declaration): ts.ClassLikeDeclaration | undefined {
	if (ts.isClassDeclaration(decl)) return decl;
	if (!ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
	let init: ts.Expression = decl.initializer;
	while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
	if (ts.isClassExpression(init)) return init;
	const target = ts.isIdentifier(init) ? resolveAlias(checker, checker.getSymbolAtLocation(init)) : undefined;
	return target?.declarations?.find(ts.isClassDeclaration);
}

/**
 * The body of method `name` on `cls` or the nearest base class that defines it. Falls back to a
 * private `#name`, for a public method the constructor assigns from one (`Secret.put`).
 */
function methodBody(checker: ts.TypeChecker, cls: ts.ClassLikeDeclaration | undefined, name: string): ts.Node | undefined {
	for (let c = cls; c; ) {
		const member =
			c.members.find((m) => ts.isMethodDeclaration(m) && m.name.getText() === name && m.body) ??
			c.members.find((m) => ts.isMethodDeclaration(m) && m.name.getText() === `#${name}` && m.body);
		if (member && ts.isMethodDeclaration(member)) return member.body;
		const base = c.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
		const symbol = base && resolveAlias(checker, checker.getSymbolAtLocation(base.expression));
		c = symbol?.declarations?.find(ts.isClassLike);
	}
	return undefined;
}

/** The AWS operation a command class stands for, from where the SDK declares it. */
function operationOf(className: string, declarationFile: string): AwsOperation | undefined {
	const match = /[\\/]@aws-sdk[\\/]([a-z0-9-]+)[\\/]/.exec(declarationFile);
	if (!match || !className.endsWith('Command')) return undefined;
	let client = match[1];
	let operation = className.slice(0, -'Command'.length);
	let file = declarationFile;
	if (client === 'lib-dynamodb') {
		const sent = DOCUMENT_CLIENT_OPERATIONS[operation];
		if (!sent) return undefined;
		operation = sent;
		client = 'client-dynamodb';
		file = declarationFile.replace(/lib-dynamodb([\\/].*[\\/]commands[\\/]).*$/, `client-dynamodb$1${sent}Command.d.ts`);
	}
	if (!client.startsWith('client-')) return undefined;
	const service = client.slice('client-'.length);
	const errors = existsSync(file)
		? [...new Set([...readFileSync(file, 'utf8').matchAll(THROWS)].map((m) => m[1]))].sort()
		: [];
	return { id: `${service}:${operation}`, service, operation, errors };
}

/** A function-like declaration with a body, if `decl` is one (or is a variable/property initialised with one). */
function bodyOf(decl: ts.Declaration): ts.Node | undefined {
	if ((ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isConstructorDeclaration(decl)) && decl.body) {
		return decl.body;
	}
	if ((ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) {
		const init = decl.initializer;
		if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init.body;
	}
	if (ts.isGetAccessorDeclaration(decl) && decl.body) return decl.body;
	return undefined;
}

/** Every class method body in the program's files under `dir`, by method name. */
function classMethodsByName(program: ts.Program, dir: string): Map<string, ts.Node[]> {
	const byName = new Map<string, ts.Node[]>();
	for (const sf of program.getSourceFiles()) {
		if (!sf.fileName.startsWith(dir)) continue;
		const visit = (n: ts.Node): void => {
			if (ts.isMethodDeclaration(n) && n.body && ts.isClassLike(n.parent)) {
				const name = n.name.getText();
				byName.set(name, [...(byName.get(name) ?? []), n.body]);
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return byName;
}

/**
 * All AWS operations reachable from `start`, following calls into declarations under
 * `withinDir`. A call to a body-less method declared in the workspace follows every same-named
 * class method in the package: an over-approximation that keeps `this.engine.query()` or a
 * shared base class from hiding the engines behind them.
 */
function reachableOperations(
	checker: ts.TypeChecker,
	start: ts.Node,
	withinDir: string,
	operations: Map<string, AwsOperation>,
	implementations: ReadonlyMap<string, readonly ts.Node[]>,
): string[] {
	const found = new Set<string>();
	const visited = new Set<ts.Node>();
	const inPackage = (decl: ts.Declaration) => decl.getSourceFile().fileName.startsWith(withinDir);

	const walk = (node: ts.Node): void => {
		if (visited.has(node)) return;
		visited.add(node);
		const visit = (n: ts.Node): void => {
			if (ts.isNewExpression(n)) {
				const symbol = resolveAlias(checker, checker.getSymbolAtLocation(n.expression));
				const decl = symbol?.declarations?.[0];
				const op = symbol && decl ? operationOf(symbol.name, decl.getSourceFile().fileName) : undefined;
				if (op) {
					operations.set(op.id, op);
					found.add(op.id);
				}
			}
			if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
				const symbol = resolveAlias(checker, checker.getSymbolAtLocation(n.expression));
				for (const decl of symbol?.declarations ?? []) {
					// A body-less method from the workspace (an interface, or a class in a sibling package's
					// .d.ts such as `@aws-blocks/data-common`) dispatches to this package's implementations.
					const bodyless = ts.isMethodSignature(decl) || (ts.isMethodDeclaration(decl) && !decl.body);
					if (bodyless && !decl.getSourceFile().fileName.includes(`${sep}node_modules${sep}`)) {
						for (const impl of implementations.get(decl.name.getText()) ?? []) walk(impl);
						continue;
					}
					const body = inPackage(decl) ? bodyOf(decl) : undefined;
					if (body) walk(body);
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(node);
	};
	walk(start);
	return [...found].sort();
}

/**
 * The public surface of every block package in `packageDirs`: the public methods of what each
 * exported constructor returns (a class, or a `const` typed with a construct signature), keyed
 * `<BB_NAME>.<method>`, with the AWS operations reachable from each method's implementation.
 */
export function extractSurfaces(packageDirs: readonly string[]): BlockSurface[] {
	const entries = packageDirs.map((dir) => join(dir, 'src', 'index.aws.ts'));
	const program = ts.createProgram(entries, COMPILER_OPTIONS);
	const checker = program.getTypeChecker();
	const surfaces: BlockSurface[] = [];

	for (const dir of packageDirs) {
		const block = dir.split(sep).pop() ?? dir;
		const bbName = blockNameOf(dir);
		const pkgDir = dir + sep;
		const srcDir = join(dir, 'src') + sep;
		const entry = program.getSourceFile(join(dir, 'src', 'index.aws.ts'));
		const moduleSymbol = entry && checker.getSymbolAtLocation(entry);
		const operations = new Map<string, AwsOperation>();
		const methods = new Map<string, Set<string>>();
		const classes = new Set<string>();
		const implementations = classMethodsByName(program, srcDir);

		for (const exported of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
			const symbol = resolveAlias(checker, exported);
			// The value side: `Secret` is both a type alias and the const holding its class.
			const decl = symbol?.valueDeclaration;
			if (!symbol || !decl || !(symbol.flags & ts.SymbolFlags.Value) || !decl.getSourceFile().fileName.startsWith(srcDir)) continue;
			if (isInternal(decl)) continue;
			const ctor = checker.getTypeOfSymbolAtLocation(symbol, decl).getConstructSignatures()[0];
			// Building Blocks only: their instances carry `bbName` (from Scope). Helper classes don't count.
			if (!ctor || !ctor.getReturnType().getProperty('bbName')) continue;
			const impl = implementationOf(checker, decl);
			let found = false;
			for (const prop of ctor.getReturnType().getProperties()) {
				const pdecl = prop.declarations?.[0];
				if (!pdecl || !(ts.isMethodDeclaration(pdecl) || ts.isMethodSignature(pdecl))) continue;
				if (!pdecl.getSourceFile().fileName.startsWith(pkgDir)) continue; // inherited from Scope etc.
				const flags = ts.getCombinedModifierFlags(pdecl);
				if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static)) continue;
				if (prop.name.startsWith('_') || prop.name.startsWith('#') || prop.name === 'toJSON' || isInternal(pdecl)) continue;
				const body = ts.isMethodDeclaration(pdecl) && pdecl.body ? pdecl.body : methodBody(checker, impl, prop.name);
				const key = `${bbName}.${prop.name}`;
				if (!methods.has(key)) methods.set(key, new Set());
				for (const op of body ? reachableOperations(checker, body, srcDir, operations, implementations) : []) methods.get(key)?.add(op);
				found = true;
			}
			if (found) classes.add(symbol.name);
		}
		surfaces.push({
			block,
			bbName,
			classes: [...classes].sort(),
			methods: [...methods]
				.map(([name, ops]) => ({ name, operations: [...ops].sort() }))
				.sort((a, b) => a.name.localeCompare(b.name)),
			operations: Object.fromEntries([...operations].sort(([a], [b]) => a.localeCompare(b))),
		});
	}
	return surfaces;
}

/** Every `.ts` file under `dir`, skipping CDK entries, tests and declaration files. */
export function backendSources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'node_modules') out.push(...backendSources(path));
		} else if (/\.tsx?$/.test(entry.name) && !/(\.d|\.cdk|\.test)\.tsx?$/.test(entry.name)) {
			out.push(path);
		}
	}
	return out.sort();
}

/**
 * The block methods an app's backend calls: call sites in `files` whose target method is
 * declared by a block package, keyed like the surface (`KVStore.put`). Call sites outside
 * `files` (libraries the app imports, such as these probe packs) don't count.
 */
export function extractAppCalls(files: readonly string[], surfaces: readonly BlockSurface[], packagesDir: string): Set<string> {
	const program = ts.createProgram([...files], COMPILER_OPTIONS);
	const checker = program.getTypeChecker();
	const roots = new Set(files);
	const known = new Set(surfaces.flatMap((s) => s.methods.map((m) => m.name)));
	const bbNameOfBlock = new Map(surfaces.map((s) => [s.block, s.bbName]));
	const calls = new Set<string>();
	for (const sf of program.getSourceFiles()) {
		if (!roots.has(sf.fileName)) continue;
		const visit = (n: ts.Node): void => {
			if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
				const symbol = resolveAlias(checker, checker.getSymbolAtLocation(n.expression.name));
				for (const decl of symbol?.declarations ?? []) {
					const rel = relative(packagesDir, decl.getSourceFile().fileName);
					const bbName = bbNameOfBlock.get(rel.split(sep)[0]);
					const key = bbName && `${bbName}.${n.expression.name.text}`;
					if (key && !rel.startsWith('..') && known.has(key)) calls.add(key);
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return calls;
}

/** The repository root: the nearest ancestor of `from` with a `packages/` directory. */
export function findRepoRoot(from: string): string {
	for (let dir = from; ; dir = dirname(dir)) {
		if (existsSync(join(dir, 'packages')) && existsSync(join(dir, 'package.json'))) return dir;
		if (dirname(dir) === dir) throw new Error(`no repository root above ${from}`);
	}
}
