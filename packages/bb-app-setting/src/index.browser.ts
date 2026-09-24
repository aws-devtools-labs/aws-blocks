// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub - AppSetting runs server-side only
export { SECRETS_BULK_CONSTRUCT_ID } from './secrets-bulk.js';

export class AppSetting {
	static fromExisting(...args: any[]): any {
		return new AppSetting();
	}
	constructor(...args: any[]) {}
}
