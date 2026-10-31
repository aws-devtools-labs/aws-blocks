// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Runs with the `tsx` loader and `--conditions=cdk`, started by `blocks sandbox destroy`. */

import { destroySandbox } from '@aws-blocks/core/scripts';
import { exitWithError } from './fail.js';

const { backendPath } = JSON.parse(process.argv[2]) as { backendPath: string };

destroySandbox(backendPath).catch(exitWithError);
