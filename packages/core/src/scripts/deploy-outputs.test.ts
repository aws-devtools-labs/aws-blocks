// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OUTPUTS_DIR, OUTPUTS_FILE, outputsFileIn } from './deploy-outputs.js';

describe('OUTPUTS_FILE — one document per stage', () => {
	// The defect this exists to prevent: with one name, `npm run deploy` and
	// `npm run sandbox` wrote the same file, so the later run erased the earlier
	// stage's record and anything reading it got the wrong stack. Distinctness is
	// the whole fix, so it is asserted on its own rather than implied by the
	// pinned values below.
	it('gives the two stages different names', () => {
		assert.notStrictEqual(OUTPUTS_FILE.sandbox, OUTPUTS_FILE.production);
	});

	it('pins both paths, so a rename is a deliberate change', () => {
		assert.deepStrictEqual(
			{ ...OUTPUTS_FILE },
			{
				sandbox: '.blocks-sandbox/outputs.json',
				production: '.blocks-sandbox/outputs.production.json',
			},
		);
	});

	// Both documents are per-deploy, account-specific local state. They sit in
	// the directory that is already ignored, rather than the committed `.blocks/`,
	// so neither can be committed by forgetting an ignore entry.
	it('keeps both documents in the ignored state directory', () => {
		for (const file of Object.values(OUTPUTS_FILE)) {
			assert.strictEqual(file.startsWith(`${OUTPUTS_DIR}/`), true, file);
		}
	});

	it('has exactly the two deploying stages, so local cannot ask for a document', () => {
		assert.deepStrictEqual(Object.keys(OUTPUTS_FILE).sort(), ['production', 'sandbox']);
	});
});

describe('outputsFileIn — the sandbox commands own out directory', () => {
	it('matches OUTPUTS_FILE at the default directory', () => {
		assert.strictEqual(outputsFileIn(OUTPUTS_DIR, 'sandbox'), OUTPUTS_FILE.sandbox);
		assert.strictEqual(outputsFileIn(OUTPUTS_DIR, 'production'), OUTPUTS_FILE.production);
	});

	it('takes only the file name into a custom directory', () => {
		assert.strictEqual(outputsFileIn('out', 'sandbox'), 'out/outputs.json');
		assert.strictEqual(outputsFileIn('build/x', 'production'), 'build/x/outputs.production.json');
	});
});
