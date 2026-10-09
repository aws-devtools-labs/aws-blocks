// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// A script that overruns runSandboxScript's timeout; records if it was not stopped.
import { record } from './timing.js';

setTimeout(() => record('slow script finished'), 3_000);
