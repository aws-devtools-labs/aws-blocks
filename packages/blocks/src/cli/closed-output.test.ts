// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { CLOSED_OUTPUT_CODES } from '@aws-blocks/core/scripts';
import { CLI_CLOSED_OUTPUT_CODES } from './closed-output.js';

describe('the write errors the CLI drops', () => {
	it("are the ones core's runners drop", () => {
		// A code only core knows would again end the CLI parent while its runner still works.
		assert.deepStrictEqual([...CLI_CLOSED_OUTPUT_CODES].sort(), [...CLOSED_OUTPUT_CODES].sort());
	});
});
