// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SSMClient } from '@aws-sdk/client-ssm';
import { ssmConnectionLabel } from './connection.js';

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
	return { value: result.Parameter?.Value ?? null, label: ssmConnectionLabel(parameterName) };
}
