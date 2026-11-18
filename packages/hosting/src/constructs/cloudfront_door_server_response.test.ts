// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * How the CloudFront door's server origin (the SSR REST API) invokes the
 * server Lambda, end to end through `HostingConstruct`.
 *
 * A REST API Lambda proxy integration is either a streaming one
 * (`ResponseTransferMode: STREAM`, the `response-streaming-invocations` path),
 * which reads the response-stream framing a streaming handler writes, or a
 * plain one (the `invocations` path), which reads the
 * `{ statusCode, headers, body }` object a buffered handler returns. Neither
 * serves a request given the other's answer (a buffered handler behind STREAM
 * answers 502 on every path), so the integration follows the server as built:
 *
 * - a buffered Lambda handler (Nitro's `aws-lambda` preset with
 *   `awsLambda.streaming` off, its default) gets the plain integration;
 * - a streaming Lambda handler, and a Lambda Web Adapter server (which the
 *   CloudFront door runs in `response_stream` mode), get the STREAM one.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { ComputeResource, DeployManifest } from '../manifest/types.js';
import { HostingConstruct } from './hosting_construct.js';
import { SSR_CACHE_GUARD_HANDLER, SSR_CACHE_GUARD_HANDLER_FILE } from './ssr_cache_guard.js';

/** How one REST API method invokes its Lambda. */
type Invoke = { transferMode: string | undefined; path: string | undefined };

describe("CloudFront door — the server origin's integration follows the server's response mode", () => {
  let tmp: string;
  let bundle: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-server-response-'));
    fs.writeFileSync(path.join(tmp, 'index.html'), '<html></html>');
    bundle = path.join(tmp, 'server');
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, 'index.mjs'), "export const handler = async () => ({ statusCode: 200, body: '' });\n");
    fs.writeFileSync(path.join(bundle, 'run.sh'), '#!/bin/sh\nexec node index.mjs\n');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** The server the Nitro adapter emits for the `aws-lambda` preset. */
  const nitroAwsLambda = (streaming: boolean | undefined): ComputeResource => ({
    type: 'handler',
    bundle,
    handler: 'index.handler',
    placement: 'regional',
    ...(streaming === undefined ? {} : { streaming }),
  });

  /** A Lambda Web Adapter server (Nitro's `node-server` preset, an OpenNext container origin). */
  const lambdaWebAdapter = (streaming: boolean | undefined): ComputeResource => ({
    type: 'http-server',
    bundle,
    entrypoint: 'run.sh',
    port: 3000,
    placement: 'regional',
    ...(streaming === undefined ? {} : { streaming }),
  });

  const synth = (server: ComputeResource) => {
    const manifest: DeployManifest = {
      version: 1,
      buildId: 'cfserver1',
      compute: { default: server },
      staticAssets: { directory: tmp },
      routes: [
        { pattern: '/_nuxt/*', target: 'static' },
        { pattern: '/*', target: 'default' },
      ],
    };
    const stack = new Stack(new App(), 'S', { env: { account: '111111111111', region: 'us-west-2' } });
    const hosting = new HostingConstruct(stack, 'Hosting', { manifest });
    return { t: Template.fromStack(stack), hosting };
  };

  /** How the server origin's REST API invokes the server: one entry per method (`/` and `/{proxy+}`). */
  const serverInvokes = (t: Template): Invoke[] =>
    Object.values(t.findResources('AWS::ApiGateway::Method')).map((method) => {
      const integration = method.Properties.Integration as { Type: string; ResponseTransferMode?: string; Uri: unknown };
      assert.equal(integration.Type, 'AWS_PROXY');
      return {
        transferMode: integration.ResponseTransferMode,
        path: /\/(response-streaming-invocations|invocations)"/.exec(JSON.stringify(integration.Uri))?.[1],
      };
    });

  const BUFFERED: Invoke = { transferMode: undefined, path: 'invocations' };
  const STREAM: Invoke = { transferMode: 'STREAM', path: 'response-streaming-invocations' };

  it('a buffered Lambda handler (Nitro `aws-lambda`, streaming off) is invoked without streaming', () => {
    const { t, hosting } = synth(nitroAwsLambda(false));
    assert.deepEqual(serverInvokes(t), [BUFFERED, BUFFERED]);
    assert.equal(hosting.doorInput?.origins.server?.streaming, false);
  });

  it('the buffered handler keeps answering with a proxy result behind the SSR cache guard', async () => {
    // The function the plain integration invokes is the guard's wrapper, so the
    // wrapper must stay a buffered handler and pass the handler's result on.
    fs.writeFileSync(
      path.join(bundle, 'index.mjs'),
      `export async function handler(event, context) {
  return {
    statusCode: 201,
    headers: { 'content-type': 'text/plain' },
    multiValueHeaders: { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] },
    body: event.httpMethod + ' ' + event.path,
    isBase64Encoded: false,
  };
}
`,
    );
    const { t } = synth(nitroAwsLambda(false));
    t.hasResourceProperties('AWS::Lambda::Function', { Handler: SSR_CACHE_GUARD_HANDLER });
    type ProxyResult = { statusCode: number; body: string; multiValueHeaders: Record<string, string[]> };
    // Synth writes the wrapper into the temp bundle, so it is loaded by path at run time.
    const { handler } = (await import(pathToFileURL(path.join(bundle, SSR_CACHE_GUARD_HANDLER_FILE)).href)) as {
      handler: ((event: unknown, context: unknown) => Promise<ProxyResult>) & { [marker: symbol]: unknown };
    };
    // The marker the Lambda runtime reads to invoke a handler with a response stream.
    assert.equal(handler[Symbol.for('aws.lambda.runtime.handler.streaming')], undefined);
    // A REST API (payload format 1.0) proxy event.
    const result = await handler({ httpMethod: 'POST', path: '/api/echo', headers: {}, multiValueHeaders: {} }, {});
    assert.equal(result.statusCode, 201);
    assert.equal(result.body, 'POST /api/echo');
    assert.deepEqual(result.multiValueHeaders['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
    // A cookie-setting response is never stored by CloudFront (the SSR cache guard).
    assert.deepEqual(result.multiValueHeaders['cache-control'], ['private, no-store']);
  });

  it('a streaming Lambda handler (Nitro `aws-lambda`, streaming on) is invoked with STREAM', () => {
    const { t, hosting } = synth(nitroAwsLambda(true));
    assert.deepEqual(serverInvokes(t), [STREAM, STREAM]);
    assert.equal(hosting.doorInput?.origins.server?.streaming, true);
  });

  it('a Lambda handler whose manifest does not say is invoked with STREAM', () => {
    assert.deepEqual(serverInvokes(synth(nitroAwsLambda(undefined)).t), [STREAM, STREAM]);
  });

  for (const streaming of [undefined, false, true]) {
    it(`a Lambda Web Adapter server (manifest streaming: ${streaming}) is invoked with STREAM: it runs in response_stream mode`, () => {
      const { t } = synth(lambdaWebAdapter(streaming));
      assert.deepEqual(serverInvokes(t), [STREAM, STREAM]);
      const modes = Object.values(t.findResources('AWS::Lambda::Function'))
        .map((fn) => fn.Properties.Environment?.Variables?.AWS_LWA_INVOKE_MODE)
        .filter((mode) => mode !== undefined);
      assert.deepEqual(modes, ['response_stream']);
    });
  }
});
