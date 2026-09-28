// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub - CronJob runs server-side only
export class CronJob {
	constructor(...args: any[]) {}
}

export const CronJobErrors = {
	InvalidSchedule: 'InvalidScheduleExpression',
	InvalidTimezone: 'InvalidTimezoneExpression',
	UnsupportedCompute: 'UnsupportedComputeException',
} as const;
