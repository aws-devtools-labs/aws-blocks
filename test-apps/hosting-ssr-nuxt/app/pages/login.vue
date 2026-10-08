<script setup lang="ts">
import { api } from 'hosting-ssr-nuxt-aws-blocks';
import { ref } from 'vue';

const username = ref('');
const password = ref('');
const code = ref('');
const error = ref('');
const info = ref('');
const showConfirm = ref(false);

async function handleSignUp() {
  error.value = '';
  try {
    await api.authSignUp(username.value, password.value);
    const codeInfo = await api.authGetLastCode(username.value);
    if (codeInfo) code.value = codeInfo.code;
    showConfirm.value = true;
    info.value = 'Account created! Confirm with the verification code.';
  } catch (e: unknown) {
    error.value = (e as Error).message;
  }
}

async function handleConfirm() {
  error.value = '';
  try {
    await api.authConfirmSignUp(username.value, code.value);
    showConfirm.value = false;
    info.value = 'Confirmed! You can now log in.';
  } catch (e: unknown) {
    error.value = (e as Error).message;
  }
}

async function handleLogin() {
  error.value = '';
  try {
    await api.authSignIn(username.value, password.value);
    window.location.href = '/dashboard';
  } catch (e: unknown) {
    error.value = (e as Error).message;
  }
}

async function handleLogout() {
  try { await api.authSignOut(); } catch { /* ignore */ }
  window.location.href = '/';
}
</script>

<template>
  <main>
    <h2>Login</h2>
    <div :style="{ maxWidth: '400px' }">
      <div :style="{ margin: '0.5rem 0' }">
        <input
          id="login-username"
          v-model="username"
          placeholder="Email"
          :style="{ width: '100%', padding: '0.5rem' }"
        />
      </div>
      <div :style="{ margin: '0.5rem 0' }">
        <input
          id="login-password"
          v-model="password"
          type="password"
          placeholder="Password"
          :style="{ width: '100%', padding: '0.5rem' }"
        />
      </div>
      <div :style="{ display: 'flex', gap: '0.5rem', margin: '0.5rem 0' }">
        <button id="btn-login" :style="{ padding: '0.5rem 1rem' }" @click="handleLogin">Log In</button>
        <button id="btn-signup" :style="{ padding: '0.5rem 1rem' }" @click="handleSignUp">Sign Up</button>
        <button id="btn-logout" :style="{ padding: '0.5rem 1rem' }" @click="handleLogout">Log Out</button>
      </div>

      <div
        v-if="showConfirm"
        id="confirm-section"
        :style="{ margin: '0.5rem 0', padding: '0.5rem', background: '#f0f0f0', borderRadius: '4px' }"
      >
        <input
          id="confirm-code"
          v-model="code"
          placeholder="Verification code"
          :style="{ width: '100%', padding: '0.5rem', marginBottom: '0.5rem' }"
        />
        <button id="btn-confirm" :style="{ padding: '0.5rem 1rem' }" @click="handleConfirm">Confirm</button>
      </div>

      <p v-if="error" id="auth-error" :style="{ color: '#c00', margin: '0.5rem 0' }">{{ error }}</p>
      <p v-if="info" id="auth-info" :style="{ color: '#666', margin: '0.5rem 0' }">{{ info }}</p>
    </div>
  </main>
</template>
