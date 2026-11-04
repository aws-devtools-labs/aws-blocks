// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DeploymentDetailResponse, DeploymentStatus } from '../contract/v1.js';

/**
 * Which explanation a deployment detail page owes the reader.
 *
 * This exists because a FAILED deployment could render NO explanation at all.
 * The recorded error — the one sentence the deploy itself wrote down about why it
 * failed — was shown only when `eventsSource` was `not-applicable`, a state a
 * failed deployment never reaches: failure statuses always attempt the
 * CloudFormation read. So when that read SUCCEEDED and found nothing in the
 * deploy window (a pruned event history, or a failure CloudFormation never
 * emitted an event for), the page showed a FAILED badge, a summary card, and
 * silence — with `errorSummary` sitting unused in the response.
 *
 * Silence is the one thing this page must not answer with: it is
 * indistinguishable from "we found nothing wrong".
 */
export interface DeploymentExplanation {
	/**
	 * The deploy's own recorded reason. Withheld only when the events gave us a
	 * root cause, which is the same failure with the resource and timestamp
	 * attached — showing both would state it twice, worse each time.
	 */
	showRecordedError: boolean;
	/**
	 * The events were read successfully and the window held no failure event.
	 * Without this the page has nothing to say about a failure, so the reader
	 * cannot tell a clean read from one that never happened.
	 */
	showEmptyEventsNote: boolean;
}

/** Statuses whose failure the page is expected to explain. */
const EXPLAINABLE: readonly DeploymentStatus[] = ['FAILED', 'ROLLED_BACK', 'IN_PROGRESS'];

export function isExplainableStatus(status: DeploymentStatus): boolean {
	return EXPLAINABLE.includes(status);
}

/**
 * Statuses whose deploy window is CLOSED, so an empty one means something.
 *
 * Deliberately narrower than {@link EXPLAINABLE}, which answers a different
 * question: whether the events are worth READING at all. A live deploy's events
 * are exactly what a reader wants, so `IN_PROGRESS` belongs there — but it has no
 * finished window for a failure to be absent from, and the note that fires on an
 * empty window asserts that nothing failed "between this deployment's start and
 * finish" and offers an aged-out event history as the reason. Both are false of a
 * deploy that has neither finished nor written those events yet, and a fabricated
 * explanation is the same defect as the silence this module was written to fix,
 * pointed the other way.
 */
const WINDOW_CLOSED: readonly DeploymentStatus[] = ['FAILED', 'ROLLED_BACK'];

export function deploymentExplanation(detail: {
	status: DeploymentStatus;
	errorSummary?: string;
	eventsSource: DeploymentDetailResponse['eventsSource'];
	hasRootCause: boolean;
	failureEventCount: number;
}): DeploymentExplanation {
	const { status, errorSummary, eventsSource, hasRootCause, failureEventCount } = detail;

	return {
		// Not gated on eventsSource: a recorded reason is worth showing whether the
		// events were unavailable, empty, or never attempted.
		showRecordedError: Boolean(errorSummary) && !hasRootCause,
		showEmptyEventsNote:
			WINDOW_CLOSED.includes(status) &&
			eventsSource === 'cloudformation' &&
			!hasRootCause &&
			failureEventCount === 0,
	};
}
