// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Executes the GENERATED image-optimization handler (IPX_LAMBDA_HANDLER_SOURCE)
 * rather than string-matching it. The handler is written to a temp dir next to
 * stub `ipx` and `@aws-sdk/client-s3` modules:
 *
 * - the S3 stub serves whatever bytes a case sets;
 * - the `ipx` stub calls the configured storage's `getData` (as IPX does), and maps
 *   ANY thrown storage error to a 500 — deliberately the worst case, so these tests
 *   prove the SVG 415 comes from the handler itself and does not depend on how IPX
 *   surfaces a storage error.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPX_LAMBDA_HANDLER_SOURCE } from './ipx_lambda_template.js';

type LambdaResult = { statusCode: number; headers: Record<string, string>; body: string };
type Handler = (event: unknown) => Promise<LambdaResult>;
type Control = { s3Bytes: Uint8Array; remoteBytes: Uint8Array; outputType: string };

const SVG = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let dir: string;
let control: Control;

const STUB_CONTROL = 'export const control = { s3Bytes: new Uint8Array(), remoteBytes: new Uint8Array(), outputType: "image/png" };\n';

const STUB_IPX = `import { control } from '../../control.mjs';
export const createIPX = (opts) => opts;
export const ipxHttpStorage = () => ({ name: 'http', getMeta: async () => ({}), getData: async () => control.remoteBytes });
export const createIPXWebServer = (ipx) => async (req) => {
  const url = new URL(req.url);
  const rest = url.pathname.replace(/^\\/+/, '');
  const id = decodeURIComponent(rest.slice(rest.indexOf('/') + 1));
  const storage = /^https?:/.test(id) ? ipx.httpStorage : ipx.storage;
  try {
    const data = await storage.getData(id.startsWith('http') ? id : '/' + id.replace(/^\\/+/, ''));
    return new Response(data, { status: 200, headers: { 'content-type': control.outputType } });
  } catch {
    return new Response('{"error":"ipx internal"}', { status: 500, headers: { 'content-type': 'application/json' } });
  }
};
`;

const STUB_S3 = `import { control } from '../../../control.mjs';
export class GetObjectCommand { constructor(input) { this.input = input; } }
export class S3Client {
  async send() {
    return { Body: { transformToByteArray: async () => control.s3Bytes }, LastModified: new Date(0), ContentLength: control.s3Bytes.length };
  }
}
`;

function writePkg(name: string, source: string): void {
  const pkgDir = path.join(dir, 'node_modules', ...name.split('/'));
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.mjs' }));
  fs.writeFileSync(path.join(pkgDir, 'index.mjs'), source);
}

let importCount = 0;
/** Import a fresh copy of the generated handler; env is read at module load. */
async function loadHandler(env: Record<string, string | undefined>): Promise<Handler> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const mod: { handler: Handler } = await import(`${pathToFileURL(path.join(dir, 'index.mjs')).href}?v=${++importCount}`);
    return mod.handler;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const BASE_ENV = { BUCKET_NAME: 'assets', BUCKET_REGION: 'us-west-2', IMAGE_ALLOWED_HOSTNAMES: 'cdn.example.com' };
const event = (source: string) => ({
  version: '2.0',
  rawPath: `/_ipx/_/${source.startsWith('http') ? encodeURIComponent(source) : source}`,
  rawQueryString: '',
  headers: {},
  requestContext: { http: { method: 'GET' } },
});

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipx-handler-'));
  fs.writeFileSync(path.join(dir, 'control.mjs'), STUB_CONTROL);
  writePkg('ipx', STUB_IPX);
  writePkg('@aws-sdk/client-s3', STUB_S3);
  fs.writeFileSync(path.join(dir, 'index.mjs'), IPX_LAMBDA_HANDLER_SOURCE);
  const mod: { control: Control } = await import(pathToFileURL(path.join(dir, 'control.mjs')).href);
  control = mod.control;
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

void describe('generated IPX handler — SVG gate (executed, not string-matched)', () => {
  const silenced = <T>(fn: () => Promise<T>): Promise<T> => {
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    return fn().finally(() => { process.stderr.write = write; });
  };

  void it('rejects SVG bytes from the S3 originals bucket with 415, even though ipx maps the error to 500', async () => {
    const handler = await loadHandler(BASE_ENV);
    control.s3Bytes = SVG;
    control.outputType = 'image/png';
    const res = await silenced(() => handler(event('logo')));
    assert.strictEqual(res.statusCode, 415);
    assert.match(res.body, /SVG sources are not permitted/);
  });

  void it('rejects SVG bytes from an allowlisted remote host (httpStorage) with 415', async () => {
    const handler = await loadHandler(BASE_ENV);
    control.remoteBytes = SVG;
    const res = await silenced(() => handler(event('https://cdn.example.com/logo.png')));
    assert.strictEqual(res.statusCode, 415);
  });

  void it('backstop: refuses image/svg+xml OUTPUT even when the input bytes passed the sniff', async () => {
    const handler = await loadHandler(BASE_ENV);
    control.s3Bytes = PNG;
    control.outputType = 'image/svg+xml';
    const res = await silenced(() => handler(event('logo')));
    assert.strictEqual(res.statusCode, 415);
  });

  void it('serves a raster image normally', async () => {
    const handler = await loadHandler(BASE_ENV);
    control.s3Bytes = PNG;
    control.outputType = 'image/png';
    const res = await silenced(() => handler(event('pic')));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'image/png');
  });

  void it('serves SVG when the user opted in (IMAGE_ALLOW_SVG=true)', async () => {
    const handler = await loadHandler({ ...BASE_ENV, IMAGE_ALLOW_SVG: 'true' });
    control.s3Bytes = SVG;
    control.outputType = 'image/svg+xml';
    const res = await silenced(() => handler(event('logo')));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'image/svg+xml');
  });
});
