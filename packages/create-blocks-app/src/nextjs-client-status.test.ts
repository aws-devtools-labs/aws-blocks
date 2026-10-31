import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { act, type ComponentType, createElement } from 'react';
import ts from 'typescript';

const clientSource = join(dirname(fileURLToPath(import.meta.url)), '../templates/nextjs/src/app/client.tsx');

type Greeting = { message: string; timestamp: number };
let greet: (name: string) => Promise<Greeting> = async () => {
	throw new Error('greet not stubbed');
};

let workDir: string;
let loads = 0;

// Compiles the template's real client.tsx. Only the generated `aws-blocks` client is stubbed;
// React and the StatusMessage primitive are the real packages. Each call returns a fresh module
// instance so the server render and the browser render each evaluate it in their own environment.
async function loadClientGreeting(): Promise<ComponentType> {
	const specifiers: Record<string, string> = {
		'aws-blocks': pathToFileURL(join(workDir, 'aws-blocks.mjs')).href,
		react: import.meta.resolve('react'),
		'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'),
		'@aws-blocks/blocks/theme': import.meta.resolve('@aws-blocks/blocks/theme'),
		'@aws-blocks/blocks/ui': import.meta.resolve('@aws-blocks/blocks/ui'),
	};
	const { outputText } = ts.transpileModule(readFileSync(clientSource, 'utf8'), {
		compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
	});
	const code = outputText.replace(/from (['"])([^'"]+)\1/g, (_match, _quote, specifier: string) => {
		const url = specifiers[specifier];
		assert.ok(url, `client.tsx imports '${specifier}', which this test does not map`);
		return `from '${url}'`;
	});
	const file = join(workDir, `client-${++loads}.mjs`);
	writeFileSync(file, code);
	const mod: { ClientGreeting: ComponentType } = await import(pathToFileURL(file).href);
	return mod.ClientGreeting;
}

describe('Next.js template ClientGreeting status line', () => {
	before(() => {
		workDir = mkdtempSync(join(tmpdir(), 'nextjs-client-'));
		writeFileSync(
			join(workDir, 'aws-blocks.mjs'),
			'export const api = { greet: (name) => globalThis.__blocksGreetStub(name) };\n',
		);
		Object.assign(globalThis, { __blocksGreetStub: (name: string) => greet(name) });
	});

	after(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	// Runs first, before any DOM globals exist, the same as a Next.js server render.
	it('renders on the server without a DOM, leaving the status line to the browser', async () => {
		assert.strictEqual(typeof document, 'undefined');
		const { renderToString } = await import('react-dom/server');
		const ClientGreeting = await loadClientGreeting();

		const html = renderToString(createElement(ClientGreeting));

		assert.match(html, /Greet/);
		assert.doesNotMatch(html, /greet-status/);
	});

	it('shows a failed greet as an error and clears it on the next success', async () => {
		const window = new Window({ url: 'http://localhost/' });
		Object.assign(globalThis, {
			window,
			document: window.document,
			HTMLElement: window.HTMLElement,
			HTMLInputElement: window.HTMLInputElement,
			Event: window.Event,
			MouseEvent: window.MouseEvent,
			IS_REACT_ACT_ENVIRONMENT: true,
		});
		const { createRoot } = await import('react-dom/client');
		const ClientGreeting = await loadClientGreeting();

		const container = document.createElement('div');
		document.body.appendChild(container);
		const root = createRoot(container);
		await act(async () => root.render(createElement(ClientGreeting)));

		const status = container.querySelector('[data-testid="greet-status"]');
		const input = container.querySelector('input');
		const button = container.querySelector('button');
		assert.ok(status && input && button, 'expected the status line, the name input and the Greet button');

		// React tracks controlled inputs through the prototype setter, not the instance property.
		await act(async () => {
			Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set?.call(input, 'Ada');
			input.dispatchEvent(new Event('input', { bubbles: true }));
		});

		async function clickGreet() {
			await act(async () => {
				button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		}

		greet = async () => {
			throw new Error('boom');
		};
		await clickGreet();
		assert.match(status.className, /bb-status-error/);
		assert.strictEqual(status.textContent, 'Could not greet: boom');
		assert.strictEqual(container.querySelector('pre'), null);

		greet = async (name) => ({ message: `Hello, ${name}!`, timestamp: 1 });
		await clickGreet();
		assert.match(status.className, /bb-status-idle/);
		assert.strictEqual(status.textContent, '');
		assert.match(container.querySelector('pre')?.textContent ?? '', /Hello, Ada!/);

		greet = async () => {
			throw new Error('again');
		};
		await clickGreet();
		assert.strictEqual(status.textContent, 'Could not greet: again');
		assert.strictEqual(
			container.querySelector('pre'),
			null,
			'a failure should not leave the earlier greeting on screen',
		);

		// The same node throughout: re-renders never remount the live region.
		assert.strictEqual(container.querySelector('[data-testid="greet-status"]'), status);

		await act(async () => root.unmount());
		assert.strictEqual(status.isConnected, false);
		await window.happyDOM.close();
	});
});
