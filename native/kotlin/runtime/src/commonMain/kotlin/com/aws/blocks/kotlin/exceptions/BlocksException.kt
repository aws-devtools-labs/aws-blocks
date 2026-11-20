// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.exceptions

/**
 * Base exception for all errors originating from the CDK Blocks SDK.
 *
 * Catch this to handle any CDK Blocks error generically. For finer-grained handling,
 * catch [ApiException] (server returned a JSON-RPC error) or [TransportException]
 * (no usable JSON-RPC result: no response at all, or a response that was not a JSON-RPC
 * result) directly.
 */
open class BlocksException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)
