package com.aws.blocks.kotlin.exceptions

/**
 * Base exception for all errors originating from the Blocks SDK.
 *
 * Catch this to handle any Blocks error generically. For finer-grained handling,
 * catch [ApiException] (server returned a JSON-RPC error) or [NetworkException]
 * (HTTP transport failure) directly.
 */
open class BlocksException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)
