// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { CORE_VERSION } from '@aws-blocks/core/version';
import { Agent } from './agent.aws.js';
import { BB_NAME, BB_VERSION } from './version.js';

/** Verifies both Bedrock SDK clients carry the buildUserAgentChain() user agent. */

class ParentAuthBB extends Scope {
	constructor(parent: ScopeParent, id: string) {
		super(id, { parent, bbName: 'AuthBasic', bbVersion: '1.0.1' });
	}
}

interface CapturedRequest { method?: string; url?: string; userAgent: string }

const ENV_KEYS = ['AWS_ENDPOINT_URL', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'] as const;

describe('Agent user-agent integration (real Agent)', () => {
	let server: http.Server;
	const requests: CapturedRequest[] = [];
	const savedEnv: Record<string, string | undefined> = {};

	before(async () => {
		server = http.createServer((req, res) => {
			requests.push({ method: req.method, url: req.url, userAgent: String(req.headers['x-amz-user-agent'] ?? '') });
			req.resume();
			req.on('end', () => {
				if (req.url?.startsWith('/runtimes/')) {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end('{}');
					return;
				}
				res.writeHead(404, { 'Content-Type': 'application/json', 'x-amzn-errortype': 'ResourceNotFoundException' });
				res.end(JSON.stringify({ message: 'not found' }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		process.env.AWS_ENDPOINT_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		process.env.AWS_REGION = 'us-east-1';
		process.env.AWS_ACCESS_KEY_ID = 'AKIDTEST';
		process.env.AWS_SECRET_ACCESS_KEY = 'secret';
		delete process.env.AWS_SESSION_TOKEN;
	});

	after(async () => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	test('BedrockAgentCoreClient is configured with the user-agent chain', async () => {
		const root = { id: 'ua-app' };
		const auth = new ParentAuthBB(root, 'auth');
		const agent = new Agent(auth, 'ua-core', { systemPrompt: 'test', inferenceOnly: true });
		const arnKey = `BB_AGENT_${agent.fullId}_RUNTIME_ARN`;
		process.env[arnKey] = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime';
		requests.length = 0;
		try {
			await (agent as any).dispatchTurn({ message: 'hi', channelId: 'channel-1', userId: 'user-1' });
		} finally {
			delete process.env[arnKey];
		}

		assert.deepStrictEqual((agent as any)._agentCore.config.customUserAgent, [
			['aws-blocks', CORE_VERSION],
			['bb', 'AuthBasic/1.0.1'],
			['bb', `${BB_NAME}/${BB_VERSION}`],
		]);
		const invoke = requests.find(r => r.url?.startsWith('/runtimes/'));
		assert.ok(invoke, 'InvokeAgentRuntime request should reach the endpoint');
		assert.ok(invoke.userAgent.includes(`aws-blocks/${CORE_VERSION}`), `x-amz-user-agent missing aws-blocks: ${invoke.userAgent}`);
		assert.ok(invoke.userAgent.includes('AuthBasic'), `x-amz-user-agent missing parent BB: ${invoke.userAgent}`);
		assert.ok(invoke.userAgent.includes(BB_NAME), `x-amz-user-agent missing Agent BB: ${invoke.userAgent}`);
	});

	test('BedrockClient used for the model health check carries the user-agent chain', async () => {
		const root = { id: 'ua-app' };
		const agent = new Agent(root, 'ua-health', {
			systemPrompt: 'test',
			inferenceOnly: true,
			model: { deployed: { provider: 'bedrock', modelId: 'test.model-v1' } },
		});
		requests.length = 0;
		await agent.invokeTurn({ message: 'hi', channelId: 'channel-2', userId: 'user-1' });

		const healthRequests = requests.filter(r => r.url?.includes('test.model-v1'));
		assert.strictEqual(healthRequests.length, 2, 'GetInferenceProfile and GetFoundationModel should both be attempted');
		for (const r of healthRequests) {
			assert.ok(r.userAgent.includes(`aws-blocks/${CORE_VERSION}`), `x-amz-user-agent missing aws-blocks: ${r.userAgent}`);
			assert.ok(r.userAgent.includes(BB_NAME), `x-amz-user-agent missing Agent BB: ${r.userAgent}`);
		}
	});
});
