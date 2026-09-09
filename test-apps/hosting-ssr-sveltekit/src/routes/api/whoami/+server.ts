// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Reads the sk_visit cookie seeded by hooks.server.ts. Proves cookies round-trip
// through CloudFront -> Lambda and hooks.server runs on every request.
export const GET: RequestHandler = ({ cookies }) => {
  return json({ visit: cookies.get('sk_visit') ?? null });
};
