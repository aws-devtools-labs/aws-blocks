// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Runs with the `tsx` loader, started by `npm run destroy` after the confirmation. */

import { type DestroyOptions, destroy } from '@aws-cdk-blocks/core/scripts';
import { exitWithError } from './fail.js';

const options = JSON.parse(process.argv[2]) as DestroyOptions;

destroy(options).catch(exitWithError);
