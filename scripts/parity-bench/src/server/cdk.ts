// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// CDK-entry wiring for a stack that mounts the parity probes. Import from the stack's
// `index.cdk.ts` only (it pulls in the CDK layer of @aws-blocks/blocks).

import { registerConfig } from '@aws-blocks/blocks/cdk';
import type { Construct } from 'constructs';

/**
 * Carry the parity opt-in flags from the synth process to the deployed runtime.
 * Registers nothing unless the deploy itself runs with `E2E_PARITY_PROBES=true`,
 * so every other deploy of the stack leaves the probes answering 404 and builds
 * none of the packs' resources.
 */
export function enableParityProbes(stack: Construct): void {
	if (process.env.E2E_PARITY_PROBES !== 'true') return;
	registerConfig(stack, 'E2E_PARITY_PROBES', 'true');
	// Only for an account whose SES is in sandbox mode (see packs/msg.probe.ts).
	if (process.env.E2E_PARITY_SES_SANDBOX === 'true') {
		registerConfig(stack, 'E2E_PARITY_SES_SANDBOX', 'true');
	}
}
