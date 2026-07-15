// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// +server.js API endpoint exercising all common verbs. Sets a custom response
// header so the e2e suite can assert per-endpoint headers survive the edge.
const HEADERS = { 'x-sk-endpoint': 'echo' };

export const GET: RequestHandler = ({ url }) => {
  return json(
    { method: 'GET', query: Object.fromEntries(url.searchParams) },
    { headers: HEADERS },
  );
};

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => null);
  return json({ method: 'POST', body }, { headers: HEADERS });
};

export const PUT: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => null);
  return json({ method: 'PUT', body }, { headers: HEADERS });
};

export const DELETE: RequestHandler = () => {
  return json({ method: 'DELETE', deleted: true }, { headers: HEADERS });
};
