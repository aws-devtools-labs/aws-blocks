// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The DynamoDB actions of the index manager's role, in one place: the CDK layer grants them, and
// gsi-manager-lambda.test.ts checks that every call the Lambda makes is among them. A call the fast path makes
// after DeleteTable without its action would fail between the delete and the restore.

/** Every stage: indexes change one at a time on the live table. */
export const GSI_MANAGER_ACTIONS = ['dynamodb:DescribeTable', 'dynamodb:UpdateTable'] as const;

/** Sandbox only, on the tables that request sandbox mode: the fast path deletes the table and creates it again. */
export const GSI_MANAGER_SANDBOX_ACTIONS = [
	'dynamodb:DeleteTable',
	'dynamodb:CreateTable',
	'dynamodb:Scan',
	'dynamodb:BatchWriteItem',
	// Read the table's settings before the delete and set them again on the
	// new table (tags at CreateTable).
	'dynamodb:ListTagsOfResource',
	'dynamodb:TagResource',
	'dynamodb:DescribeTimeToLive',
	'dynamodb:UpdateTimeToLive',
	'dynamodb:DescribeContinuousBackups',
	'dynamodb:UpdateContinuousBackups',
] as const;
