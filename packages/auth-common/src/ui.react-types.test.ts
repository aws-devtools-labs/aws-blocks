// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Requirement S10: the documented React usage of the auth-state store
 * type-checks against the **real** `@types/react` with zero casts.
 *
 * `ui.types-test.ts` already proves this at build time against a structural
 * stand-in with React's exact signature (this package does not depend on
 * React). This test type-checks the README's hook against the built
 * declarations (`dist/ui.d.ts`) and whatever `@types/react` the workspace
 * resolves, so a drift between the stand-in and React fails here. Skipped
 * when `@types/react` is not resolvable.
 */

import assert from 'node:assert';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function reactTypesAvailable(): boolean {
	try {
		createRequire(join(packageRoot, 'package.json')).resolve('@types/react/package.json');
		return true;
	} catch {
		return false;
	}
}

const probe = `
import { useSyncExternalStore } from 'react';
import { getAuthStateSnapshot, subscribeAuthState, submitAuthAction, type AuthStateApi } from './dist/ui.js';
import type { AuthState } from './dist/index.js';
declare const authApi: AuthStateApi;

const subscribe = (cb: () => void) => subscribeAuthState(authApi, cb);
const getSnapshot = () => getAuthStateSnapshot(authApi);

export function useAuthState(): AuthState | null {
	return useSyncExternalStore(subscribe, getSnapshot, () => null); // null = not yet known
}

export async function signOut(): Promise<AuthState> {
	return submitAuthAction(authApi, { action: 'signOut' });
}

// CUSTOMIZING-AUTH-UI.md "In a framework component (React)".
export function SignOutButton() {
	const state = useSyncExternalStore(subscribe, getSnapshot, () => null);
	if (state?.state !== 'signedIn') return null;
	return <button onClick={() => submitAuthAction(authApi, { action: 'signOut' })}>Sign out</button>;
}
`;

test('S10: useSyncExternalStore(subscribeAuthState, getAuthStateSnapshot) type-checks against @types/react', {
	skip: reactTypesAvailable() ? false : '@types/react is not resolvable from this package',
}, () => {
	const compilerOptions: ts.CompilerOptions = {
		strict: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ES2022,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
		jsx: ts.JsxEmit.ReactJSX,
		skipLibCheck: true,
		noEmit: true,
		types: [],
	};
	const file = join(packageRoot, '__react_store_probe__.tsx');
	const host = ts.createCompilerHost(compilerOptions);
	const getSourceFile = host.getSourceFile.bind(host);
	const fileExists = host.fileExists.bind(host);
	const readFile = host.readFile.bind(host);
	host.getSourceFile = (fileName, languageVersion, ...rest) =>
		fileName === file
			? ts.createSourceFile(fileName, probe, languageVersion, true)
			: getSourceFile(fileName, languageVersion, ...rest);
	host.fileExists = (fileName) => fileName === file || fileExists(fileName);
	host.readFile = (fileName) => (fileName === file ? probe : readFile(fileName));

	const program = ts.createProgram([file], compilerOptions, host);
	const diagnostics = ts
		.getPreEmitDiagnostics(program, program.getSourceFile(file))
		.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
	assert.deepStrictEqual(diagnostics, []);
	// Guard against a vacuous pass: React's types really were loaded.
	assert.ok(
		program.getSourceFiles().some((sf) => /[\\/]@types[\\/]react[\\/]index\.d\.ts$/.test(sf.fileName)),
		'@types/react was resolved',
	);
});
