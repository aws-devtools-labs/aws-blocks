// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Configuration (bb-secret + bb-app-setting) parity runner for cfg.cases.ts.
//
// Every value is generated here, server-side, and NEVER returned: `act` reports
// only sizes, equality booleans, counts and error names.

import { randomUUID } from 'node:crypto';
import type { Scope } from '@aws-blocks/blocks';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import { Secret } from '@aws-blocks/bb-secret';
import { describeError, param, pollFor, runCase } from '../server/helpers.js';
import { trackBlock } from '../server/track.js';
import type { ProbeRunner } from '../core/types.js';

/** A random ASCII string of exactly `bytes` UTF-8 bytes (hex head, so every call differs). */
function asciiOfBytes(bytes: number): string {
	const head = randomUUID().replace(/-/g, '');
	return (head + 'a'.repeat(Math.max(0, bytes - head.length))).slice(0, bytes);
}

/** A string of exactly `bytes` UTF-8 bytes made mostly of `€` (3 bytes, 1 UTF-16 unit) plus a random ASCII tail. */
function multibyteOfBytes(bytes: number): string {
	const euros = Math.floor((bytes - 32) / 3);
	return '€'.repeat(euros) + asciiOfBytes(bytes - euros * 3);
}

function sized(charset: string, bytes: number): string {
	if (charset === 'ascii') return asciiOfBytes(bytes);
	if (charset === 'multibyte') return multibyteOfBytes(bytes);
	throw new Error(`unknown cfg charset ${charset}`);
}

const byteLength = (v: string): number => Buffer.byteLength(v, 'utf8');

/** Mutable per-case state: whether `act` changed a stored value, so `cleanup` restores only then. */
interface Wrote {
	wrote: boolean;
}

const fresh = async (): Promise<Wrote> => ({ wrote: false });

/**
 * Constructs its own minimal instances (once, at module load):
 * - `pty-sec`  writable Secret with the DEFAULT read cache (300 s), so the deployed run exercises the cached path.
 *   Every case that reads it does a put() first in the same invocation, which clears that cache.
 * - `pty-sgen` read-only `generate: true` Secret, never written.
 * - `pty-as`   plain AppSetting (SSM String) with an explicit name, so `pty-asr` can reference it.
 * - `pty-ass`  `secret: true` AppSetting (SSM SecureString).
 * - `pty-asr`  `AppSetting.fromExisting()` pointing at `pty-as`'s parameter name (read-only, creates nothing).
 */
