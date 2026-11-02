import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import ts from 'typescript';

const templateDir = join(dirname(fileURLToPath(import.meta.url)), '../templates/auth-cognito');

type Todo = { todoId: string; title: string; completed: boolean; priority: number };
type Api = Record<string, (...args: unknown[]) => Promise<unknown>>;

let todos: Todo[] = [];
const api: Api = {
	listTodos: async () => todos.map((todo) => ({ ...todo })),
	fetchUserAttributes: async () => ({}),
	updateTodo: async () => {
		throw new Error('updateTodo not stubbed');
	},
	deleteTodo: async () => {
		throw new Error('deleteTodo not stubbed');
	},
	getLastCode: async () => null,
};

let workDir: string;
let window: Window;

async function settle() {
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function todoError(): HTMLElement {
	const el = document.querySelector<HTMLElement>('#todo-error [role="status"]');
	assert.ok(el, 'expected the todo status line to be mounted');
	return el;
}

function row(): HTMLElement {
	const el = document.querySelector<HTMLElement>('#todo-list .todo-item');
	assert.ok(el, 'expected one rendered todo row');
	return el;
}

// Compiles the template's real src/index.ts against its real index.html. Only the generated
// `aws-blocks` client is stubbed, plus the Authenticator widget and onAuthChange, which need a
// real auth backend. StatusMessage and injectTheme are the real primitives.
describe('auth-cognito template todo status line', () => {
	before(async () => {
		workDir = mkdtempSync(join(tmpdir(), 'auth-cognito-'));
		writeFileSync(
			join(workDir, 'aws-blocks.mjs'),
			[
				'export const api = new Proxy({}, { get: (_t, name) => (...args) => globalThis.__blocksApi[name](...args) });',
				'export const authApi = {};',
			].join('\n'),
		);
		writeFileSync(
			join(workDir, 'ui.mjs'),
			[
				`export { StatusMessage, injectTheme } from '${import.meta.resolve('@aws-blocks/blocks/ui')}';`,
				"export const Authenticator = () => document.createElement('div');",
				'export const onAuthChange = (_api, callback) => { globalThis.__blocksAuthChange = callback; };',
			].join('\n'),
		);

		window = new Window({ url: 'http://localhost/' });
		const html = readFileSync(join(templateDir, 'index.html'), 'utf8');
		const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('<script'));
		window.document.body.innerHTML = body;
		Object.assign(globalThis, {
			window,
			document: window.document,
			Event: window.Event,
			MouseEvent: window.MouseEvent,
			__blocksApi: api,
		});

		const specifiers: Record<string, string> = {
			'aws-blocks': pathToFileURL(join(workDir, 'aws-blocks.mjs')).href,
			'@aws-blocks/blocks/ui': pathToFileURL(join(workDir, 'ui.mjs')).href,
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
		await import(pathToFileURL(file).href);

		window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
		await settle();
		const authChange: unknown = Reflect.get(globalThis, '__blocksAuthChange');
		assert.ok(typeof authChange === 'function', 'expected the template to subscribe with onAuthChange');
		await authChange({ username: 'ada' });
		await settle();
	});

	after(async () => {
		await window.happyDOM.close();
		rmSync(workDir, { recursive: true, force: true });
	});

	it('reverts a failed toggle and shows the error', async () => {
		todos = [{ todoId: 't1', title: 'Write tests', completed: false, priority: 2 }];
		api.updateTodo = async () => {
			throw new Error('toggle failed');
		};
		document.querySelector<HTMLElement>('#todo-sort')?.dispatchEvent(new Event('change'));
		await settle();

		const checkbox = row().querySelector<HTMLInputElement>('input[type="checkbox"]');
		assert.ok(checkbox);
		checkbox.checked = true;
		checkbox.dispatchEvent(new Event('change'));
		await settle();

		assert.match(todoError().className, /bb-status-error/);
		assert.strictEqual(todoError().textContent, 'toggle failed');
		assert.strictEqual(row().querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked, false);
	});

	it('reverts a failed title edit and shows the error', async () => {
		api.updateTodo = async () => {
			throw new Error('title failed');
		};
		const title = row().querySelector<HTMLInputElement>('input.todo-title');
		assert.ok(title);
		title.value = 'Unsaved title';
		title.dispatchEvent(new Event('blur'));
		await settle();

		assert.strictEqual(todoError().textContent, 'title failed');
		assert.strictEqual(row().querySelector<HTMLInputElement>('input.todo-title')?.value, 'Write tests');
	});

	it('shows a failed delete, then clears the error on a successful one', async () => {
		const status = todoError();
		api.deleteTodo = async () => {
			throw new Error('delete failed');
		};
		row().querySelector<HTMLElement>('button')?.dispatchEvent(new MouseEvent('click'));
		await settle();
		assert.strictEqual(todoError().textContent, 'delete failed');
		assert.ok(document.querySelector('#todo-list .todo-item'), 'the todo should still be listed');

		api.deleteTodo = async () => {
			todos = [];
		};
		row().querySelector<HTMLElement>('button')?.dispatchEvent(new MouseEvent('click'));
		await settle();
		assert.match(todoError().className, /bb-status-idle/);
		assert.strictEqual(todoError().textContent, '');
		assert.strictEqual(document.querySelector('#todo-list .todo-item'), null);
		// The same live region throughout, so screen readers keep announcing it.
		assert.strictEqual(todoError(), status);
	});

	it('shows a failed last-code lookup as an error', async () => {
		api.getLastCode = async () => {
			throw new Error('lookup failed');
		};
		document.querySelector<HTMLElement>('#last-code-btn')?.dispatchEvent(new MouseEvent('click'));
		await settle();

		const status = document.querySelector<HTMLElement>('#last-code-result [role="status"]');
		assert.ok(status, 'expected an error line in the last-code result');
		assert.match(status.className, /bb-status-error/);
		assert.strictEqual(status.textContent, 'lookup failed');
	});
});
