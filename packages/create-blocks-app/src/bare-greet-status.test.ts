import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import ts from 'typescript';

const templateDir = join(dirname(fileURLToPath(import.meta.url)), '../templates/bare');

let workDir: string;
let window: Window;

// Compiles the template's real src/index.ts against its real index.html. The generated `aws-blocks`
// client is stubbed to fail, and lit-html is stubbed because only the success path renders with it.
// StatusMessage is the real primitive.
describe('bare template greet status line', () => {
	before(() => {
		workDir = mkdtempSync(join(tmpdir(), 'bare-'));
		writeFileSync(
			join(workDir, 'aws-blocks.mjs'),
			"export const api = { greet: async () => { throw new Error('boom'); } };\n",
		);
		writeFileSync(
			join(workDir, 'lit-html.mjs'),
			"export const html = () => null;\nexport const render = () => { throw new Error('render should not run on failure'); };\n",
		);

		window = new Window({ url: 'http://localhost/' });
		const html = readFileSync(join(templateDir, 'index.html'), 'utf8');
		window.document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('<script'));
		Object.assign(globalThis, { window, document: window.document });
	});

	after(async () => {
		await window.happyDOM.close();
		rmSync(workDir, { recursive: true, force: true });
	});

	it('shows a failed greet as an error instead of a blank page', async () => {
		const specifiers: Record<string, string> = {
			'aws-blocks': pathToFileURL(join(workDir, 'aws-blocks.mjs')).href,
			'lit-html': pathToFileURL(join(workDir, 'lit-html.mjs')).href,
			'@aws-blocks/blocks/ui': import.meta.resolve('@aws-blocks/blocks/ui'),
		};
		const { outputText } = ts.transpileModule(readFileSync(join(templateDir, 'src/index.ts'), 'utf8'), {
			compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
		});
		const code = outputText.replace(/from (['"])([^'"]+)\1/g, (_match, _quote, specifier: string) => {
			const url = specifiers[specifier];
			assert.ok(url, `index.ts imports '${specifier}', which this test does not map`);
			return `from '${url}'`;
		});
		const file = join(workDir, 'index.mjs');
		writeFileSync(file, code);

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			await import(pathToFileURL(file).href);
			for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}

		assert.deepStrictEqual(unhandled, []);
		const status = document.querySelector<HTMLElement>('#app [data-testid="greet-status"]');
		assert.ok(status, 'expected an error line in #app');
		assert.strictEqual(status.getAttribute('role'), 'status');
		assert.match(status.className, /bb-status-error/);
		assert.strictEqual(status.textContent, 'Could not greet: boom');
	});
});
