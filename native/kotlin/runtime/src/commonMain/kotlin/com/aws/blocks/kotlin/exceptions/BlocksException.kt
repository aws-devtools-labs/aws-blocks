package com.aws.blocks.kotlin.exceptions

/**
 * Base exception for all errors originating from the Blocks SDK.
 *
 * Catch this to handle any Blocks error generically. For finer-grained handling,
 * catch [ApiException] (server returned a JSON-RPC error) or [TransportException]
 * (no usable JSON-RPC result: no response at all, or a response that was not a JSON-RPC
 * result) directly.
 */
open class BlocksException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)
