// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub — Secret runs server-side only. Reading or writing a secret in
// the browser would expose it to the client, so instantiation throws.
import { SecretErrors } from './errors.js';
import type { ExternalSecretRef } from './types.js';

export { SecretErrors } from './errors.js';
export type { ExternalSecretRef, SecretOptions } from './types.js';

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

export class Secret {
	constructor(..._args: unknown[]) {
		throw blocksError(
			SecretErrors.NotSupported,
			'Secret cannot be instantiated in browser/client code — it runs server-side only.',
		);
	}

	static fromExisting(secretArn: string): ExternalSecretRef {
		return { __brand: 'ExternalSecretRef' as const, secretArn };
	}
}
