// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal subscribe-only client for a shape's bell channel. Speaks the
 * `bb-realtime` WebSocket protocol (`subscribe` / `message`), which the local
 * dev server and API Gateway both implement, so it works the same locally, in
 * a sandbox, and in production without depending on which realtime client
 * middleware the page loaded. One socket per endpoint; channels multiplex.
 *
 * Browser-safe: uses the global `WebSocket`.
 */

import type { ShapeBell } from '@aws-blocks/data-common/sync-shared';

/** Callbacks for one bell subscription. */
export interface BellHandlers {
  /** The table changed. `message` is the bell's payload. */
  onRing(message: unknown): void;
  /** The subscription was confirmed again after the socket reconnected; rings may have been missed. */
  onReconnect(): void;
  /** The server rejected the subscription (for example, an expired channel token). */
  onReject(message: string): void;
}

interface Subscription {
  token: string;
  handlers: BellHandlers;
  /** Resolves when the server confirms the subscription (or refuses it). */
  confirm: () => void;
}

interface Connection {
  url: string;
  ws: WebSocket | null;
  open: boolean;
  /** channel → subscriptions */
  channels: Map<string, Set<Subscription>>;
  /** Channels resubscribed after a reconnect, waiting for confirmation. */
  resubscribing: Set<string>;
  attempts: number;
  everOpened: boolean;
  ping?: ReturnType<typeof setInterval>;
  retry?: ReturnType<typeof setTimeout>;
}

/** API Gateway closes idle WebSockets after 10 minutes. */
const PING_INTERVAL_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30_000;

const connections = new Map<string, Connection>();

function send(conn: Connection, message: unknown): void {
  if (conn.open && conn.ws) conn.ws.send(JSON.stringify(message));
}

function subscribeAll(conn: Connection): void {
  for (const [channel, subs] of conn.channels) {
    const first = subs.values().next().value;
    if (first) send(conn, { action: 'subscribe', channel, token: first.token });
  }
}

function connect(conn: Connection): void {
  if (typeof WebSocket === 'undefined') return;
  const ws = new WebSocket(conn.url);
  conn.ws = ws;
  ws.onopen = () => {
    conn.open = true;
    const reconnected = conn.everOpened;
    conn.everOpened = true;
    conn.attempts = 0;
    if (reconnected) for (const channel of conn.channels.keys()) conn.resubscribing.add(channel);
    subscribeAll(conn);
    clearInterval(conn.ping);
    conn.ping = setInterval(() => send(conn, { action: 'ping' }), PING_INTERVAL_MS);
  };
  ws.onmessage = (event) => {
    let message: { type?: string; channel?: string; message?: string; data?: unknown };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const subs = message.channel ? conn.channels.get(message.channel) : undefined;
    if (!subs) return;
    if (message.type === 'message') {
      for (const sub of subs) sub.handlers.onRing(message.data);
    } else if (message.type === 'subscribe_success') {
      for (const sub of subs) sub.confirm();
      // After a reconnect, only a confirmed subscription is past the gap.
      if (message.channel && conn.resubscribing.delete(message.channel)) {
        for (const sub of subs) sub.handlers.onReconnect();
      }
    } else if (message.type === 'error') {
      for (const sub of subs) {
        sub.confirm();
        sub.handlers.onReject(message.message ?? 'rejected');
      }
    }
  };
  ws.onclose = () => {
    conn.open = false;
    conn.ws = null;
    clearInterval(conn.ping);
    if (conn.channels.size === 0) return;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** conn.attempts++);
    conn.retry = setTimeout(() => connect(conn), delay);
  };
  ws.onerror = () => {
    // `onclose` follows and schedules the reconnect.
  };
}

/** How long a shape waits for its bells to be confirmed before its first load. */
const CONFIRM_TIMEOUT_MS = 2_000;

/**
 * Subscribe to a bell. Returns an unsubscribe function and a promise that
 * resolves once the server has confirmed the subscription (or refused it, or
 * after a short timeout), so a shape can load after that and miss no ring.
 * Returns `null` when the environment has no `WebSocket` (the caller then
 * falls back to a timer).
 */
export function subscribeBell(
  bell: ShapeBell,
  handlers: BellHandlers,
): { unsubscribe: () => void; confirmed: Promise<void> } | null {
  if (typeof WebSocket === 'undefined') return null;
  const url = `${bell.wsUrl}?token=${encodeURIComponent(bell.connectToken)}`;
  let conn = connections.get(url);
  if (!conn) {
    conn = { url, ws: null, open: false, channels: new Map(), resubscribing: new Set(), attempts: 0, everOpened: false };
    connections.set(url, conn);
  }
  let confirm!: () => void;
  const confirmed = new Promise<void>((resolve) => {
    confirm = resolve;
    setTimeout(resolve, CONFIRM_TIMEOUT_MS);
  });
  const sub: Subscription = { token: bell.token, handlers, confirm };
  let subs = conn.channels.get(bell.channel);
  const isNewChannel = !subs;
  if (!subs) {
    subs = new Set();
    conn.channels.set(bell.channel, subs);
  }
  subs.add(sub);
  if (!conn.ws) connect(conn);
  else if (isNewChannel) send(conn, { action: 'subscribe', channel: bell.channel, token: bell.token });

  const owner = conn;
  const unsubscribe = () => {
    const current = owner.channels.get(bell.channel);
    if (!current) return;
    current.delete(sub);
    if (current.size > 0) return;
    owner.channels.delete(bell.channel);
    send(owner, { action: 'unsubscribe', channel: bell.channel });
    if (owner.channels.size === 0) {
      clearTimeout(owner.retry);
      clearInterval(owner.ping);
      owner.ws?.close();
      connections.delete(url);
    }
  };
  return { unsubscribe, confirmed };
}
