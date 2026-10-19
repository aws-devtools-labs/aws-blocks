// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { type EndpointResolution, type ResolveEndpointOptions, resolveRpcEndpoint } from './rpc-endpoint.js';

let tmpDir: string | undefined;

/** A temp project tree. Keys are project-relative paths; dirs are created. */
function makeProject(files: Record<string, string>): string {
	tmpDir = join(tmpdir(), `admin-ui-rpc-endpoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpDir, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(tmpDir, rel);
		mkdirSync(join(full, '..'), { recursive: true });
		writeFileSync(full, content);
	}
	return tmpDir;
}

afterEach(() => {
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	tmpDir = undefined;
});

/** A project with both stack names resolvable: `blocks-app-prod` and `blocks-app-alice-abc123`. */
function deployedProject(extra: Record<string, string> = {}): string {
	return makeProject({
		'.blocks/config.json': JSON.stringify({ stackId: 'blocks-app' }),
		'.blocks-sandbox/sandbox-id.txt': 'alice-abc123\n',
		...extra,
	});
}

/** Seams that fail loudly, so a test only reaches the source it means to. */
const forbiddenSeams = {
	describeStackOutputs: () => {
		throw new Error('describeStackOutputs must not be consulted here');
	},
	readSandboxConfig: (): string | undefined => {
		throw new Error('readSandboxConfig must not be consulted here');
	},
} satisfies Pick<ResolveEndpointOptions, 'describeStackOutputs' | 'readSandboxConfig'>;

/** Stack outputs, injected — no AWS call, ever. */
function outputs(record: Record<string, string>): ResolveEndpointOptions['describeStackOutputs'] {
	return () => Promise.resolve(record);
}

function assertOk(resolution: EndpointResolution): Extract<EndpointResolution, { ok: true }> {
	assert.strictEqual(resolution.ok, true, `expected ok, got: ${JSON.stringify(resolution)}`);
	return resolution as Extract<EndpointResolution, { ok: true }>;
}

function assertNoEndpoint(resolution: EndpointResolution): string {
	assert.strictEqual(resolution.ok, false, `expected NO_ENDPOINT, got: ${JSON.stringify(resolution)}`);
	const failure = resolution as Extract<EndpointResolution, { ok: false }>;
	assert.strictEqual(failure.code, 'NO_ENDPOINT');
	return failure.message;
}

/** Resolve a cloud endpoint from an injected `ApiUrl` output. */
function resolveWithApiUrl(projectRoot: string, apiUrl: string): Promise<EndpointResolution> {
	return resolveRpcEndpoint({
		projectRoot,
		stage: 'sandbox',
		mode: 'cloud',
		describeStackOutputs: outputs({ ApiUrl: apiUrl }),
		readSandboxConfig: forbiddenSeams.readSandboxConfig,
	});
}

describe('resolveRpcEndpoint — local mode', () => {
	it('uses the port discovered in the app server script', async () => {
		const root = deployedProject({
			'aws-blocks/scripts/server.ts': 'startDevServer({\n\tbackendPath: x,\n\tport: 4321,\n});\n',
		});
		const result = assertOk(await resolveRpcEndpoint({ projectRoot: root, stage: 'sandbox', mode: 'local' }));
		assert.strictEqual(result.endpoint, 'http://localhost:4321/aws-blocks/api');
		assert.strictEqual(result.source, 'local-dev-server');
	});

	it('falls back to port 3000 when no server script names one', async () => {
		const root = makeProject({});
		const result = assertOk(await resolveRpcEndpoint({ projectRoot: root, stage: 'sandbox', mode: 'local' }));
		assert.strictEqual(result.endpoint, 'http://localhost:3000/aws-blocks/api');
	});

	it('appends exactly the /aws-blocks/api RPC prefix', async () => {
		const root = makeProject({});
		const result = assertOk(await resolveRpcEndpoint({ projectRoot: root, stage: 'production', mode: 'local' }));
		assert.ok(result.endpoint.endsWith('/aws-blocks/api'), result.endpoint);
		assert.strictEqual(new URL(result.endpoint).pathname, '/aws-blocks/api');
	});

	it('consults no cloud source at all, even when both would answer', async () => {
		const root = deployedProject({
			'.blocks-sandbox/config.json': JSON.stringify({ apiUrl: 'https://stale.example.com/x' }),
		});
		const result = assertOk(
			await resolveRpcEndpoint({ projectRoot: root, stage: 'sandbox', mode: 'local', ...forbiddenSeams }),
		);
		assert.strictEqual(result.endpoint, 'http://localhost:3000/aws-blocks/api');
	});
});

describe('resolveRpcEndpoint — cloud mode precedence', () => {
	it('resolves from the stack ApiUrl output', async () => {
		const root = deployedProject();
		const result = assertOk(
			await resolveWithApiUrl(root, 'https://abc.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api'),
		);
		assert.strictEqual(result.endpoint, 'https://abc.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api');
		assert.strictEqual(result.source, 'stack-output');
	});

	it('prefers the stack output over the sandbox config when both exist', async () => {
		const root = deployedProject();
		const result = assertOk(
			await resolveRpcEndpoint({
				projectRoot: root,
				stage: 'sandbox',
				mode: 'cloud',
				describeStackOutputs: outputs({ ApiUrl: 'https://fresh.example.com/aws-blocks/api' }),
				readSandboxConfig: () => 'https://stale.example.com/aws-blocks/api',
			}),
		);
		assert.strictEqual(result.endpoint, 'https://fresh.example.com/aws-blocks/api');
		assert.strictEqual(result.source, 'stack-output');
	});

	it('falls back to the sandbox config when the stack publishes no ApiUrl, reporting that source', async () => {
		const root = deployedProject();
		const result = assertOk(
			await resolveRpcEndpoint({
				projectRoot: root,
				stage: 'sandbox',
				mode: 'cloud',
				describeStackOutputs: outputs({ SomethingElse: 'https://nope.example.com' }),
				readSandboxConfig: () => 'https://from-file.example.com/aws-blocks/api',
			}),
		);
		assert.strictEqual(result.endpoint, 'https://from-file.example.com/aws-blocks/api');
		assert.strictEqual(result.source, 'sandbox-config');
	});

	it('passes the stage stack name and region through to the lookup', async () => {
		const root = deployedProject();
		const seen: Array<[string, string | undefined]> = [];
		await resolveRpcEndpoint({
			projectRoot: root,
			stage: 'production',
			mode: 'cloud',
			region: 'eu-west-1',
			describeStackOutputs: (stackName, region) => {
				seen.push([stackName, region]);
				return Promise.resolve({ ApiUrl: 'https://p.example.com/aws-blocks/api' });
			},
			readSandboxConfig: forbiddenSeams.readSandboxConfig,
		});
		assert.deepStrictEqual(seen, [['blocks-app-prod', 'eu-west-1']]);
	});

	it('uses the sandbox stack name for the sandbox stage', async () => {
		const root = deployedProject();
		const seen: string[] = [];
		await resolveRpcEndpoint({
			projectRoot: root,
			stage: 'sandbox',
			mode: 'cloud',
			describeStackOutputs: (stackName) => {
				seen.push(stackName);
				return Promise.resolve({ ApiUrl: 'https://s.example.com/aws-blocks/api' });
			},
			readSandboxConfig: forbiddenSeams.readSandboxConfig,
		});
		assert.deepStrictEqual(seen, ['blocks-app-alice-abc123']);
	});
});

describe('resolveRpcEndpoint — NO_ENDPOINT', () => {
	it('names the stack when it is not deployed', async () => {
		const root = deployedProject();
		const message = assertNoEndpoint(
			await resolveRpcEndpoint({
				projectRoot: root,
				stage: 'sandbox',
				mode: 'cloud',
				describeStackOutputs: () =>
					Promise.reject(new Error('Stack with id blocks-app-alice-abc123 does not exist')),
				readSandboxConfig: () => undefined,
			}),
		);
		assert.match(message, /blocks-app-alice-abc123/);
		assert.match(message, /not deployed/);
		assert.match(message, /local mode/);
	});

	it('reports a throwing stack lookup instead of propagating it', async () => {
		const root = deployedProject();
		const message = assertNoEndpoint(
			await resolveRpcEndpoint({
				projectRoot: root,
				stage: 'production',
				mode: 'cloud',
				describeStackOutputs: () => Promise.reject(new Error('ExpiredToken: the security token expired')),
				readSandboxConfig: forbiddenSeams.readSandboxConfig,
			}),
		);
		assert.match(message, /blocks-app-prod/);
		assert.match(message, /ExpiredToken/);
	});

	it('reports a stack with neither an ApiUrl output nor a sandbox config', async () => {
		const root = deployedProject();
		const message = assertNoEndpoint(
			await resolveRpcEndpoint({
				projectRoot: root,
				stage: 'sandbox',
				mode: 'cloud',
				describeStackOutputs: outputs({}),
				readSandboxConfig: () => undefined,
			}),
		);
		assert.match(message, /blocks-app-alice-abc123/);
		assert.match(message, /ApiUrl/);
		assert.match(message, /local mode/);
	});

	it('explains an unresolvable stack name and what would fix it', async () => {
		const root = makeProject({ 'package.json': '{ not json' });
		const message = assertNoEndpoint(
			await resolveRpcEndpoint({ projectRoot: root, stage: 'production', mode: 'cloud', ...forbiddenSeams }),
		);
		assert.match(message, /stage "production"/);
		assert.match(message, /\.blocks\/config\.json/);
	});

	it('rejects a stage that has no stack', async () => {
		const root = deployedProject();
		const message = assertNoEndpoint(
			await resolveRpcEndpoint({ projectRoot: root, stage: 'staging', mode: 'cloud', ...forbiddenSeams }),
		);
		assert.match(message, /stage "staging"/);
		assert.match(message, /sandbox.*production|production.*sandbox/);
	});
});

describe('resolveRpcEndpoint — validation of the resolved value', () => {
	it('quotes a malformed stack output rather than passing it through', async () => {
		const root = deployedProject();
		const message = assertNoEndpoint(await resolveWithApiUrl(root, 'not a url at all'));
		assert.match(message, /"not a url at all"/);
		assert.match(message, /ApiUrl/);
	});

	it('quotes an empty-ish stack output by falling through and reporting the stack', async () => {
		const root = deployedProject();
		const message = assertNoEndpoint(
			await resolveRpcEndpoint({
				projectRoot: root,
				stage: 'sandbox',
				mode: 'cloud',
				describeStackOutputs: outputs({ ApiUrl: '   ' }),
				readSandboxConfig: () => undefined,
			}),
		);
		assert.match(message, /ApiUrl/);
	});

	it('accepts https to an external host', async () => {
		const root = deployedProject();
		const result = assertOk(await resolveWithApiUrl(root, 'https://api.example.com/prod/aws-blocks/api'));
		assert.strictEqual(result.endpoint, 'https://api.example.com/prod/aws-blocks/api');
	});

	it('rejects http to an external host', async () => {
		const root = deployedProject();
		const message = assertNoEndpoint(await resolveWithApiUrl(root, 'http://api.example.com/prod/aws-blocks/api'));
		assert.match(message, /cleartext/);
		assert.match(message, /api\.example\.com/);
	});

	it('accepts http to a loopback host', async () => {
		const root = deployedProject();
		for (const host of ['localhost', '127.0.0.1', '127.0.0.53', '[::1]']) {
			const url = `http://${host}:3000/aws-blocks/api`;
			const result = assertOk(await resolveWithApiUrl(root, url));
			assert.strictEqual(result.endpoint, url);
		}
	});

	it('rejects a non-http scheme', async () => {
		const root = deployedProject();
		for (const url of ['file:///etc/passwd', 'ftp://files.example.com/x', 'data:text/plain,x']) {
			const message = assertNoEndpoint(await resolveWithApiUrl(root, url));
			assert.match(message, /only http and https/);
			assert.match(message, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
		}
	});

	it('validates a sandbox-config value on the same rules as a stack output', async () => {
		const root = deployedProject();
		const message = assertNoEndpoint(
			await resolveRpcEndpoint({
				projectRoot: root,
				stage: 'sandbox',
				mode: 'cloud',
				describeStackOutputs: outputs({}),
				readSandboxConfig: () => 'http://api.example.com/aws-blocks/api',
			}),
		);
		assert.match(message, /cleartext/);
		assert.match(message, /config\.json/);
	});
});
