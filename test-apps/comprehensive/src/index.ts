// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Comprehensive test frontend — exercises all Building Blocks from the browser
import { api, oidcAuthApi } from 'aws-blocks';

const w = window as any;

// ============================================================================
// Helpers
// ============================================================================

function show(id: string, text: string, ok = true) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
    el.className = `result ${ok ? 'success' : 'error'}`;
  }
}

function secureRandomIndex(bound: number): number {
  if (!Number.isInteger(bound) || bound <= 0) {
    throw new Error('bound must be a positive integer');
  }
  const max = 256;
  const limit = Math.floor(max / bound) * bound;
  const buf = new Uint8Array(1);
  let value = 0;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return value % bound;
}

async function run(id: string, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    show(id, JSON.stringify(result, null, 2));
  } catch (e: any) {
    show(id, `Error: ${e.message}`, false);
  }
}

// ============================================================================
// KVStore
// ============================================================================

w.kvPut = () => {
  const key = (document.getElementById('kv-key') as HTMLInputElement).value;
  const value = (document.getElementById('kv-value') as HTMLInputElement).value;
  run('kv-result', () => api.kvPut(key, value));
};

w.kvGet = () => {
  const key = (document.getElementById('kv-key') as HTMLInputElement).value;
  run('kv-result', () => api.kvGet(key));
};

w.kvDelete = () => {
  const key = (document.getElementById('kv-key') as HTMLInputElement).value;
  run('kv-result', () => api.kvDelete(key));
};

// ============================================================================
// DistributedTable
// ============================================================================

w.dtPut = () => {
  const pk = (document.getElementById('dt-pk') as HTMLInputElement).value;
  const sk = (document.getElementById('dt-sk') as HTMLInputElement).value;
  const data = (document.getElementById('dt-data') as HTMLInputElement).value;
  run('dt-result', () => api.tablePut({ pk, sk, data, timestamp: Date.now() }));
};

w.dtGet = () => {
  const pk = (document.getElementById('dt-pk') as HTMLInputElement).value;
  const sk = (document.getElementById('dt-sk') as HTMLInputElement).value;
  run('dt-result', () => api.tableGet({ pk, sk }));
};

w.dtQuery = () => {
  const pk = (document.getElementById('dt-pk') as HTMLInputElement).value;
  run('dt-result', () => api.tableQuery({ index: 'byTimestamp', where: { pk: { equals: pk } } }));
};

w.dtList = () => run('dt-result', () => api.tableScan());

w.dtDelete = () => {
  const pk = (document.getElementById('dt-pk') as HTMLInputElement).value;
  const sk = (document.getElementById('dt-sk') as HTMLInputElement).value;
  run('dt-result', () => api.tableDelete({ pk, sk }));
};

// ============================================================================
// API Context
// ============================================================================

w.echoHeaders = () => run('ctx-result', () => api.echoHeaders());
w.echoData = () => run('ctx-result', () => api.echoData({ test: true, n: 42, arr: [1, 2] }));
w.testError = () => run('ctx-result', () => api.throwError('intentional test error'));

// ============================================================================
// Auth
// ============================================================================

w.authRequired = () => run('auth-result', () => api.authRequired());

// ============================================================================
// AuthOIDC (Client-initiated PKCE against stub IdP)
// ============================================================================

const auth = await oidcAuthApi.getClient();
w.oidcSignInGoogle = () => auth.signIn('google');
w.oidcSignInCorporate = () => auth.signIn('corporate');

w.oidcHandleCallback = async () => {
  try {
    const user = await auth.handleRedirectCallback();
    if (user) {
      show('oidc-result', `Signed in! ${JSON.stringify(user, null, 2)}`);
      window.history.replaceState({}, '', '/');
    } else {
      show('oidc-result', 'No pending OIDC flow', false);
    }
  } catch (e: any) {
    show('oidc-result', `Error: ${e.message}`, false);
  }
};

w.oidcGetUser = () => run('oidc-result', () => api.oidcGetCurrentUser());

w.oidcSignOut = async () => {
  await auth.signOut();
  show('oidc-result', 'Signed out');
};

// Auto-handle callback if we landed here with ?code=&state=
if (window.location.search.includes('code=') && window.location.search.includes('state=')) {
  w.oidcHandleCallback();
}

// ============================================================================
// AsyncJob
// ============================================================================

w.jobSubmit = () => {
  const key = (document.getElementById('job-key') as HTMLInputElement).value;
  const value = (document.getElementById('job-value') as HTMLInputElement).value;
  run('job-result', () => api.asyncJobSubmit(key, value));
};

