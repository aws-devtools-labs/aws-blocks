// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every interleaving of up to three concurrent operations on the client
 * auth-state store, spread over two APIs, with the cookie-faithful timing (a request changes the session when its answer arrives).
 * The model and the oracle are in `test-support/auth-store-races.ts`.
 */

import { describeEnumeration } from './test-support/auth-store-races.js';

await describeEnumeration('cookie', 2);
