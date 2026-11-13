// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Write errors that mean the reader of stdout/stderr is gone, which the CLI
 * drops (see bin.ts). A copy of `CLOSED_OUTPUT_CODES` of
 * `@aws-blocks/core/scripts`: the CLI can't import that entry here, since
 * loading it takes about 0.6 s on every command. closed-output.test.ts fails
 * when the two lists differ.
 */
export const CLI_CLOSED_OUTPUT_CODES: readonly string[] = ['EPIPE', 'EIO', 'ERR_STREAM_DESTROYED'];