w.jobGetResult = () => {
  const key = (document.getElementById('job-key') as HTMLInputElement).value;
  run('job-result', () => api.asyncJobGetResult(key));
};

w.jobSubmitBatch = () => {
  const key = (document.getElementById('job-key') as HTMLInputElement).value || 'batch';
  run('job-result', () => api.asyncJobSubmitBatch([
    { key: `${key}-0`, value: 'a' },
    { key: `${key}-1`, value: 'b' },
    { key: `${key}-2`, value: 'c' },
  ]));
};

w.jobSubmitTooLarge = () => run('job-result', () => api.asyncJobSubmitTooLarge());
w.jobSubmitBatchTooMany = () => run('job-result', () => api.asyncJobSubmitBatchTooMany());

w.jobSubmitDelayed = () => {
  const key = (document.getElementById('job-key') as HTMLInputElement).value;
  const value = (document.getElementById('job-value') as HTMLInputElement).value;
  const delay = parseInt((document.getElementById('job-delay') as HTMLInputElement).value) || 5;
  run('job-result', () => api.asyncJobSubmitDelayed(key, value, delay));
};

// Schema-validated job
w.jobSubmitValidated = () => {
  const to = (document.getElementById('job-to') as HTMLInputElement).value;
  const subject = (document.getElementById('job-subject') as HTMLInputElement).value;
  const body = (document.getElementById('job-body') as HTMLInputElement).value;
  run('job-validated-result', () => api.asyncJobSubmitValidated(to, subject, body));
};

w.jobSubmitValidatedBatch = () => {
  const to = (document.getElementById('job-to') as HTMLInputElement).value || 'alice@example.com';
  const subject = (document.getElementById('job-subject') as HTMLInputElement).value || 'Hello';
  const body = (document.getElementById('job-body') as HTMLInputElement).value || 'Test body';
  run('job-validated-result', () => api.asyncJobSubmitValidatedBatch([
    { to, subject, body },
    { to: `second-${to}`, subject: `Re: ${subject}`, body },
  ]));
};

w.jobSubmitInvalid = () => {
  run('job-validated-result', () => api.asyncJobSubmitValidated('not-an-email', 'Subject', 'Body'));
};

// ============================================================================
// Realtime Cursors
// ============================================================================

const userId = crypto.randomUUID().slice(0, 8);
const COLORS = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7', '#a29bfe', '#fd79a8', '#00b894'];
const myColor = COLORS[secureRandomIndex(COLORS.length)];

const realtimeArea = document.getElementById('realtime-area')!;
const cursors = new Map<string, HTMLElement>();
const statusEl = document.getElementById('realtime-status')!;

function cursorSvg(color: string): string {
  return `<svg viewBox="0 0 24 24" fill="${color}" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 3l14 8-6.5 1.5L11 19z" stroke="#000" stroke-width="1"/>
  </svg>`;
}

function getOrCreateCursor(id: string, color: string): HTMLElement {
  let el = cursors.get(id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'cursor-dot';
    el.innerHTML = `${cursorSvg(color)}<span class="label" style="background:${color};color:#000">${id}</span>`;
    realtimeArea.appendChild(el);
    cursors.set(id, el);
  }
  return el;
}

const lastSeen = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [id, time] of lastSeen) {
    if (now - time > 3000) {
      cursors.get(id)?.remove();
      cursors.delete(id);
      lastSeen.delete(id);
    }
  }
}, 1000);

// Use the API to get a channel handle (same pattern as e2e tests)
try {
  const channel = await api.realtimeGetCursorChannel();

  channel.subscribe((msg: { userId: string; x: number; y: number; color: string }) => {
    if (msg.userId === userId) return;
    const el = getOrCreateCursor(msg.userId, msg.color);
    el.style.left = `${msg.x}px`;
    el.style.top = `${msg.y}px`;
    lastSeen.set(msg.userId, Date.now());
  });

  statusEl.textContent = `Connected as ${userId}`;

  // Only track mouse within the realtime section
  let lastPublish = 0;
  realtimeArea.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - lastPublish < 50) return;
    lastPublish = now;
    const rect = realtimeArea.getBoundingClientRect();
    api.realtimePublishCursor({
      userId,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      color: myColor,
    });
  });
} catch (e: any) {
  statusEl.textContent = `Realtime error: ${e.message}`;
  statusEl.style.color = 'red';
}

console.log('[Comprehensive Test App] Loaded — all Building Blocks wired up');

// ============================================================================
// Agent Chat
// ============================================================================

