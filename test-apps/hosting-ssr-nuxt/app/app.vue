<script setup lang="ts">
useHead({ title: 'AWS CDK Blocks Blog' });
</script>

<template>
  <div :style="{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '800px', margin: '0 auto', color: '#333' }">
    <header :style="{ marginBottom: '2rem', borderBottom: '1px solid #eee', paddingBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }">
      <div>
        <h1 :style="{ margin: 0 }">
          <NuxtLink to="/" :style="{ textDecoration: 'none', color: 'inherit' }">✍️ CDK Blocks Blog</NuxtLink>
          <span :style="{ marginLeft: '0.5rem', fontSize: '0.75rem', padding: '0.15rem 0.5rem', borderRadius: '4px', background: '#00DC82', color: '#000', fontWeight: 'normal', verticalAlign: 'middle' }">Nuxt</span>
        </h1>
        <p :style="{ color: '#666', margin: '0.25rem 0 0' }">Nuxt 4 (Nitro) · SSR Hosting E2E Test</p>
      </div>
      <nav :style="{ display: 'flex', gap: '1rem' }">
        <NuxtLink to="/">Home</NuxtLink>
        <NuxtLink to="/dashboard">Dashboard</NuxtLink>
        <NuxtLink to="/profile">Profile</NuxtLink>
        <NuxtLink to="/create">Write</NuxtLink>
        <NuxtLink to="/api-test">API Test</NuxtLink>
        <NuxtLink to="/login">Login</NuxtLink>
      </nav>
    </header>
    <NuxtPage />
  </div>
</template>