export function cfgProbe(scope: Scope): ProbeRunner {
	const sec = trackBlock(new Secret(scope, 'pty-sec', { allowRuntimeWrite: true, removalPolicy: 'destroy' }));
	const gen = trackBlock(new Secret(scope, 'pty-sgen', { generate: true, removalPolicy: 'destroy' }));
	const settingName = `/${scope.fullId}/pty-as`;
	const SETTING_BASELINE = 'parity-baseline';
	const plain = trackBlock(new AppSetting(scope, 'pty-as', { name: settingName, value: SETTING_BASELINE }));
	const secure = trackBlock(new AppSetting(scope, 'pty-ass', { secret: true }));
	const alias = AppSetting.fromExisting(scope, 'pty-asr', { name: settingName });

	const restoreSecret = async (s: Wrote | undefined): Promise<void> => {
		if (s?.wrote) await sec.put(asciiOfBytes(32));
	};

	return (c) => {
		const kind = param(c.params, 'kind', 'string');
		switch (kind) {
			case 'secret-size': {
				const value = sized(param(c.params, 'charset', 'string'), param(c.params, 'bytes', 'number'));
				return runCase({
					setup: fresh,
					act: async (s) => {
						await sec.put(value);
						s.wrote = true;
						const read = await sec.get();
						return {
							putBytes: byteLength(value),
							putChars: value.length,
							readBytes: read === null ? null : byteLength(read),
							roundTrip: read === value,
						};
					},
					cleanup: restoreSecret,
				});
			}

			case 'secret-empty':
				return runCase({
					setup: fresh,
					act: async (s) => {
						await sec.put('');
						s.wrote = true;
						const read = await sec.get();
						return { readIsNull: read === null, readLength: read === null ? null : read.length };
					},
					cleanup: restoreSecret,
				});

			case 'secret-special': {
				const value = `q"uote' back\\slash\nnew\r\nline\ttab 日本語 😀 {"json":true,"n":[1,2]} <b>&amp;</b> %20 ${randomUUID()}`;
				return runCase({
					setup: fresh,
					act: async (s) => {
						await sec.put(value);
						s.wrote = true;
						const read = await sec.get();
						return { putBytes: byteLength(value), readBytes: read === null ? null : byteLength(read), roundTrip: read === value };
					},
					cleanup: restoreSecret,
				});
			}

			case 'secret-read-after-write': {
				const first = asciiOfBytes(40);
				const second = asciiOfBytes(40);
				return runCase({
					setup: fresh,
					act: async () => {
						await sec.put(first);
						await sec.put(second);
						const current = await sec.get();
						const previous = await sec.get({ version: 'previous' });
						const versions = await sec.listVersions();
						const newest = versions[0];
						// A stale first read would be pinned by the runtime's read cache, so
						// polling through the same instance also shows whether it ever recovers.
						const currentMatches = current === second;
						const convergedWithin5s =
							currentMatches || ((await pollFor(async () => ((await sec.get()) === second ? true : undefined), 5000)) ?? false);
						return {
							currentMatches,
							previousMatches: previous === first,
							convergedWithin5s,
							versionCount: versions.length,
							stages: versions.map((v) => [...v.stages].sort().join('+')),
							newestReadsCurrent: newest === undefined ? null : (await sec.get({ version: newest })) === second,
						};
					},
					// Leaves a short random value behind; nothing to restore.
				});
			}

			case 'secret-malformed-version':
				return runCase({
					setup: fresh,
					act: async () => {
						const read = await sec.get({ version: { versionId: 'not-a-version' } });
						return { isNull: read === null };
					},
				});

			case 'secret-generate':
				return runCase({
					setup: fresh,
					act: async () => {
						const value = await gen.get();
						const versions = await gen.listVersions();
						return {
							isNull: value === null,
							length: value === null ? null : value.length,
							base64urlOnly: value === null ? null : /^[A-Za-z0-9_-]*$/.test(value),
							hasUpper: value === null ? null : /[A-Z]/.test(value),
							hasLower: value === null ? null : /[a-z]/.test(value),
							hasDigit: value === null ? null : /[0-9]/.test(value),
							versionCount: versions.length,
							stages: versions.map((v) => [...v.stages].sort().join('+')),
						};
					},
				});

			case 'setting-size': {
				const isSecret = param(c.params, 'secret', 'boolean');
				const target = isSecret ? secure : plain;
				// The block JSON-encodes the value; generated chars are never escaped, so it adds exactly two quote bytes.
				const value = sized(param(c.params, 'charset', 'string'), param(c.params, 'serializedBytes', 'number') - 2);
				const serialized = JSON.stringify(value);
				return runCase({
					setup: fresh,
					act: async (s) => {
						await target.put(value);
						s.wrote = true;
						const read = await target.get();
						return { serializedBytes: byteLength(serialized), serializedChars: serialized.length, roundTrip: read === value };
					},
					cleanup: async (s) => {
						if (s?.wrote) await target.put(isSecret ? asciiOfBytes(32) : SETTING_BASELINE);
					},
				});
			}

			case 'setting-double-brace': {
				const value = `Hello {{name}}, your code is ${randomUUID()}`;
				return runCase({
					setup: fresh,
					act: async (s) => {
						await plain.put(value);
						s.wrote = true;
						return { roundTrip: (await plain.get()) === value };
					},
					cleanup: async (s) => {
						if (s?.wrote) await plain.put(SETTING_BASELINE);
					},
				});
			}

			case 'setting-alias': {
				const value = asciiOfBytes(40);
				return runCase({
					setup: fresh,
					act: async (s) => {
						await plain.put(value);
						s.wrote = true;
						const viaWriter = await plain.get();
						const viaAlias = await alias.get();
						return { writerMatches: viaWriter === value, aliasMatches: viaAlias === value, aliasIsEmpty: viaAlias === '' };
					},
					cleanup: async (s) => {
						if (s?.wrote) await plain.put(SETTING_BASELINE);
					},
				});
			}

			case 'setting-burst': {
				const values = Array.from({ length: param(c.params, 'writes', 'number') }, () => asciiOfBytes(40));
				return runCase({
					setup: fresh,
					act: async (s) => {
						const results = await Promise.allSettled(values.map((v) => plain.put(v)));
						const succeeded = results.filter((r) => r.status === 'fulfilled').length;
						if (succeeded > 0) s.wrote = true;
						const errorNames = [
							...new Set(results.flatMap((r) => (r.status === 'rejected' ? [describeError(r.reason).name] : []))),
						].sort();
						const final = await plain.get();
						return { attempted: values.length, succeeded, errorNames, finalIsAWrittenValue: values.includes(final) };
					},
					cleanup: async (s) => {
						if (s?.wrote) await plain.put(SETTING_BASELINE);
					},
				});
			}

			default:
				throw new Error(`unknown cfg case kind ${kind}`);
		}
	};
}