import { useChat } from '@aws-blocks/bb-agent/client';

const chatMessages = document.getElementById('chat-messages')!;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const chatStatus = document.getElementById('chat-status')!;
const chatConvos = document.getElementById('chat-convos')!;

const conversations: { conversationId: string; name: string }[] = [];
let activeChat: ReturnType<typeof useChat> | null = null;
let activeConvoId: string | null = null;

function renderConvoList() {
	chatConvos.innerHTML = conversations.map(c => {
		const isActive = c.conversationId === activeConvoId;
		const label = c.name || c.conversationId.slice(0, 8) + '...';
		return `<div style="display:flex; justify-content:space-between; align-items:center; padding:4px; ${isActive ? 'background:#e3f2fd;' : ''} cursor:pointer; border-radius:4px; margin-bottom:2px;">
			<span onclick="chatSelect('${c.conversationId}')" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${label}</span>
			<button onclick="chatDelete('${c.conversationId}')" style="font-size:10px; padding:1px 4px; margin-left:4px;">✕</button>
		</div>`;
	}).join('');
}

// Load existing conversations from server on startup
async function loadConversationList() {
	try {
		const { conversations: list } = await api.agentListConversations();
		conversations.length = 0;
		for (const c of list) conversations.push(c);
		renderConvoList();
	} catch (e: any) {
		console.warn('[Chat] Failed to load conversations:', e.message);
	}
}
loadConversationList();

function createChatForConvo(conversationId: string) {
	// Destroy previous chat instance
	if (activeChat) activeChat.destroy();

	activeConvoId = conversationId;
	activeChat = useChat({
		api: {
			createConversation: async () => ({ conversationId }),
			getConversation: async (id) => await api.agentGetConversation(id),
			getPendingInterrupts: async (id) => await api.agentGetPendingInterrupts(id),
		},
		// One SSE-shaped transport. Here it wraps the buffered RPC (agentStream/agentResume
		// return { chunks }); a production client would open a real SSE stream to the AgentCore
		// Runtime instead. Either way it yields AgentStreamChunk objects.
		streamChunks: async function* ({ conversationId: convId, message, interruptResponses }) {
			const { chunks } = interruptResponses
				? await api.agentResume(interruptResponses, convId)
				: await api.agentStream(message ?? '', convId);
			for (const chunk of chunks) yield chunk;
		},
		onMessagesChange: (msgs) => {
			chatMessages.innerHTML = msgs.map(m => {
				if (m.role === 'approval') {
					const approved = m.metadata?.approved;
					const tool = m.metadata?.toolName ?? '';
					const icon = approved ? '✓' : '✗';
					const color = approved ? '#388e3c' : '#c62828';
					const bg = approved ? '#e8f5e9' : '#ffebee';
					return `<div style="margin:4px 0; padding:4px 8px; background:${bg}; border-radius:4px; color:${color};"><strong>${icon} ${tool}: ${approved ? 'Approved' : 'Denied'}</strong></div>`;
				}
				return `<div style="margin:4px 0;"><strong style="color:${m.role === 'user' ? '#1976d2' : '#388e3c'}">${m.role}:</strong> ${m.content || '...'}</div>`;
			}).join('');
			chatMessages.scrollTop = chatMessages.scrollHeight;
		},
		onLoadingChange: (loading) => {
			chatStatus.textContent = loading ? 'Agent is thinking...' : '';
		},
		onChunk: (chunk) => {
			if (chunk.type === 'tool-call') {
				chatStatus.textContent = `🔧 Calling ${chunk.toolName}...`;
			}
		},
		onInterrupt: (interrupts) => {
			chatStatus.textContent = '⏸️ Waiting for input...';
			// Remove any existing interrupt boxes
			document.querySelectorAll('.blocks-approval-box').forEach(el => el.remove());
			chatMessages.innerHTML += interrupts.map(i => {
				const toolName = i.reason?.tool ?? i.name;
				const isCustomInterrupt = i.reason?.message && i.reason?.trustable === undefined;

				// Custom interrupt — show message with Yes/No (or freeform input in future)
				if (isCustomInterrupt) {
					return `<div class="blocks-approval-box" id="approval-${i.id}" style="margin:12px 0; padding:12px; border:2px solid #1565c0; border-radius:8px; background:#e3f2fd; color:#333;">
						<strong style="font-size:1.1em; color:#1565c0;">⚡ ${toolName}:</strong> ${i.reason.message}<br/>
						<pre style="margin:8px 0; font-size:0.85em; background:#e8eaf6; padding:8px; border-radius:4px; color:#333;">${JSON.stringify(i.reason?.input, null, 2)}</pre>
						<button style="padding:8px 16px; margin:4px; background:#4caf50; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1em;" onclick="window.respondInterrupt('${i.id}', 'yes', '${toolName}')">✅ Yes</button>
						<button style="padding:8px 16px; margin:4px; background:#f44336; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1em;" onclick="window.respondInterrupt('${i.id}', 'no', '${toolName}')">❌ No</button>
					</div>`;
				}

				// Standard approval interrupt
				const trustBtn = i.reason?.trustable
					? `<button style="padding:8px 16px; margin:4px; background:#2196f3; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1em;" onclick="window.approveInterrupt('${i.id}', true, '${toolName}', true)">🤝 Trust</button>`
					: '';
				return `<div class="blocks-approval-box" id="approval-${i.id}" style="margin:12px 0; padding:12px; border:2px solid #e65100; border-radius:8px; background:#fff3e0; color:#333;">
					<strong style="font-size:1.1em; color:#e65100;">🔒 Approval needed:</strong> ${toolName}<br/>
					<pre style="margin:8px 0; font-size:0.85em; background:#fff8e1; padding:8px; border-radius:4px; color:#333;">${JSON.stringify(i.reason?.input, null, 2)}</pre>
					<button style="padding:8px 16px; margin:4px; background:#4caf50; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1em;" onclick="window.approveInterrupt('${i.id}', true, '${toolName}')">✅ Yes</button>
					${trustBtn}
					<button style="padding:8px 16px; margin:4px; background:#f44336; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1em;" onclick="window.approveInterrupt('${i.id}', false, '${toolName}')">❌ No</button>
				</div>`;
			}).join('');
		},
	});
	renderConvoList();
}


