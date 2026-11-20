<script setup lang="ts">
import { api } from 'hosting-ssr-nuxt-cdk-blocks';

type Post = { id: string; title: string; body: string };
type Profile = { username: string };

const { data, error } = await useFetch<{ myPosts: Post[]; profile: Profile }>(
  '/api/dashboard',
  { server: true, headers: useRequestHeaders(['cookie']) },
);

if (error.value) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const status = (error.value as any)?.statusCode ?? (error.value as any)?.status;
  if (status === 401 || status === 403) {
    await navigateTo('/login');
  } else {
    throw error.value;
  }
}

const posts = computed<Post[]>(() => data.value?.myPosts ?? []);
const username = computed(() => data.value?.profile?.username ?? '');

if (data.value && !username.value) {
  await navigateTo('/login');
}

async function handleDelete(postId: string) {
  try {
    await api.deletePost(postId);
    window.location.reload();
  } catch (e: unknown) {
    alert(`Delete failed: ${(e as Error).message}`);
  }
}

async function handleLogout() {
  try { await api.authSignOut(); } catch { /* ignore */ }
  window.location.href = '/';
}
</script>

<template>
  <main>
    <h2>My Dashboard</h2>
    <p data-testid="dashboard-user">Logged in as: <strong>{{ username }}</strong></p>

    <div :style="{ margin: '0.5rem 0' }">
      <NuxtLink to="/create" :style="{ marginRight: '1rem' }">✏️ Write New Post</NuxtLink>
      <button id="btn-logout" :style="{ cursor: 'pointer', padding: '0.25rem 0.5rem' }" @click="handleLogout">Log Out</button>
    </div>

    <h3>My Posts</h3>
    <p
      v-if="posts.length === 0"
      data-testid="no-posts"
      :style="{ color: '#888' }"
    >
      No posts yet. <NuxtLink to="/create">Write your first post!</NuxtLink>
    </p>
    <div v-else data-testid="my-posts">
      <div
        v-for="post in posts"
        :key="post.id"
        data-testid="my-post-card"
        :style="{ background: '#f9f9f9', border: '1px solid #eee', borderRadius: '8px', padding: '1rem', margin: '0.75rem 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }"
      >
        <div>
          <strong>{{ post.title }}</strong>
          <p :style="{ color: '#666', fontSize: '0.9rem' }">{{ post.body.slice(0, 100) }}</p>
        </div>
        <button
          data-testid="btn-delete"
          :style="{ color: '#c00', cursor: 'pointer', border: '1px solid #c00', borderRadius: '4px', padding: '0.25rem 0.5rem', background: '#fff' }"
          @click="handleDelete(post.id)"
        >
          Delete
        </button>
      </div>
    </div>
  </main>
</template>
