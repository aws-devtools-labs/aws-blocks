// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub — __BB_CLASS__ runs server-side only. Re-exports the public type
// + error constants (per the AWS Blocks browser-entry convention) so client code
// type-checks; the methods live on the server (`index.ts`) entry.
export class __BB_CLASS__ {
	constructor(..._args: unknown[]) {}
}
export { __BB_CLASS__Errors } from './errors.js';
export type { __BB_CLASS__Options } from './index.js';
