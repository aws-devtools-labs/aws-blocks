<script setup lang="ts">
import { api } from 'hosting-ssr-nuxt-cdk-blocks';

const { data: posts } = await useAsyncData('posts', () => api.listPosts(), {
  default: () => [],
});
</script>

<template>
  <main>
    <h2>Recent Posts</h2>
    <p data-testid="ssr-home-marker">Server-rendered blog posts</p>

    <p
      v-if="!posts || posts.length === 0"
      data-testid="no-posts"
      :style="{ color: '#888', padding: '2rem 0' }"
    >
      No posts yet. Be the first to write something!
    </p>
    <div v-else data-testid="post-list">
      <article
        v-for="post in posts"
        :key="post.id"
        data-testid="post-card"
        :style="{ background: '#f9f9f9', border: '1px solid #eee', borderRadius: '8px', padding: '1rem', margin: '0.75rem 0' }"
      >
        <h3>
          <a :href="`/posts/${post.id}`">{{ post.title }}</a>
        </h3>
        <p :style="{ color: '#666' }">
          {{ post.body.slice(0, 150) }}{{ post.body.length > 150 ? '...' : '' }}
        </p>
        <p :style="{ fontSize: '0.85rem', color: '#999' }">
          by {{ post.author }} · {{ new Date(post.createdAt).toLocaleDateString() }}
        </p>
      </article>
    </div>
  </main>
</template>
