// The scaffolded AGENTS.md (resources/AGENTS.md) carries a polling snippet that
// coding agents copy into generated apps. These tests pull that snippet out of
// the doc, typecheck it against a stand-in for the generated `aws-blocks`
// client, and run it against a fake `document`, so the guidance can't drift
// into code that doesn't compile or polls unsafely.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const guidePath = join(__dirname, '..', 'resources', 'AGENTS.md');

function pollSnippet(): string {
	const guide = readFileSync(guidePath, 'utf-8');
	const blocks = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]);
	const snippet = blocks.find((code) => code.startsWith('// src/poll.ts'));
	assert.ok(snippet, 'AGENTS.md has a ```ts block starting with // src/poll.ts');
	return snippet;
}

// The generated client types each method from the backend; this stands in for
// an app whose backend defines `getDashboard(): Promise<{ open: number }>`.
const CLIENT_DECLARATION = "declare module 'aws-blocks' {\n\texport const api: { getDashboard(): Promise<{ open: number }> };\n}\n";

describe('scaffolded AGENTS.md polling snippet', () => {
	it('typechecks under strict settings against the typed client', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cba-poll-tsc-'));
		try {
			writeFileSync(join(dir, 'poll.ts'), pollSnippet());
			writeFileSync(join(dir, 'aws-blocks.d.ts'), CLIENT_DECLARATION);
			const program = ts.createProgram([join(dir, 'poll.ts'), join(dir, 'aws-blocks.d.ts')], {
				strict: true,
				noEmit: true,
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.ESNext,
				moduleResolution: ts.ModuleResolutionKind.Bundler,
				lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
				types: [],
				skipLibCheck: true,
			});
			const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
			assert.deepStrictEqual(diagnostics, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	describe('behavior', () => {
		type Poll = (render: (data: { open: number }) => void, intervalMs?: number) => () => void;
		let dir: string;
		let pollDashboard: Poll;
		const state = globalThis as unknown as {
			document: EventTarget & { visibilityState: 'visible' | 'hidden' };
			__getDashboard: () => Promise<{ open: number }>;
		};
		const savedDocument = (globalThis as { document?: unknown }).document;

		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const setVisibility = (value: 'visible' | 'hidden') => {
			state.document.visibilityState = value;
			state.document.dispatchEvent(new Event('visibilitychange'));
		};

		before(async () => {
			dir = mkdtempSync(join(tmpdir(), 'cba-poll-run-'));
			const js = ts.transpileModule(pollSnippet(), {
				compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
			}).outputText.replace("from 'aws-blocks'", "from './aws-blocks.mjs'");
			writeFileSync(join(dir, 'poll.mjs'), js);
			writeFileSync(join(dir, 'aws-blocks.mjs'), 'export const api = { getDashboard: () => globalThis.__getDashboard() };\n');
			pollDashboard = (await import(pathToFileURL(join(dir, 'poll.mjs')).href)).pollDashboard;
		});

		after(() => {
			(globalThis as { document?: unknown }).document = savedDocument;
			rmSync(dir, { recursive: true, force: true });
		});

		function freshDocument(): void {
			state.document = Object.assign(new EventTarget(), { visibilityState: 'visible' as 'visible' | 'hidden' });
		}

		it('never has more than one call in flight when a call is slower than the interval', async () => {
			freshDocument();
			let inFlight = 0;
			let maxInFlight = 0;
			let calls = 0;
			state.__getDashboard = async () => {
				calls++;
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await sleep(60);
				inFlight--;
				return { open: calls };
			};
			const stop = pollDashboard(() => {}, 5);
			await sleep(250);
			setVisibility('hidden');
			setVisibility('visible'); // a visibility flip mid-call must not start a second call
			await sleep(100);
			stop();
			assert.strictEqual(maxInFlight, 1);
			assert.ok(calls >= 2, `expected repeated calls, got ${calls}`);
		});

		it('pauses while hidden and refreshes immediately when visible again', async () => {
			freshDocument();
			let calls = 0;
			state.__getDashboard = async () => {
				calls++;
				return { open: calls };
			};
			const stop = pollDashboard(() => {}, 10);
			await sleep(50);
			setVisibility('hidden');
			await sleep(20); // let any call already in flight settle
			const whileHidden = calls;
			await sleep(100);
			assert.strictEqual(calls, whileHidden, 'no calls while hidden');
			setVisibility('visible');
			await sleep(1);
			assert.strictEqual(calls, whileHidden + 1, 'one immediate call on becoming visible');
			stop();
		});

		it('stops on dispose and drops a response that arrives afterwards', async () => {
			freshDocument();
			let calls = 0;
			const rendered: number[] = [];
			state.__getDashboard = async () => {
				calls++;
				await sleep(40);
				return { open: calls };
			};
			const stop = pollDashboard((data) => rendered.push(data.open), 10);
			await sleep(10); // first call is in flight
			stop();
			await sleep(150);
			assert.strictEqual(calls, 1, 'no call after dispose');
			assert.deepStrictEqual(rendered, [], 'the late response is not rendered');
		});

		it('backs off after errors', async () => {
			freshDocument();
			const startedAt: number[] = [];
			state.__getDashboard = async () => {
				startedAt.push(Date.now());
				throw new Error('backend down');
			};
			const stop = pollDashboard(() => {}, 10);
			await sleep(400);
			stop();
			// Delays double from 20 ms: about 4 calls fit in 400 ms, against 40 with a fixed 10 ms interval.
			assert.ok(startedAt.length >= 3 && startedAt.length <= 6, `expected backoff, got ${startedAt.length} calls`);
			const gaps = startedAt.slice(1).map((t, i) => t - startedAt[i]);
			assert.ok(gaps[gaps.length - 1] > gaps[0], `gaps should grow: ${gaps.join(', ')}`);
		});
	});
});
