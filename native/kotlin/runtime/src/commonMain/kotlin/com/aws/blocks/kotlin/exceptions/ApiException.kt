// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.exceptions

import kotlin.contracts.ExperimentalContracts
import kotlin.contracts.contract

/**
 * Thrown when the server answers with a JSON-RPC error: the request reached the server
 * and was rejected (authentication required, validation failed, a conflict).
 *
 * @property status The HTTP status the server rejected with. JSON-RPC's reserved codes
 *   have no HTTP meaning and are reported as 500.
 * @property name The server's error name, or null when it sent none. Errors cross the
 *   wire by name, so match on this rather than on [message] or [status] — a named error
 *   thrown without a status arrives as a 500 with its name intact.
 * @property retriable Whether the same action can be retried without restarting the
 *   wider flow. Meaningful for multi-step flows such as an auth challenge, where a
 *   wrong code can be re-entered against the same session but an expired session
 *   cannot. Defaults to false.
 */
class ApiException(
    message: String,
    val status: Int,
    val name: String? = null,
    val retriable: Boolean = false,
    cause: Throwable? = null
) : BlocksException(message, cause)

/**
 * True when [this] is an [ApiException] whose [ApiException.name] is [name]. Errors
 * cross the wire by name, so match with this rather than on a message or a status.
 */
@OptIn(ExperimentalContracts::class)
fun Throwable.isBlocksError(name: String): Boolean {
    contract {
        returns(true) implies (this@isBlocksError is ApiException)
    }
    return this is ApiException && this.name == name
}
