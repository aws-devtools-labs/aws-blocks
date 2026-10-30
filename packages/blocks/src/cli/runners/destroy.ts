// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Runs under `tsx`, started by `blocks destroy` after the confirmation. */

import { type DestroyOptions, destroy } from '@aws-blocks/core/scripts';

const options = JSON.parse(process.argv[2]) as DestroyOptions;

destroy(options).catch((error) => {
	console.error(error);
	process.exit(1);
});
