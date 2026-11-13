// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `deploy()` and `startSandbox()` run the pre-deploy hooks an installed package
 * declares, on the assembly they just synthesized, and a stop ends the command
 * before `cdk deploy`. Each runs in a fresh process against a fixture app whose
 * only dependency is a fake `@aws-blocks/*` package with a
 * hook. Only the steps that reach AWS or spawn CDK are replaced; the fake CDK
 * synth writes a one-stack assembly.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { OUTPUTS_FILE } from './deploy-outputs.js';

const scripts = new URL('./', import.meta.url).href;

/** What the fake hook saw. */
interface HookCall {
	stage: string;
	invocation?: string;
	account?: { id: string | null; plan: string | null };
	stacks: Array<{ stackName: string; account?: string; resources: string[] }>;
}

interface Run {
	/** The CDK steps, in order: `synth`, `deploy`. */
	steps: string[];
	/** `deployed`, or the message of the error the command threw. */
	outcome: string;
	hook?: HookCall;
	/** The fixture's stderr, where warnings go. */
	stderr: string;
}

/** Shared by both fixtures: mocks for the steps that reach AWS, and the fake assembly. */
const prelude = (accountPlan: string) => `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';

const scripts = ${JSON.stringify(scripts)};
const moduleUrl = (name) => new URL(name + '.js', scripts).href;
// Imports are dynamic: mock.module applies only to modules imported after it.
const replace = async (url, overrides) => {
  const real = await import(url);
  mock.module(url, { namedExports: { ...real, ...overrides } });
};
await replace(moduleUrl('preflight-credentials'), {
  assertAwsCredentials: async () => ({ accountPlan: '${accountPlan}', account: '123456789012' }),
});
await replace(moduleUrl('ensure-secrets'), {
  ensureSecrets: async () => ({ created: [], updated: [] }),
  loadProductionEnv: () => {},
  loadEnvFile: () => {},
});
await replace(moduleUrl('external-migrations-step'), { applyExternalMigrations: async () => {} });
await replace(moduleUrl('deploy-client-codegen'), { generateDeployClient: async () => {} });
await replace(new URL('../telemetry/trackCommand.js', scripts).href, { trackCommand: async (_name, fn) => fn() });
const steps = [];
const fakeCdk = async (args, outputsFile) => {
  if (args.includes('synth')) {
    steps.push('synth');
    const out = args[args.indexOf('--output') + 1];
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'manifest.json'), JSON.stringify({ artifacts: { App: {
      type: 'aws:cloudformation:stack',
      environment: 'aws://123456789012/eu-north-1',
      properties: { templateFile: 'App.template.json', stackName: 'demo' },
    } } }));
    writeFileSync(join(out, 'App.template.json'), JSON.stringify({ Resources: { Queue: { Type: 'AWS::SQS::Queue' } } }));
    return;
  }
  steps.push('deploy');
  mkdirSync('.blocks-sandbox', { recursive: true });
  writeFileSync(outputsFile, JSON.stringify({ demo: { ApiUrl: 'https://api.example/' } }));
};
const report = (outcome) => console.log('RESULT ' + JSON.stringify({ steps, outcome }));
`;

const deployFixture = (accountPlan: string) => `${prelude(accountPlan)}
await replace(moduleUrl('deploy-stream'), {
  runStreaming: async (_command, args) => fakeCdk(args, ${JSON.stringify(OUTPUTS_FILE.production)}),
});
const { deploy } = await import(moduleUrl('deploy'));
report(await deploy({ cdkAppPath: 'unused', projectRoot: process.cwd() }).then(() => 'deployed', (error) => error.message));
`;

const sandboxFixture = (accountPlan: string) => `${prelude(accountPlan)}
await replace(moduleUrl('cdk-output'), {
  createCdkOutput: () => ({
    level: 'normal',
    curated: false,
    run: async (_command, args) => fakeCdk(args, '.blocks-sandbox/outputs.json'),
    printRetained: () => {},
  }),
});
const { startSandbox } = await import(moduleUrl('sandbox'));
report(await startSandbox({ backendPath: 'aws-blocks/index.cdk.ts', deployOnly: true }).then(() => 'deployed', (error) => error.message));
`;

