import { api, authApi } from 'aws-blocks';
import { Authenticator, onAuthChange } from '@aws-blocks/bb-auth/ui';

document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('auth-container');
  if (container) {
    // The shared <Authenticator> renders every state the BB emits — sign in,
    // sign up, the WEB_AUTHN challenge form, the post-sign-in management
    // screen, etc. Capability hooks (`webauthn-get` / `webauthn-create`) are
    // handled inside ui.ts.
    container.appendChild(Authenticator(authApi));
  }

  onAuthChange(authApi, (user) => {
    const status = document.getElementById('auth-status');
    if (status) {
      status.textContent = user ? `Signed in as: ${user.username}` : 'Not signed in';
    }
    document.body.classList.toggle('signed-in', Boolean(user));
  });

  document.getElementById('whoami-btn')?.addEventListener('click', async () => {
    const out = document.getElementById('whoami-result')!;
    try {
      const r = await api.whoAmI();
      out.textContent = JSON.stringify(r, null, 2);
    } catch (e: any) {
      out.textContent = `Error: ${e?.message ?? String(e)}`;
    }
  });

  document.getElementById('last-code-btn')?.addEventListener('click', async () => {
    const out = document.getElementById('last-code-result')!;
    const last = await api.getLastCode();
    out.textContent = last ? `${last.purpose} ${last.username}: ${last.code}` : '(none — sandbox sends real OTPs)';
  });
});
