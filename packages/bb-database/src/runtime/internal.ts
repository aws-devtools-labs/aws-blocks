// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DatabaseEngine } from '@aws-blocks/data-common';
import { configError } from '../errors.js';

interface InternalAccess {
	engine(): Promise<DatabaseEngine>;
	simulateConflict(): void;
	readonly migrationsPath: string | undefined;
}

const registry = new WeakMap<object, InternalAccess>();

export function registerInternalAccess(db: object, access: InternalAccess): void {
	registry.set(db, access);
}

export function internalAccess(db: object, caller: string): InternalAccess {
	const access = registry.get(db);
	if (!access) {
		throw configError(
			`${caller}: expected a Database constructed by the local or Lambda entry point; a CDK synth build has no engine.`,
		);
	}
	return access;
}
