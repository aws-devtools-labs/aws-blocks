package com.aws.blocks.kotlin.exceptions

/**
 * Thrown when the HTTP request to the server fails at the transport level (non-2xx status).
 *
 * This represents an infrastructure-level failure — the request did not reach the
 * application layer (e.g. server unavailable, proxy error, gateway timeout).
 *
 * @property statusCode The HTTP status code from the response.
 */
class NetworkException(
    message: String,
    val statusCode: Int,
    cause: Throwable? = null
) : BlocksException(message, cause)
