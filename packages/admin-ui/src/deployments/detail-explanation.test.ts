// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deploymentExplanation, isExplainableStatus } from './detail-explanation.js';

/** A SUCCEEDED deployment: the server never attempts the events read. */
const succeeded = {
	status: 'SUCCEEDED' as const,
	eventsSource: 'not-applicable' as const,
	hasRootCause: false,
	failureEventCount: 0,
};

/** The case this module exists for: failed, events read cleanly, window empty. */
const failedWithEmptyEvents = {
	status: 'FAILED' as const,
	errorSummary: 'CREATE_FAILED AWS::DynamoDB::Table todos-table: one GSI at a time',
	eventsSource: 'cloudformation' as const,
	hasRootCause: false,
	failureEventCount: 0,
};

describe('isExplainableStatus', () => {
	it('covers every status that attempts a failure read', () => {
		assert.equal(isExplainableStatus('FAILED'), true);
		assert.equal(isExplainableStatus('ROLLED_BACK'), true);
		assert.equal(isExplainableStatus('IN_PROGRESS'), true);
	});

	it('excludes the statuses the server answers not-applicable for', () => {
		assert.equal(isExplainableStatus('SUCCEEDED'), false);
		assert.equal(isExplainableStatus('UNKNOWN'), false);
	});
});

describe('deploymentExplanation', () => {
	it('never leaves a FAILED deployment with nothing said', () => {
		// The regression: a clean events read over an empty window used to render a
		// FAILED badge and silence, with errorSummary unused in the response.
		const e = deploymentExplanation(failedWithEmptyEvents);
		assert.equal(e.showRecordedError, true);
		assert.equal(e.showEmptyEventsNote, true);
	});

	it('withholds the recorded error when the events gave a root cause', () => {
		// The root cause IS the same failure, with resource and timestamp attached.
		const e = deploymentExplanation({ ...failedWithEmptyEvents, hasRootCause: true, failureEventCount: 3 });
		assert.equal(e.showRecordedError, false);
		assert.equal(e.showEmptyEventsNote, false);
	});

	it('shows the recorded error even when the events read FAILED', () => {
		// Then it is the only explanation there is.
		const e = deploymentExplanation({ ...failedWithEmptyEvents, eventsSource: 'unavailable' });
		assert.equal(e.showRecordedError, true);
		// The unavailable card already states why, so this note would be noise.
		assert.equal(e.showEmptyEventsNote, false);
	});

	it('shows the recorded error when events were never attempted', () => {
		const e = deploymentExplanation({
			...succeeded,
			status: 'UNKNOWN',
			errorSummary: 'something was recorded',
		});
		assert.equal(e.showRecordedError, true);
	});

	it('says nothing for a clean SUCCEEDED deployment', () => {
		const e = deploymentExplanation(succeeded);
		assert.equal(e.showRecordedError, false);
		assert.equal(e.showEmptyEventsNote, false);
	});

	it('does not claim an empty window for a SUCCEEDED deployment', () => {
		// SUCCEEDED with a cloudformation source and no events is not a mystery.
		const e = deploymentExplanation({ ...succeeded, eventsSource: 'cloudformation' });
		assert.equal(e.showEmptyEventsNote, false);
	});

	it('suppresses the empty-window note as soon as there is an event to show', () => {
		const e = deploymentExplanation({ ...failedWithEmptyEvents, failureEventCount: 1 });
		assert.equal(e.showEmptyEventsNote, false);
	});

	it('handles a failure with no recorded error at all', () => {
		const { errorSummary: _dropped, ...withoutSummary } = failedWithEmptyEvents;
		const e = deploymentExplanation(withoutSummary);
		assert.equal(e.showRecordedError, false);
		// Still not silent: the empty-window note carries the page.
		assert.equal(e.showEmptyEventsNote, true);
	});

	it('treats an empty-string summary as no summary', () => {
		const e = deploymentExplanation({ ...failedWithEmptyEvents, errorSummary: '' });
		assert.equal(e.showRecordedError, false);
	});

	it('never explains an empty window for a deployment that has not finished', () => {
		// A live deploy reaches here with a clean events read and no failure event,
		// because the server only short-circuits SUCCEEDED and UNKNOWN. The
		// empty-window note asserts that nothing failed "between this deployment's
		// start and finish" and suggests the events aged out -- both false of a
		// deploy that has neither finished nor written its events yet. Fabricating
		// an explanation is the same defect as rendering silence, pointed the other
		// way.
		const e = deploymentExplanation({
			status: 'IN_PROGRESS',
			eventsSource: 'cloudformation',
			hasRootCause: false,
			failureEventCount: 0,
		});
		assert.equal(e.showEmptyEventsNote, false);
	});

	it('still explains an in-flight deployment that HAS failure events', () => {
		// A deploy can be mid-rollback with real failure events already emitted:
		// those are shown by the events table, and withholding the empty-window
		// note is the only thing the in-flight case changes.
		const e = deploymentExplanation({
			status: 'IN_PROGRESS',
			errorSummary: 'CREATE_FAILED AWS::S3::Bucket assets: already exists',
			eventsSource: 'cloudformation',
			hasRootCause: true,
			failureEventCount: 2,
		});
		assert.equal(e.showEmptyEventsNote, false);
		assert.equal(e.showRecordedError, false, 'the root cause supersedes it');
	});

	it('still shows an in-flight deployment its own recorded error', () => {
		// A died-mid-deploy record can carry a recorded reason with no events; that
		// sentence is the deploy's own and is worth showing whatever the status.
		const e = deploymentExplanation({
			status: 'IN_PROGRESS',
			errorSummary: 'the deploy process was killed',
			eventsSource: 'cloudformation',
			hasRootCause: false,
			failureEventCount: 0,
		});
		assert.equal(e.showRecordedError, true);
		assert.equal(e.showEmptyEventsNote, false);
	});

	it('reads events for an in-flight deploy while refusing to conclude from them', () => {
		// The two rules are deliberately different: IN_PROGRESS is worth READING
		// events for (a live deploy's failures are exactly what a reader wants),
		// and is not a status whose empty window means anything.
		assert.equal(isExplainableStatus('IN_PROGRESS'), true);
		assert.equal(
			deploymentExplanation({
				status: 'IN_PROGRESS',
				eventsSource: 'cloudformation',
				hasRootCause: false,
				failureEventCount: 0,
			}).showEmptyEventsNote,
			false,
		);
	});
});
