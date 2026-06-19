// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub - AppSetting runs server-side only
export class AppSetting {
	static fromExisting(...args: any[]): any {
		return new AppSetting();
	}
	constructor(...args: any[]) {}
}

// copyFrom is a server/synth-side concept; the browser stub just returns a marker.
export function copyFrom(stagingParameterName: string): any {
	return { stagingParameterName };
}
