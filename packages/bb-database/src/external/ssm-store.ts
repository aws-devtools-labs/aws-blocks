// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SSMClient } from '@aws-sdk/client-ssm';
import { ssmConnectionLabel } from './connection.js';

/**
 * A stored value as the application reads it. `AppSetting.put()` and `Secret.put()` store a value as JSON, so a
 * string is held in quotes; `npm run db -- connect --stage` stores the string as it is. Both read the same here.
 */
export function decodeStoredValue(raw: string | null | undefined): string | null {
	if (raw === null || raw === undefined) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === 'string') return parsed;
	} catch {
		// Not JSON: the string itself.
	}
	return raw;
}

/**
 * The connection string in the SSM SecureString `parameterName`, with the label an error uses for it. For the
 * migration function and the command line, which have no app scope to read a setting through. The SDK client
 * is loaded here, so a caller that never reads a parameter does not load it.
 */
export async function readSsmConnectionString(
	parameterName: string,
	client?: SSMClient,
): Promise<{ value: string | null; label: string }> {
	const { GetParameterCommand, SSMClient: Client } = await import('@aws-sdk/client-ssm');
	const result = await (client ?? new Client({})).send(
		new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
	);
	return { value: decodeStoredValue(result.Parameter?.Value), label: ssmConnectionLabel(parameterName) };
}
