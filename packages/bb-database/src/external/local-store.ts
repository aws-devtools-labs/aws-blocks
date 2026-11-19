// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AppSetting } from '@aws-cdk-blocks/bb-app-setting';
import { Scope } from '@aws-cdk-blocks/core';
import { LOCAL_CONNECTION_SCOPE } from '../constants.js';

// Local mode only. The block and the CLI must reach the same entry of the local settings store without knowing
// the app's scopes, so the setting hangs off one fixed scope and is keyed by the connection's short name.
let scope: Scope | undefined;
const settings = new Map<string, AppSetting<string>>();

/** The local `AppSetting` that holds the connection string of `DatabaseCluster.fromExisting({ name })`. */
export function localConnectionSetting(name: string): AppSetting<string> {
	let setting = settings.get(name);
	if (!setting) {
		scope ??= new Scope(LOCAL_CONNECTION_SCOPE);
		setting = AppSetting.fromExisting<string>(scope, name, { name: `/local-${name}`, secret: true });
		settings.set(name, setting);
	}
	return setting;
}
