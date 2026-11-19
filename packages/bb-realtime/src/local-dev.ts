// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal local-dev plumbing for Realtime. Not part of the public API.
 * Shared between the mock entry and the WebSocket server.
 */
import type { EventEmitter } from 'events';
import { randomBytes } from 'node:crypto';

let broadcastBus: EventEmitter | null = null;

/** Called by the dev server to wire up WebSocket broadcasting. */
export function setBroadcastBus(bus: EventEmitter) {
	broadcastBus = bus;
}

export function getBroadcastBus(): EventEmitter | null {
	return broadcastBus;
}

const SECRET_KEY = Symbol.for('@aws-cdk-blocks/bb-realtime.localTokenSecret');
const secretHolder = globalThis as unknown as Record<symbol, string | undefined>;

/**
 * Per-process random secret for local-dev channel-token signing, shared with the
 * WebSocket server. It used to be a constant published in this repository, so
 * anyone could mint a valid token for any channel. Both the minting side
 * (`getChannel`) and the validating side (`ws-server`) run in the one dev-server
 * process, so a random value needs no other change. It's held on `globalThis`
 * (like `bb-file-bucket`'s tokens) so duplicate copies of this module in one
 * process agree on it.
 */
secretHolder[SECRET_KEY] ??= randomBytes(32).toString('base64url');
export const LOCAL_TOKEN_SECRET: string = secretHolder[SECRET_KEY];

const REVOKED_KEY = Symbol.for('@aws-cdk-blocks/bb-realtime.localRevokedPrincipals');
const revokedHolder = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
/** When access was revoked per principal (unix seconds), shared with the WebSocket server like the secret above. */
revokedHolder[REVOKED_KEY] ??= new Map<string, number>();
const revokedAtByPrincipal: Map<string, number> = revokedHolder[REVOKED_KEY];

/** Record that access for `principal` was revoked now (the local counterpart of the deployed revocation record). */
export function revokePrincipal(principal: string): void {
	revokedAtByPrincipal.set(principal, Math.floor(Date.now() / 1000));
	broadcastBus?.emit('revoke', principal);
}

/** When access for `principal` was last revoked (unix seconds), or `undefined`. */
export function getRevokedAt(principal: string | undefined): number | undefined {
	return principal === undefined ? undefined : revokedAtByPrincipal.get(principal);
}
