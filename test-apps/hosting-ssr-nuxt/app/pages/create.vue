<script setup lang="ts">
import { api } from 'hosting-ssr-nuxt-cdk-blocks';
import { ref } from 'vue';

const title = ref('');
const body = ref('');
const error = ref('');
const loading = ref(false);

async function handleSubmit(e: Event) {
  e.preventDefault();
  if (!title.value.trim()) {
    error.value = 'Title is required';
    return;
  }
  error.value = '';
  loading.value = true;
  try {
    await api.createPost(title.value, body.value);
    window.location.href = '/dashboard';
  } catch (err: unknown) {
    error.value = (err as Error).message;
    loading.value = false;
  }
}
</script>

<template>
  <main>
    <h2>Write a Post</h2>
    <form :style="{ maxWidth: '600px' }" @submit="handleSubmit">
      <div :style="{ margin: '0.5rem 0' }">
        <input
          id="post-title"
          v-model="title"
          placeholder="Post title"
          :style="{ width: '100%', padding: '0.5rem', fontSize: '1.1rem' }"
        />
      </div>
      <div :style="{ margin: '0.5rem 0' }">
        <textarea
          id="post-body"
          v-model="body"
          placeholder="Write your post..."
          rows="8"
          :style="{ width: '100%', padding: '0.5rem', resize: 'vertical' }"
        />
      </div>
      <p v-if="error" id="create-error" :style="{ color: '#c00' }">{{ error }}</p>
      <button
        id="btn-publish"
        type="submit"
        :disabled="loading"
        :style="{ padding: '0.5rem 1.5rem', background: '#0066cc', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }"
      >
        {{ loading ? 'Publishing...' : 'Publish' }}
      </button>
    </form>
  </main>
</template>
