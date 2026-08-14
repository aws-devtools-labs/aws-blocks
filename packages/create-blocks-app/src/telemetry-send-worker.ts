// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// NOTE: This worker is an intentional near-duplicate of
// packages/core/src/telemetry/telemetry-send-worker.ts. It is kept separate
// because the worker must run with zero project/package imports. Any change
// here should be mirrored in both files.

/**
 * Telemetry send worker — spawned as a detached subprocess.
 * Reads JSON payload from stdin, POSTs it to the endpoint (argv[2]).
 *
 * Uses only Node built-ins — no project imports — so the compiled .js
 * runs with bare `node` (no tsx needed).
 */

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

// Matches the timeout in packages/core/src/telemetry/telemetry-send-worker.ts — keep in sync.
const TIMEOUT_MS = 500;
const debug = (process.env.NODE_DEBUG || '').includes('blocks-telemetry');

const endpoint = process.argv[2];
if (!endpoint) process.exit(1);

let payload = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => { payload += chunk; });
process.stdin.on('end', () => {
  try {
    const url = new URL(endpoint);
    const isHttps = url.protocol === 'https:';
    const requestFn = isHttps ? httpsRequest : httpRequest;

    const req = requestFn({
      hostname: url.hostname,
      port: url.port || (isHttps ? '443' : '80'),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      res.resume();
      if (debug) process.stderr.write(`BLOCKS-TELEMETRY: sent (status=${res.statusCode})\n`);
      process.exit(0);
    });

    req.on('error', (e) => {
      if (debug) process.stderr.write(`BLOCKS-TELEMETRY: error: ${(e as Error).message}\n`);
      process.exit(1);
    });
    req.on('timeout', () => {
      if (debug) process.stderr.write(`BLOCKS-TELEMETRY: timed out\n`);
      req.destroy();
      process.exit(1);
    });
    req.write(payload);
    req.end();
  } catch {
    process.exit(1);
  }
});
