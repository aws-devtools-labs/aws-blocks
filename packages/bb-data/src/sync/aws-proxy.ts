// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS shape endpoint: verifies the shape token, then forwards the request to
 * the Electric sync service with the table, filter, columns, and service
 * secret set from the token, never from the client.
 *
 * Electric sits behind an HTTP API with IAM authorization (reached over a VPC
 * link), so every forwarded request is SigV4-signed with the Lambda's role.
 */

import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import type { BlocksContext } from '@aws-blocks/core';
import { CLIENT_PROTOCOL_PARAMS, ELECTRIC_EXPOSED_HEADERS, claimsToElectricParams, electricSubsetParams } from './shape-claims.js';
import type { ShapeClaims } from './shape-claims.js';

/** Keep under the 28 s HTTP deadline guard; Electric long-polls for 20 s. */
const UPSTREAM_TIMEOUT_MS = 26_000;

/** Upstream response headers passed through to the client. */
const PASS_THROUGH_HEADERS = ['cache-control', 'etag', 'content-type'];

let signer: SignatureV4 | null = null;

function getSigner(region: string): SignatureV4 {
  if (signer) return signer;
  signer = new SignatureV4({
    service: 'execute-api',
    region,
    sha256: Sha256,
    // Lambda always provides role credentials in the environment. Read them
    // per request: they rotate, and the runtime updates the variables.
    credentials: async () => {
      const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
      const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
      if (!accessKeyId || !secretAccessKey) {
        throw new Error('No AWS credentials in the environment to sign the sync service request');
      }
      return { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN };
    },
  });
  return signer;
}

/**
 * Forward a verified shape request to Electric and copy its response into
 * `context.response`.
 */
export async function forwardToElectric(
  context: BlocksContext,
  claims: ShapeClaims,
  config: { electricUrl: string; secret: string },
): Promise<void> {
  const upstream = new URL(config.electricUrl);
  const params = claimsToElectricParams(claims);
  const incoming = context.request.url.searchParams;
  for (const name of CLIENT_PROTOCOL_PARAMS) {
    const value = incoming.get(name);
    if (value !== null) params.set(name, value);
  }
  // A snapshot request: compile the client's structured query here, so only
  // server-built SQL reaches Electric. Throws ShapeInvalid for a bad query.
  const subset = electricSubsetParams(claims, incoming);
  for (const [name, value] of subset ?? []) params.set(name, value);
  params.set('secret', config.secret);
  params.sort();
  upstream.search = params.toString();

  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
  const signed = await getSigner(region).sign({
    method: 'GET',
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    path: upstream.pathname,
    query: Object.fromEntries(params),
    headers: { host: upstream.hostname },
  });

  const signals = [AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)];
  if (context.request.signal) signals.push(context.request.signal);
  const response = await fetch(upstream, {
    method: 'GET',
    headers: signed.headers,
    signal: AbortSignal.any(signals),
  });

  context.response.status = response.status;
  const headers = context.response.headers;
  for (const [name, value] of response.headers) {
    if (name.startsWith('electric-') || PASS_THROUGH_HEADERS.includes(name)) headers.set(name, value);
  }
  headers.set('Access-Control-Expose-Headers', ELECTRIC_EXPOSED_HEADERS);
  // `fetch` already decoded the body; never forward content-encoding/length.
  context.response.send(await response.text());
}
