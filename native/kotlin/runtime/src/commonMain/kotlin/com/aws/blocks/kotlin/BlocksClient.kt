// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.exceptions.ApiException
import com.aws.blocks.kotlin.exceptions.ClientClosedException
import com.aws.blocks.kotlin.exceptions.TransportException
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Url
import io.ktor.http.contentType
import io.ktor.http.encodeURLPathPart
import io.ktor.http.isSuccess
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/** Reported by anything that runs on an engine a [Blocks] instance has already closed. */
internal const val CLOSED_MESSAGE: String =
    "This Blocks instance is closed. Build a new one rather than reusing a closed instance."

/**
 * JSON-RPC client that executes requests against a CDK Blocks backend endpoint.
 *
 * Obtained from [Blocks.client]; a [Blocks] instance owns one and closes it.
 */
class BlocksClient internal constructor(
    internal val server: BlocksServer,
    internal val httpClient: HttpClient,
) {

    private var closed = false

    /**
     * Shuts down the HTTP engine. Later calls to [execute] report the closed state rather than
     * failing inside Ktor with a cancellation that a caller cannot tell from its own.
     */
    internal fun close() {
        closed = true
        httpClient.close()
    }

    /**
     * POSTs [request] to `{server.url}/{namespace}` (e.g. `…/cdk-blocks/api/reports` for
     * `reports.build`), so a namespace that runs on its own compute is served by it.
     */
    suspend fun execute(request: BlocksRequest): JsonElement {
        if (closed) throw ClientClosedException(CLOSED_MESSAGE)

        val json = Json.encodeToString(request)

        // Wrap the engine's own exceptions so no Ktor type crosses the public surface. No
        // response at all carries no status; a response whose body could not be read carries
        // the status it arrived with.
        val response = try {
            httpClient.post(rpcUrl(server.url.toString(), request.method)) {
                contentType(ContentType.Application.Json)
                setBody(json)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw TransportException(e.message ?: "The request failed", null, e)
        }

        val responseBody = try {
            response.bodyAsText()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw TransportException(
                e.message ?: "Reading the response failed",
                response.status.value,
                e,
            )
        }

        val responseJson = try {
            Json.parseToJsonElement(responseBody) as? JsonObject
        } catch (_: Exception) {
            null
        }

        val errorElement = responseJson?.get("error")

        // A JSON-RPC error is decoded the same way whatever the HTTP status: a namespace
        // created with `httpErrorStatus: true` answers a 4xx `ApiError` with that status
        // (e.g. 401) and the same `{ error: { code, message, data } }` body as the 200 it
        // sends otherwise.
        if (errorElement is JsonObject) {
            val message = (errorElement["message"] as? JsonPrimitive)?.contentOrNull ?: "Unknown error"
            val code = (errorElement["code"] as? JsonPrimitive)?.intOrNull ?: -1
            val data = errorElement["data"] as? JsonObject
            throw ApiException(
                message,
                rpcStatus(code),
                (data?.get("name") as? JsonPrimitive)?.contentOrNull ?: reservedRpcErrorName(code),
                // Only a JSON boolean counts; booleanOrNull would also read the string "true".
                (data?.get("retriable") as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull == true,
            )
        }

        if (!response.status.isSuccess()) {
            // Not a JSON-RPC error (a gateway or route error such as `{ "error": "Not Found" }`
            // or API Gateway's `{ "message": "Too Many Requests" }`, or no JSON at all): a
            // transport failure. A non-empty string `message` wins, then a string `error`.
            fun text(element: JsonElement?) =
                (element as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
            val message = text(responseJson?.get("message")) ?: text(errorElement)
                ?: "HTTP ${response.status.value}"
            throw TransportException(message, response.status.value)
        }

        // An envelope is a JSON object whose `jsonrpc` is the string "2.0"; any other 2xx body
        // (an HTML page, an arbitrary object, an array) is not a JSON-RPC response at all.
        val isEnvelope = (responseJson?.get("jsonrpc") as? JsonPrimitive)
            ?.let { it.isString && it.content == "2.0" } == true
        if (responseJson == null || !isEnvelope) {
            throw TransportException(
                "Response was not a JSON-RPC envelope",
                response.status.value,
            )
        }

        // A void handler's envelope has no `result` key (core serializes `result: undefined`,
        // which JSON.stringify drops), and a newer core sends `"result": null`. Both are a
        // successful call with no value; a method with a non-null return type fails through the
        // generated null-result guard instead.
        return responseJson["result"] ?: JsonNull
    }
}

/**
 * The HTTP status an `error.code` reports. A server's `ApiError` sends its HTTP status as
 * the code, and a positive code never collides with JSON-RPC's reserved -32xxx range.
 * Reserved codes have no HTTP meaning, so they are reported as 500.
 */
internal fun rpcStatus(code: Int): Int = if (code > 0) code else 500

/**
 * The error name for a reserved JSON-RPC [code], or null for any other code.
 *
 * The server names some protocol-level failures and not others — it sends no `data` at all
 * for a method-not-found or a parse error — so normalizing the code to a 500 would leave
 * those indistinguishable from a crashed handler. These names are the server's own
 * vocabulary for the same codes, so a name it does send is identical to the one here.
 * A name the server sent always takes precedence; this only fills a gap.
 */
internal fun reservedRpcErrorName(code: Int): String? = when (code) {
    -32700 -> "ParseError"
    -32600 -> "InvalidRequest"
    -32601 -> "MethodNotFound"
    -32602 -> "InvalidParams"
    -32603 -> "InternalError"
    else -> null
}

/**
 * The URL a call to [method] is POSTed to: `{baseUrl}/{namespace}`, where the namespace is the
 * part of [method] before the first `.` — the path the TypeScript client uses, so the backend's
 * gateway can route each namespace to the compute that hosts it. The body still carries the full
 * `namespace.method`, which is what the server dispatches on. A [method] without a namespace goes
 * to [baseUrl] unchanged.
 */
internal fun rpcUrl(baseUrl: String, method: String): String {
    val dot = method.indexOf('.')
    if (dot <= 0) return baseUrl
    return baseUrl.trimEnd('/') + "/" + method.substring(0, dot).encodeURLPathPart()
}
