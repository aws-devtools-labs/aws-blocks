// Every template's test/e2e.test.ts is where users add their own tests. Its imports must leave the
// global callback-style `setTimeout(cb, ms)` intact, so a user test can call it. This compiles each
// template's real import declarations, appends such a call, and runs the result in Node.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const templatesDir = join(packageDir, 'templates');
const templates = readdirSync(templatesDir).filter((name) => existsSync(join(templatesDir, name, 'test/e2e.test.ts')));

/**
 * The template test's import declarations followed by `body`, compiled to ESM. Compiling them together
 * keeps any value import that `body` uses (TypeScript drops imports nothing references).
 */
function compiledWithImports(source: string, body: string): string {
	const file = ts.createSourceFile('e2e.test.ts', source, ts.ScriptTarget.ES2022, true);
	const imports = file.statements
		.filter(ts.isImportDeclaration)
		.map((statement) => statement.getText(file))
		.join('\n');
	return ts.transpileModule(`${imports}\n${body}`, {
		compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
	}).outputText;
}

describe('template e2e tests keep the global setTimeout callable', () => {
	it('covers at least one template', () => {
		assert.notDeepStrictEqual(templates, []);
	});

	for (const template of templates) {
		it(`${template}: setTimeout(cb, ms) works next to the template's imports`, () => {
			const source = readFileSync(join(templatesDir, template, 'test/e2e.test.ts'), 'utf-8');
			// Inside the package, so `@aws-blocks/*` imports resolve through the workspace's node_modules.
			const dir = mkdtempSync(join(packageDir, '.timers-check-'));
			try {
				const entry = join(dir, 'check.mjs');
				writeFileSync(
					entry,
					compiledWithImports(source, `await new Promise((resolve) => setTimeout(resolve, 1));\nprocess.stdout.write('ok');`),
				);
				const output = execFileSync(process.execPath, [entry], { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
				assert.strictEqual(output, 'ok');
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});