/** The fake package's hook: records what it received; it stops when the account plan is `FREE`, otherwise it warns. */
const HOOK = `
import { writeFileSync } from 'node:fs';
export async function predeploy(context) {
  const stacks = (await context.synth()).map((s) => ({
    stackName: s.stackName,
    account: s.account,
    resources: Object.keys(s.template.Resources ?? {}),
  }));
  const { stage, invocation, account } = context;
  writeFileSync('hook-call.json', JSON.stringify({ stage, invocation, account, stacks }));
  if (account?.plan === 'FREE') return { stops: [\`\${invocation} stopped before deploying: demo guard\`] };
  return { warnings: ['demo guard warning'] };
}
`;

function run(fixture: string): Run {
	const dir = mkdtempSync(join(tmpdir(), 'blocks-predeploy-wiring-'));
	try {
		writeFileSync(
			join(dir, 'package.json'),
			JSON.stringify({ name: 'app', dependencies: { '@aws-blocks/bb-demo-guard': '*' } }),
		);
		const pkg = join(dir, 'node_modules', '@aws-blocks', 'bb-demo-guard');
		mkdirSync(pkg, { recursive: true });
		writeFileSync(
			join(pkg, 'package.json'),
			JSON.stringify({
				name: '@aws-blocks/bb-demo-guard',
				type: 'module',
				exports: { '.': './index.js' },
				'aws-blocks': { predeploy: { module: './predeploy.js' } },
			}),
		);
		writeFileSync(join(pkg, 'index.js'), 'export {};\n');
		writeFileSync(join(pkg, 'predeploy.js'), HOOK);
		const child = spawnSync(
			process.execPath,
			['--experimental-test-module-mocks', '--input-type=module', '-e', fixture],
			{
				cwd: dir,
				env: {
					PATH: process.env.PATH,
					HOME: dir,
					AWS_BLOCKS_DISABLE_TELEMETRY: '1',
					BLOCKS_LOG_LEVEL: 'normal',
				},
				encoding: 'utf8',
				timeout: 15_000,
			},
		);
		assert.equal(child.status, 0, child.stderr);
		const line = child.stdout.split('\n').find((l) => l.startsWith('RESULT '));
		assert.ok(line, child.stdout);
		const result: Run = { ...JSON.parse(line.slice('RESULT '.length)), stderr: child.stderr };
		try {
			result.hook = JSON.parse(readFileSync(join(dir, 'hook-call.json'), 'utf-8'));
		} catch {
			// The hook did not run.
		}
		return result;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const stacks = [{ stackName: 'demo', account: '123456789012', resources: ['Queue'] }];

for (const [command, fixture, stage, invocation] of [
	['deploy', deployFixture, 'production', 'npm run deploy'],
	['sandbox', sandboxFixture, 'sandbox', 'npm run sandbox'],
] as const) {
	describe(`${command} — pre-deploy hooks`, () => {
		it('runs the hook on the synthesized assembly, then deploys it', () => {
			const { steps, outcome, hook, stderr } = run(fixture('PAID'));
			assert.deepEqual(steps, ['synth', 'deploy']);
			assert.equal(outcome, 'deployed');
			assert.deepEqual(hook, { stage, invocation, account: { id: '123456789012', plan: 'PAID' }, stacks });
			assert.match(stderr, /^\[@aws-blocks\/bb-demo-guard\] demo guard warning$/m);
		});

		it('stops after synth, before cdk deploy, when the hook returns a stop', () => {
			const { steps, outcome, hook } = run(fixture('FREE'));
			assert.deepEqual(steps, ['synth']);
			assert.equal(outcome, `[@aws-blocks/bb-demo-guard] ${invocation} stopped before deploying: demo guard`);
			assert.equal(hook?.stage, stage);
		});
	});
}
