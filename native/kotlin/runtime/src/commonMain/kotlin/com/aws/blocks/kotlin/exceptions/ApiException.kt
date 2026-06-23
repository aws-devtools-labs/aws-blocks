package com.aws.blocks.kotlin.exceptions

import kotlin.contracts.ExperimentalContracts
import kotlin.contracts.contract
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Thrown when the server returns a JSON-RPC error response (HTTP 200 with an `error` field).
 *
 * This represents an application-level failure — the request reached the server and was
 * rejected (e.g. authentication required, validation failed, method not found).
 *
 * @property code The JSON-RPC error code returned by the server.
 * @property data The optional arbitrary JSON object from the `error.data` field.
 * @property name Convenience accessor for `data["name"]` — the server's error name
 *   (e.g. "NotAuthenticatedError"), or null if not present.
 */
class ApiException(
    message: String,
    val code: Int,
    val data: JsonObject? = null,
    cause: Throwable? = null
) : BlocksException(message, cause) {
    val name: String?
        get() = data?.get("name")?.jsonPrimitive?.content
}

@OptIn(ExperimentalContracts::class)
fun Throwable.isBlocksError(name: String): Boolean {
    contract {
        returns(true) implies (this@isBlocksError is ApiException)
    }
    return this is ApiException && this.name == name
}
