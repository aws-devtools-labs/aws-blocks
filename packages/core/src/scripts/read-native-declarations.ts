// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @see docs/native-clients/codegen-design.md
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isPlainObject, NativeCatalogError, type NativeDeclarationInput } from './native-catalogs.js';

const NATIVE_DECLARATION_NAMESPACE = 'aws-blocks';

const NATIVE_DECLARATION_KEY = 'native';

const DECLARATION_PATH = `${NATIVE_DECLARATION_NAMESPACE}.${NATIVE_DECLARATION_KEY}`;

const DECLARATION_FIELDS = ['packages', 'bindings'] as const;

const ABSENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

type DeclarationError = { path: string; message: string };

interface InstalledPackage {
	manifestPath: string;
	specifier: string;
}

/**
 * Rooted at the spec project, not `process.cwd()`, so what is found is what the
 * generated spec's own app installed. Throws `NativeCatalogError` when the
 * `aws-blocks.native` key is unusable or an installed manifest cannot be read.
 * The contents of `packages` and `bindings` are passed through for
 * `validateNativeCatalogs` to report on.
 */
export function readNativeDeclarations(foundationPath: string): NativeDeclarationInput[] {
	const sources: NativeDeclarationInput[] = [];
	const errors: DeclarationError[] = [];
	// Decided before the read: resolution picks by location, so a copy that is
	// unreadable or not an object still shadows the ones behind it.
	const resolved = new Set<string>();
	const start = dirname(resolve(foundationPath));

	for (const { manifestPath, specifier } of iterateInstalledPackageJsons(start)) {
		if (resolved.has(specifier)) continue;
		resolved.add(specifier);
		const manifest = readManifest(manifestPath, specifier, errors);
		if (manifest === undefined) continue;

		const namespace = manifest[NATIVE_DECLARATION_NAMESPACE];
		if (!isPlainObject(namespace)) continue;
		const declarations = namespace[NATIVE_DECLARATION_KEY];
		if (declarations === undefined) continue;

		if (!isPlainObject(declarations)) {
			errors.push({
				path: DECLARATION_PATH,
				message: `"${DECLARATION_PATH}" must be an object (declared by ${specifier})`,
			});
			continue;
		}

		const source: NativeDeclarationInput = { sourcePackage: specifier };
		if (declarations.packages !== undefined) {
			source.packages = declarations.packages;
		}
		if (declarations.bindings !== undefined) {
			source.bindings = declarations.bindings;
		}

		for (const key of Object.keys(declarations)) {
			if ((DECLARATION_FIELDS as readonly string[]).includes(key)) continue;
			errors.push({
				path: `${DECLARATION_PATH}.${key}`,
				message:
					`Unexpected field "${key}" — "${DECLARATION_PATH}" holds only ` +
					`${DECLARATION_FIELDS.join(' and ')} (declared by ${specifier})`,
			});
		}

		if (source.packages !== undefined || source.bindings !== undefined) sources.push(source);
	}

	if (errors.length > 0) throw new NativeCatalogError(errors);
	return sources;
}

/**
 * `undefined` whenever there is nothing to hand back: the manifest is absent, it
 * is not an object, or it will not parse and cannot carry the key. A manifest
 * that cannot be read, or that names the key and will not parse, is reported.
 */
function readManifest(
	manifestPath: string,
	specifier: string,
	errors: DeclarationError[],
): Record<string, unknown> | undefined {
	let raw: string;
	try {
		raw = readFileSync(manifestPath, 'utf-8');
	} catch (cause) {
		warnUnlessAbsent(cause, manifestPath);
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
	} catch {
		if (!mentionsNamespace(raw)) {
			console.warn(`⚠️  Native declarations skipped in ${manifestPath}: not valid JSON`);
			return undefined;
		}
		errors.push({
			path: DECLARATION_PATH,
			message: `Cannot parse ${manifestPath} as JSON (declared by ${specifier})`,
		});
		return undefined;
	}
	return isPlainObject(parsed) ? parsed : undefined;
}

/**
 * Whether unparseable text could still encode the key. `\uXXXX` is the only JSON
 * escape that yields a letter or a hyphen, so decoding those is enough to rule
 * the key out; a stray `\\u0061` decodes too, which errs toward reporting.
 */
function mentionsNamespace(raw: string): boolean {
	if (raw.includes(NATIVE_DECLARATION_NAMESPACE)) return true;
	if (!raw.includes('\\u')) return false;
	return raw
		.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
		.includes(NATIVE_DECLARATION_NAMESPACE);
}

function warnUnlessAbsent(cause: unknown, path: string): void {
	const code = readCode(cause);
	if (code !== undefined && ABSENT_CODES.has(code)) return;
	console.warn(`⚠️  Native declarations skipped in ${path}: ${code ?? 'unknown error'}`);
}

/** Total: a thrown value may be anything, including one whose `code` throws. */
function readCode(cause: unknown): string | undefined {
	try {
		const code = (cause as { code?: unknown } | null | undefined)?.code;
		return typeof code === 'string' ? code : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Every `node_modules` ancestor of the spec project. A nested `node_modules`
 * belonging to another package is not reachable from here and is not visited,
 * and neither is a dot-directory, which is where pnpm keeps its store.
 */
function* iterateInstalledPackageJsons(startDir: string): Generator<InstalledPackage> {
	let dir = startDir;
	while (true) {
		const modulesDir = join(dir, 'node_modules');
		for (const entry of readInstallDir(modulesDir)) {
			if (entry.startsWith('.')) continue;
			const scopeDir = join(modulesDir, entry);
			const specifiers = entry.startsWith('@')
				? readInstallDir(scopeDir)
						.filter((scoped) => !scoped.startsWith('.'))
						.map((scoped) => `${entry}/${scoped}`)
				: [entry];
			for (const specifier of specifiers) {
				yield { manifestPath: join(modulesDir, ...specifier.split('/'), 'package.json'), specifier };
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return;
		dir = parent;
	}
}

/**
 * Warned, not fatal: the walk reaches ancestors outside the project, where a
 * permission problem is not the app's to fix. Only a manifest whose text names
 * `aws-blocks` can abort, because only then is there evidence to rule out.
 */
function readInstallDir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch (cause) {
		const code = readCode(cause);
		if (code === undefined || !ABSENT_CODES.has(code)) {
			console.warn(`⚠️  Native declarations skipped in ${dir}: ${code ?? 'unknown error'}`);
		}
		return [];
	}
}
