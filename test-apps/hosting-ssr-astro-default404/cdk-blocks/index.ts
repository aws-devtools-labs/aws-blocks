// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ApiNamespace, Scope, KVStore } from '@aws-blocks/blocks';

const scope = new Scope('hosting-ssr-astro-test');

const posts = new KVStore(scope, 'posts', {});
const postIndex = new KVStore(scope, 'post-index', {});

export const api = new ApiNamespace(scope, 'api', () => ({
  async listPosts() {
    const indexRaw = await postIndex.get('all');
    const ids: string[] = indexRaw ? JSON.parse(indexRaw) : [];
    const result = [];
    for (const id of ids) {
      const raw = await posts.get(id);
      if (raw) result.push(JSON.parse(raw));
    }
    return result.reverse();
  },

  async getPost(id: string) {
    const raw = await posts.get(id);
    return raw ? JSON.parse(raw) : null;
  },

  async createPost(title: string, body: string, author: string) {
    const id = `post-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const post = { id, title, body, author, createdAt: new Date().toISOString() };
    await posts.put(id, JSON.stringify(post));

    const indexRaw = await postIndex.get('all');
    const ids: string[] = indexRaw ? JSON.parse(indexRaw) : [];
    ids.push(id);
    await postIndex.put('all', JSON.stringify(ids));

    return post;
  },
}));
