// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.exceptions

/**
 * Thrown when an upload or download through a file-bucket handle fails — the presigned
 * URL rejected the transfer, or the connection failed partway through.
 *
 * Hydrating the handle itself is a different failure: an unusable descriptor is a
 * [TransferableException].
 *
 * @property statusCode The HTTP status the transfer was rejected with, or null when the
 *   request got no response.
 */
class FileTransferException(
    message: String,
    val statusCode: Int? = null,
    cause: Throwable? = null
) : BlocksException(message, cause)
