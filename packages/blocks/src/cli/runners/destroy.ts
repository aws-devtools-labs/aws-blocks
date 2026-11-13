// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Runs with the `tsx` loader, started by `cdk-blocks destroy` after the confirmation. */

import { type DestroyOptions, destroy } from '@aws-blocks/core/scripts';
import { exitWithError } from './fail.js';

const options = JSON.parse(process.argv[2]) as DestroyOptions;

destroy(options).catch(exitWithError);
