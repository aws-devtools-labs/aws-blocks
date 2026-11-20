<script setup lang="ts">
import { api } from 'hosting-ssr-nuxt-cdk-blocks';

type Post = { id: string; title: string; body: string; author: string; createdAt: number };

const route = useRoute();
const id = String(route.params.id);

const { data: post } = await useAsyncData<Post | null>(
  `post-${id}`,
  () => api.getPost(id),
  { default: () => null },
);

if (!post.value) {
  throw createError({ statusCode: 404, statusMessage: 'Post not found' });
}
</script>

<template>
  <main>
    <article>
      <h2 data-testid="post-title">{{ post.title }}</h2>
      <p data-testid="post-meta" :style="{ color: '#666', fontSize: '0.9rem' }">
        by {{ post.author }} · {{ new Date(post.createdAt).toLocaleDateString() }}
      </p>
      <div data-testid="post-body" :style="{ marginTop: '1rem', lineHeight: 1.6 }">
        {{ post.body }}
      </div>
    </article>
    <p :style="{ marginTop: '2rem' }">
      <NuxtLink to="/">← Back to home</NuxtLink>
    </p>
  </main>
</template>
