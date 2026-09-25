#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { telemetry } from './telemetry.js';

telemetry().catch((error) => {
  console.error(error);
  process.exit(1);
});
