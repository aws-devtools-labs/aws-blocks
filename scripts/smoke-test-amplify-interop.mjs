#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Smoke test for the Amplify Gen 2 + CDK Blocks scaffolding.
 *
 * Verifies:
 * 1. amplify_outputs.json contains blocks_api_url
 * 2. The public API endpoint responds correctly
 *
 * Run from the deployed app directory (amplify_outputs.json must exist).
 * Protected routes and client.js are tested via Playwright in test-apps/amplify-gen2.
 */
import { readFileSync } from 'node:fs';

const outputs = JSON.parse(readFileSync('amplify_outputs.json', 'utf-8'));

// ── Test 1: blocks_api_url in outputs ────────────────────────────────────────

console.log('── Test 1: amplify_outputs.json has blocks_api_url ──');
const apiUrl = outputs.custom?.blocks_api_url;
if (!apiUrl) {
  throw new Error('blocks_api_url not found in amplify_outputs.json custom section');
}
console.log(`  ✅ ${apiUrl}\n`);

// ── Test 2: Public API responds ──────────────────────────────────────────────

console.log('── Test 2: AWS CDK Blocks public API responds ──');
const res = await fetch(apiUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  // JSON-RPC 2.0 wire format: method is "namespace.method", args go in params.
  body: JSON.stringify({ jsonrpc: '2.0', method: 'api.greet', params: ['CI'], id: 1 }),
});

if (!res.ok) {
  throw new Error(`API returned ${res.status}: ${await res.text()}`);
}

// JSON-RPC 2.0 response: errors live in the body (HTTP 200), payload is in `result`.
const body = await res.json();
if (body.error) {
  throw new Error(`API returned RPC error: ${JSON.stringify(body.error)}`);
}
const data = body.result;
if (!data?.message?.includes('Hello from CDK Blocks')) {
  throw new Error(`Unexpected response: ${JSON.stringify(body)}`);
}
console.log(`  ✅ ${data.message}\n`);

console.log('🎉 Amplify interop smoke test passed!\n');
