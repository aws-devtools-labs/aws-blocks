// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs under `tsx watch`, started by `blocks dev` and by the sandbox. The options
 * come from `BLOCKS_DEV_OPTIONS`, so that the sandbox's shell command needs no JSON.
 * The `tsx watch` parent is what `blocks dev stop` signals.
 */

import { type DevServerOptions, startDevServer } from '@aws-blocks/core/scripts';
import { DEV_OPTIONS_ENV } from './launch.js';

const options = JSON.parse(process.env[DEV_OPTIONS_ENV] ?? '{}') as DevServerOptions;

startDevServer(options).catch((error) => {
	console.error(error);
	process.exit(1);
});
