// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Print the deployed e2e stack's test-support secret to stdout, and nothing
 * else. Usage: `tsx test/read-test-support-secret.ts <outputs.json>`.
 *
 * `test-support.ts` runs this in a clean subprocess (no `-C browser`) rather
 * than calling SSM itself. The e2e harness runs under `tsx -C browser`, and
 * there the AWS SDK resolves its browser build, whose `SSMClient` constructor
 * throws `TypeError: (0 , client_1.emitWarningIfUnsupportedVersion) is not a
 * function`. Deploy and destroy run in a subprocess for the same reason
 * (`sandbox-deploy.ts`).
 *
 * The parameter is named by the `TestSupportSecretParameter*` output in
 * `outputs.json` (written by both the sandbox and the production deploy).
 * Never log the value: it goes to stdout only, which the caller captures.
 */

import { readFileSync } from 'node:fs';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const outputsPath = process.argv[2];
if (!outputsPath) throw new Error('usage: read-test-support-secret.ts <outputs.json>');

const outputs: Record<string, Record<string, string>> = JSON.parse(readFileSync(outputsPath, 'utf-8'));
const name = Object.values(outputs)
	.flatMap((stackOutputs) => Object.entries(stackOutputs))
	.find(([key]) => key.startsWith('TestSupportSecretParameter'))?.[1];
if (!name) throw new Error(`TestSupportSecretParameter* not found in ${outputsPath}`);

const out = await new SSMClient({}).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
if (!out.Parameter?.Value) throw new Error(`SSM parameter ${name} has no value`);
process.stdout.write(out.Parameter.Value);
