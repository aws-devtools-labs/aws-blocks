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

/** Thrown when the channel's WebSocket connection fails. */
class RealtimeConnectionException(message: String, cause: Throwable? = null) :
    RealtimeException(message, cause)
