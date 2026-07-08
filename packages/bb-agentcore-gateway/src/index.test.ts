// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentCoreGateway } from './index.mock.js';
import type { ToolsConfig } from './types.js';

function sampleTools(): ToolsConfig {
  return {
    get_weather: {
      description: 'Get the current weather for a city.',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      handler: (args) => ({ city: args.city, tempC: 21, conditions: 'sunny' }),
    },
    add: {
      description: 'Add two numbers.',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      handler: (args) => (args.a as number) + (args.b as number),
    },
  };
}

function newGateway() {
  return new AgentCoreGateway({ id: 'testapp' }, 'tools', { tools: sampleTools() });
}

test('listTools returns MCP descriptors with AgentCore-qualified names', async () => {
  const gw = newGateway();
  const tools = await gw.listTools();
  assert.equal(tools.length, 2);
  const names = tools.map((t) => t.name).sort();
  // Names are `${target}___${tool}` where target is the block fullId (testapp-tools).
  assert.ok(names[0].endsWith('___add'));
  assert.ok(names[1].endsWith('___get_weather'));
  const weather = tools.find((t) => t.name.endsWith('___get_weather'))!;
  assert.equal(weather.description, 'Get the current weather for a city.');
  assert.deepEqual(weather.inputSchema.required, ['city']);
});

test('callTool runs a handler (bare name)', async () => {
  const gw = newGateway();
  const res = await gw.callTool('add', { a: 2, b: 3 });
  assert.equal(res.tool, 'add');
  assert.equal(res.result, 5);
});

test('callTool accepts AgentCore-qualified names', async () => {
  const gw = newGateway();
  const [tool] = await gw.listTools();
  const res = await gw.callTool(tool.name, tool.name.endsWith('___add') ? { a: 1, b: 1 } : { city: 'Paris' });
  assert.ok(res.result !== undefined);
});

test('callTool validates required arguments', async () => {
  const gw = newGateway();
  await assert.rejects(() => gw.callTool('get_weather', {}), /missing required argument/);
});

test('callTool rejects unknown tools', async () => {
  const gw = newGateway();
  await assert.rejects(() => gw.callTool('does_not_exist', {}), /Unknown tool/);
});

test('async handlers are awaited', async () => {
  const gw = new AgentCoreGateway({ id: 'testapp' }, 'async-tools', {
    tools: {
      slow_echo: {
        description: 'Echo after a tick.',
        inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        handler: async (args) => {
          await new Promise((r) => setTimeout(r, 1));
          return `echo: ${args.msg}`;
        },
      },
    },
  });
  const res = await gw.callTool('slow_echo', { msg: 'hi' });
  assert.equal(res.result, 'echo: hi');
});

test('getEndpoint is empty locally', async () => {
  const gw = newGateway();
  assert.equal(gw.getEndpoint(), '');
});

test('layer parity: mock/aws/cdk/browser expose the same public methods', async () => {
  const mock = await import('./index.mock.js');
  const aws = await import('./index.aws.js');
  const cdk = await import('./index.cdk.js');
  const browser = await import('./index.browser.js');

  const methods = (cls: any): string[] =>
    Object.getOwnPropertyNames(cls.prototype).filter((m) => m !== 'constructor');

  const expected = ['listTools', 'callTool', 'getEndpoint'];
  for (const layer of [mock.AgentCoreGateway, aws.AgentCoreGateway, cdk.AgentCoreGateway]) {
    const present = methods(layer);
    for (const m of expected) {
      assert.ok(present.includes(m), `expected method "${m}" on ${layer.name}`);
    }
  }
  assert.equal(typeof browser.AgentCoreGateway, 'function');
});
