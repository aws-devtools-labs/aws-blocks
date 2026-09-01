// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Error name constants for CronJob operations.
 */
export const CronJobErrors = {
	/** Thrown when the schedule expression is not a valid cron or rate format. */
	InvalidSchedule: 'InvalidScheduleExpression',
	/**
	 * Thrown by the local mock when a schedule is valid for EventBridge (and passes
	 * the deploy-time synth gate) but uses cron forms the mock parser can't simulate
	 * locally — e.g. `L`, `W`, `#`, or a year field. It will deploy and run; this is
	 * a local-simulation limitation, not an invalid schedule.
	 */
	ScheduleNotSupported: 'ScheduleNotSupportedInMock',
	/** Thrown when the timezone string is not a valid IANA timezone. */
	InvalidTimezone: 'InvalidTimezoneExpression',
} as const;
