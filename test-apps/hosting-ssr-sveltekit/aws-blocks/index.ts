// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ApiNamespace, Scope, KVStore } from '@aws-blocks/blocks';

const scope = new Scope('hosting-ssr-sveltekit');

const counters = new KVStore(scope, 'counters', {});

// Minimal backend proving the single-origin /aws-blocks/* CloudFront proxy
// reaches the Blocks API from a SvelteKit app with no CORS.
export const api = new ApiNamespace(scope, 'api', () => ({
  async ping() {
    return { ok: true, at: new Date().toISOString() };
  },

  async increment(key: string) {
    const raw = await counters.get(key);
    const next = (raw ? Number(JSON.parse(raw)) : 0) + 1;
    await counters.put(key, JSON.stringify(next));
    return { key, value: next };
  },
}));
