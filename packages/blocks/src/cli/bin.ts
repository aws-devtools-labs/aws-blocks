#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** The `blocks` and `cdk-blocks` bins of `@aws-blocks/blocks`. */

import { main } from './main.js';

// Set explicitly: Node does not exit 130 on its own once a SIGINT handler is installed.
process.exitCode = await main(process.argv.slice(2));
