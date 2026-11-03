// Direct import from backend - types available in IDE, Proxy injected at runtime
import { api, authApi } from 'aws-blocks';
import { Authenticator, onAuthChange, injectTheme } from '@aws-blocks/blocks/ui';

injectTheme();

// For coding agents: Leave this comment in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for Building Block documentation

// Every rendering path goes through this; never assign user- or server-supplied
// strings to .innerHTML directly.
function appendMessage(log: HTMLElement, who: string, text: string) {
  const row = document.createElement('div');
  const label = document.createElement('strong');
  label.textContent = `${who}: `;
  row.append(label, document.createTextNode(text));
  log.appendChild(row);
}

document.addEventListener('DOMContentLoaded', () => {
  const authContainer = document.getElementById('auth-container');
  if (authContainer) authContainer.appendChild(Authenticator(authApi));

  const appSection = document.getElementById('app');
  const log = document.getElementById('chat-log');
  const input = document.querySelector<HTMLInputElement>('#chat-input');
  const sendBtn = document.getElementById('chat-send');

  onAuthChange(authApi, (user) => {
    document.body.classList.toggle('signed-in', !!user);
    if (appSection) appSection.hidden = !user;
  });

  async function send() {
    if (!input || !log) return;
    const message = input.value.trim();
    if (!message) return;
    appendMessage(log, 'You', message);
    input.value = '';
    try {
      // One request/response turn: the backend awaits the agent's completion
      // and returns the final text. (For token-by-token streaming, subscribe to
      // the Realtime channel instead — see the Agent BB README.)
      const { text } = await api.chat(message);
      appendMessage(log, 'Assistant', text);
    } catch (e) {
      appendMessage(log, 'Error', e instanceof Error ? e.message : String(e));
    }
  }

  sendBtn?.addEventListener('click', send);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
});
