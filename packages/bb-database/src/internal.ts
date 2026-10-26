// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The internal access channel: what a `Database` exposes to this package's own
 * modules (the `testing` entry, future adapters, unit tests) without putting it
 * on the public class. The mock and aws entries register at construction; the
 * cdk entry does not, so a synth build fails loudly here.
 */
import type { DatabaseEngine } from '@aws-blocks/data-common';
import { configError } from './errors.js';

export interface InternalAccess {
	/** The underlying engine, memoized; may run migrations first. */
	engine(): Promise<DatabaseEngine>;
	/** Local mode: make the next commit fail with `SerializationFailure`. Throws elsewhere. */
	simulateConflict(): void;
	/** The resolved migrations directory; `undefined` when absent or in the Lambda runtime. */
	readonly migrationsPath: string | undefined;
}

const registry = new WeakMap<object, InternalAccess>();

/** Called by a `Database` constructor. */
export function registerInternalAccess(db: object, access: InternalAccess): void {
	registry.set(db, access);
}

/** Resolve the channel for `db`; `caller` names the API in the error when there is none. */
export function internalAccess(db: object, caller: string): InternalAccess {
	const access = registry.get(db);
	if (!access) {
		throw configError(
			`${caller}: expected a Database constructed by the local or Lambda entry point; a CDK synth build has no engine.`,
		);
	}
	return access;
}
