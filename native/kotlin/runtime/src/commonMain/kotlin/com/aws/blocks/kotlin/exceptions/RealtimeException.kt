// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.exceptions

/** Base for failures on a realtime channel. */
sealed class RealtimeException(message: String, cause: Throwable? = null) :
    BlocksException(message, cause)

/**
 * Thrown when subscribing to a channel that is already closed. A channel can close on
 * its own when the server goes away or the connection drops, so a subscribe after close
 * is not necessarily the caller's mistake and is reported as a catchable error rather
 * than as a programming error.
 */
class RealtimeChannelClosedException : RealtimeException("Channel is closed")

/**
 * Thrown when the channel's WebSocket connection fails.
 *
 * A subscription's flow throws this when the socket could not open (including a refused
 * connect token), failed, or was closed by the server or the gateway, and when the server
 * sends an error that names no channel. Every subscription on that socket ends. The client
 * does not reconnect on its own: get the channel again from the API method that returned it
 * and subscribe to the new handle.
 */
class RealtimeConnectionException(message: String, cause: Throwable? = null) :
    RealtimeException(message, cause)

/**
 * Thrown when the server ends one channel's subscription while the socket stays open: it
 * refused the subscribe, or it ended the subscription when it re-checked it on a keep-alive
 * ping. Other subscriptions on the same socket keep running.
 *
 * [code] is the server's code as sent, or `null` when the server sent none. It is a string
 * rather than an enum because the server can add codes. The known values:
 * - `token_expired`: the channel token expired. Get the channel again from the API method
 *   that returned it and subscribe to the new handle.
 * - `access_revoked` and `principal_mismatch`: the user lost access, or the token belongs to
 *   another user. Don't retry as the same user.
 * - `null`: the server refused the subscribe, for example because the token is invalid or
 *   expired. A channel handle the app has held for a while can get this, because its token
 *   expired before the subscribe, so get the channel again.
 *
 * @property channel the channel whose subscription ended
 * @property code the server's code, or `null` when it sent none
 */
class RealtimeSubscriptionEndedException(
    val channel: String,
    val code: String?,
    message: String,
    cause: Throwable? = null,
) : RealtimeException(message, cause)
