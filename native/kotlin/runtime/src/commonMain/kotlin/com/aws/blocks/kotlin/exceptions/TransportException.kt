package com.aws.blocks.kotlin.exceptions

/**
 * Thrown when a request produced no usable JSON-RPC result: the connection failed, the
 * response carried no JSON-RPC envelope (a gateway's own error page), or an envelope
 * arrived with no `result` field.
 *
 * This is an infrastructure-level failure — the request never reached the application
 * layer, or what came back was not something the client could read. A request the
 * server considered and rejected is an [ApiException] instead.
 *
 * @property statusCode The HTTP status of the response, or null when no response
 *   arrived at all.
 */
class TransportException(
    message: String,
    val statusCode: Int? = null,
    cause: Throwable? = null
) : BlocksException(message, cause)