w.approveInterrupt = async (interruptId: string, approved: boolean, toolName: string, trust?: boolean) => {
	if (!activeChat) return;
	const box = document.getElementById(`approval-${interruptId}`);
	if (box) {
		const label = trust ? 'Trusted' : approved ? 'Approved' : 'Denied';
		box.style.border = `2px solid ${approved ? '#4caf50' : '#f44336'}`;
		box.style.background = approved ? '#e8f5e9' : '#ffebee';
		box.innerHTML = `<strong style="color:${approved ? '#388e3c' : '#c62828'};">${approved ? '✓' : '✗'} ${toolName}: ${label}</strong>`;
	}
	await activeChat.respondToInterrupt([{ interruptId, approved, trust, toolName }]);
};

w.respondInterrupt = async (interruptId: string, response: string, toolName: string) => {
	if (!activeChat) return;
	const box = document.getElementById(`approval-${interruptId}`);
	if (box) {
		const approved = response === 'yes';
		box.style.border = `2px solid ${approved ? '#4caf50' : '#f44336'}`;
		box.style.background = approved ? '#e8f5e9' : '#ffebee';
		box.innerHTML = `<strong style="color:${approved ? '#388e3c' : '#c62828'};">${approved ? '✓' : '✗'} ${toolName}: ${response}</strong>`;
	}
	await activeChat.respondToInterrupt([{ interruptId, approved: response === 'yes', toolName }]);
};

w.chatNew = async () => {
	try {
		const { conversationId } = await api.agentCreateConversationId();
		conversations.unshift({ conversationId, name: conversationId });
		createChatForConvo(conversationId);
		chatMessages.innerHTML = '<div style="color:#999;">New conversation. Type a message to start.</div>';
	} catch (e: any) {
		chatStatus.textContent = `Error: ${e.message}`;
	}
};

w.chatSelect = async (id: string) => {
	createChatForConvo(id);
	await activeChat!.loadConversation(id);
};

w.chatDelete = async (id: string) => {
	try {
		await api.agentDeleteConversation(id);
		const idx = conversations.findIndex(c => c.conversationId === id);
		if (idx >= 0) conversations.splice(idx, 1);
		if (activeConvoId === id) {
			activeConvoId = null;
			activeChat = null;
			chatMessages.innerHTML = '';
		}
		renderConvoList();
	} catch (e: any) {
		chatStatus.textContent = `Error: ${e.message}`;
	}
};

w.chatSend = async () => {
	const text = chatInput.value.trim();
	if (!text) return;
	if (!activeChat) {
		// Auto-create conversation on first send
		await w.chatNew();
	}
	chatInput.value = '';
	try {
		await activeChat!.sendMessage(text);
	} catch (e: any) {
		chatStatus.textContent = `Error: ${e.message}`;
	}
};
