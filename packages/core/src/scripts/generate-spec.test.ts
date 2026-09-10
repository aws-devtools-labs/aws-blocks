/**
 * Integration test for `generateSpec`. Builds a tiny backend file with one
 * normal method and one `@blocksSkipCodegen`-tagged method, runs the spec
 * emitter, and asserts the tagged method is dropped from the OpenRPC
 * document.
 *
 * Uses a `.js` foundation file so plain `node --test dist/...` can run the
 * test without a TypeScript loader. The TS compiler still parses JSDoc on
 * the `.js` file when `allowJs` is enabled in the synthetic tsconfig.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { generateSpec } from './generate-spec.js';
import { ApiNamespace } from '../api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// `import.meta.url` lives in dist/scripts/, so `..` is dist/ and the built
// `api.js` is next to it. Re-using the real ApiNamespace ensures the marker
// symbol matches what `generateSpec` discovers.
const builtApiUrl = pathToFileURL(join(__dirname, '..', 'api.js')).href;

function writeTsconfig(dir: string): void {
	writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
		compilerOptions: {
			target: 'ESNext',
			module: 'ESNext',
			moduleResolution: 'bundler',
			allowJs: true,
			esModuleInterop: true,
			skipLibCheck: true,
		},
	}));
}

describe('generateSpec — @blocksSkipCodegen', () => {
	it('drops methods carrying @blocksSkipCodegen from the OpenRPC document', async () => {
		const dir = join(tmpdir(), `blocks-spec-test-${Date.now()}-skip`);
		mkdirSync(dir, { recursive: true });
		writeTsconfig(dir);

		writeFileSync(join(dir, 'index.js'), `
			import { ApiNamespace } from ${JSON.stringify(builtApiUrl)};

			export const api = new ApiNamespace(null, 'api', (context) => ({
				async normalMethod(name) {
					return { greeting: 'hi ' + name };
				},

				/**
				 * Mock-only helper.
				 * @blocksSkipCodegen
				 */
				async getLastCode() {
					return null;
				},
			}));
		`);

		try {
			const doc = await generateSpec(join(dir, 'index.js'));
			const methodNames = doc.methods.map((m) => m.name).sort();
			assert.deepStrictEqual(
				methodNames,
				['api.normalMethod'],
				'getLastCode should be omitted; only normalMethod should remain',
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('keeps methods that do not carry the tag', async () => {
		const dir = join(tmpdir(), `blocks-spec-test-${Date.now()}-keep`);
		mkdirSync(dir, { recursive: true });
		writeTsconfig(dir);

		writeFileSync(join(dir, 'index.js'), `
			import { ApiNamespace } from ${JSON.stringify(builtApiUrl)};

			export const api = new ApiNamespace(null, 'api', (context) => ({
				/** Plain JSDoc with no special tag. */
				async ping() { return { ok: true }; },
				async echo(s) { return s; },
			}));
		`);

		try {
			const doc = await generateSpec(join(dir, 'index.js'));
			const methodNames = doc.methods.map((m) => m.name).sort();
			assert.deepStrictEqual(methodNames, ['api.echo', 'api.ping']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('generateSpec — namespaces sharing a method name (regression: #445)', () => {
	it('emits each namespace its OWN schema for a same-named method', async () => {
		const dir = join(tmpdir(), `blocks-spec-test-${Date.now()}-collision`);
		mkdirSync(dir, { recursive: true });
		writeTsconfig(dir);

		// Typed foundation for the TS type extractor. `create` has DIFFERENT params
		// in each namespace; binding names (widgets/subscriptions) match the runtime
		// module's export names below.
		writeFileSync(join(dir, 'index.ts'), `
			interface ApiNamespaceConstructor { new <T>(scope: any, name: string, handler: (ctx: any) => T): T; }
			const ApiNamespace: ApiNamespaceConstructor = class {} as any;

			export const widgets = new ApiNamespace(null, 'widgets', () => ({
				async create(label: string): Promise<{ widgetId: string }> { return { widgetId: 'w' }; },
			}));
			export const subscriptions = new ApiNamespace(null, 'subscriptions', () => ({
				async create(topicCount: number): Promise<{ subId: number }> { return { subId: 1 }; },
			}));
		`);

		// Runtime module for namespace discovery (types come from the .ts above via
		// the extractor). Use the real ApiNamespace so the marker symbol matches.
		const widgets = new ApiNamespace(null as any, 'widgets', () => ({ async create(_label: string) { return { widgetId: 'w' }; } }));
		const subscriptions = new ApiNamespace(null as any, 'subscriptions', () => ({ async create(_topicCount: number) { return { subId: 1 }; } }));
		const loader = async () => ({ widgets, subscriptions }) as Record<string, unknown>;

		try {
			const doc = await generateSpec(join(dir, 'index.ts'), loader);
			const byName = new Map(doc.methods.map((m) => [m.name, m]));

			const w = byName.get('widgets.create');
			const s = byName.get('subscriptions.create');
			assert.ok(w && s, 'both namespace-qualified methods should be present');

			// Each keeps its OWN param — no cross-assignment.
			assert.strictEqual(w!.params[0]?.name, 'label');
			assert.strictEqual((w!.params[0] as any)?.schema?.type, 'string');
			assert.strictEqual(s!.params[0]?.name, 'topicCount');
			assert.strictEqual((s!.params[0] as any)?.schema?.type, 'number');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
