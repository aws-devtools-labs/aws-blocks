// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.exceptions

/**
 * Thrown by a request made through a `Blocks` instance that is already closed. A closed
 * instance owns no HTTP engine, so the request is reported here rather than failing
 * inside the HTTP client with a cancellation a caller cannot tell from its own.
 */
class ClientClosedException internal constructor(message: String) : BlocksException(message)
