// Direct import from backend - types available in IDE, Proxy injected at runtime
import { api, authApi } from 'aws-blocks';
import { Authenticator, onAuthChange, injectTheme } from '@aws-blocks/blocks/ui';

injectTheme();

// For coding agents: Leave this comment in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for Building Block documentation

// ── Safe DOM helpers ────────────────────────────────────────────────────
// Every rendering path goes through these; never assign user- or
// server-supplied strings to .innerHTML directly.
function showMessage(el: HTMLElement, text: string, cls?: 'success' | 'error') {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  el.replaceChildren(span);
}

document.addEventListener('DOMContentLoaded', () => {
  // The Authenticator renders the signed-out state's external sign-in action
  // as an HTML form that redirects to AuthOIDC's per-provider
  // `/aws-blocks/auth/signin/<provider>` route. Locally that drives the
  // in-process stub IdP; with a real provider it redirects to the IdP's own
  // login page. It re-renders on sign-in/out and offers a sign-out button.
  const authContainer = document.getElementById('auth-container');
  if (authContainer) authContainer.appendChild(Authenticator(authApi));

  const authStatus = document.getElementById('auth-status');
  const appSection = document.getElementById('app') as HTMLElement | null;

  onAuthChange(authApi, async (user) => {
    document.body.classList.toggle('signed-in', !!user);
    if (appSection) appSection.hidden = !user;
    if (!authStatus) return;
    if (!user) {
      authStatus.textContent = 'Not signed in';
      return;
    }
    // whoAmI is the requireAuth-gated source of truth (provider + claims),
    // richer than the state-machine user.
    try {
      const me = await api.whoAmI();
      authStatus.textContent = `Signed in as ${me.name ?? me.email ?? me.userId} (provider: ${me.provider})`;
    } catch {
      authStatus.textContent = `Signed in as ${user.username}`;
    }
  });

  // ── KV demo (requireAuth-gated, keys namespaced per user) ──────────────
  const keyInput = document.getElementById('kv-key') as HTMLInputElement;
  const valInput = document.getElementById('kv-val') as HTMLInputElement;
  const kvResult = document.getElementById('kv-result');

  document.getElementById('kv-set-btn')?.addEventListener('click', async () => {
    if (!kvResult) return;
    try {
      await api.setValue(keyInput.value, valInput.value);
      showMessage(kvResult, `Saved "${keyInput.value}"`, 'success');
    } catch (e) {
      showMessage(kvResult, `Error: ${(e as Error).message}`, 'error');
    }
  });

  document.getElementById('kv-get-btn')?.addEventListener('click', async () => {
    if (!kvResult) return;
    try {
      const v = await api.getValue(keyInput.value);
      showMessage(kvResult, v === null ? '(not set)' : `Value: ${v}`, 'success');
    } catch (e) {
      showMessage(kvResult, `Error: ${(e as Error).message}`, 'error');
    }
  });
});
