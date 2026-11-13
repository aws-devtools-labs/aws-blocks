// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host classification shared by the local dev server's bind decision and the
 * realtime WebSocket's Origin check, so the two can never disagree about what
 * "loopback" or "wildcard" means. Accepts a bare host or a WHATWG
 * `URL.hostname` (which keeps IPv6 brackets, e.g. `[::1]`).
 */

/** Strip IPv6 brackets and lowercase (`[::1]` → `::1`). */
function normalizeHost(host: string): string {
	return host.trim().replace(/^\[|\]$/g, '').toLowerCase();
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Whether `host` is a loopback name/address, reachable only from this machine:
 * `localhost`, `127.0.0.0/8`, `::1`, or IPv4-mapped loopback (`::ffff:127.x.x.x`).
 */
export function isLoopbackHost(host: string): boolean {
	const h = normalizeHost(host);
	if (h === 'localhost' || h === '::1') return true;
	const v4 = h.startsWith('::ffff:') ? h.slice('::ffff:'.length) : h;
	const m = IPV4.exec(v4);
	return !!m && m[1] === '127';
}

/** Whether `host` is an all-interfaces bind address (`0.0.0.0`, `::`). */
export function isWildcardHost(host: string): boolean {
	const h = normalizeHost(host);
	return h === '0.0.0.0' || h === '::';
}

/**
 * Whether `host` is an IP address literal (IPv4, or bracketed/bare IPv6), as
 * opposed to a DNS name. A literal can't be re-pointed by DNS, which is what
 * makes a same-origin check against it immune to DNS rebinding.
 */
export function isIpLiteral(host: string): boolean {
	const h = normalizeHost(host);
	if (IPV4.test(h)) return h.split('.').every((o) => Number(o) <= 255);
	return h.includes(':') && /^[0-9a-f:.]+$/.test(h);
}
