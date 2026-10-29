// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parity probe catalog — every case the bench runs against the local dev
 * server and a deployed stack, then diffs (see the package README).
 *
 * Pure data with no runtime imports, so both a stack's backend (which executes a
 * case) and its test runner (which runs under `-C browser` and cannot load server
 * modules) import the same list from `@aws-blocks/parity-bench/catalog`.
 *
 * A case never asserts an expected value: it records what the Building Block
 * did, and the deployed run is the reference for the local run.
 */

import { cfgCases } from './cfg.cases.js';
import { dsqlCases } from './dsql.cases.js';
import { fbCases } from './fb.cases.js';
import { jobCases } from './job.cases.js';
import { kvCases } from './kv.cases.js';
import { msgCases } from './msg.cases.js';
import type { ParityCase } from '../core/types.js';

// msg last: its 50-recipient send is the one most likely to hit the SES sandbox send rate.
export const PARITY_CASES: readonly ParityCase[] = [
	...dsqlCases,
	...kvCases,
	...fbCases,
	...cfgCases,
	...jobCases,
	...msgCases,
];

/** Every pack id the bundled runners implement (`createProbeRunners`). */
export const PACK_IDS: readonly string[] = ['dsql', 'kv', 'fb', 'cfg', 'job', 'msg'];
