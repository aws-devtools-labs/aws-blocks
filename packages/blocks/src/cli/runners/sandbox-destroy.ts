// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Runs with the `tsx` loader and `--conditions=cdk`, started by `cdk-blocks sandbox destroy`. */

import { destroySandbox } from '@aws-blocks/core/scripts';
import { exitWithError } from './fail.js';

const { backendPath, invocation } = JSON.parse(process.argv[2]) as { backendPath: string; invocation?: string };

destroySandbox(backendPath, { invocation }).catch(exitWithError);
