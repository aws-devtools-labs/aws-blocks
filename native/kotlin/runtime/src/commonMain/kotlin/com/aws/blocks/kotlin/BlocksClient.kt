package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.exceptions.ApiException
import com.aws.blocks.kotlin.exceptions.BlocksException
import com.aws.blocks.kotlin.exceptions.NetworkException
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Url
import io.ktor.http.contentType
import io.ktor.http.encodeURLPathPart
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Reported by anything that runs on an engine a [Blocks] instance has already closed. */
internal const val CLOSED_MESSAGE: String =
    "This Blocks instance is closed. Build a new one rather than reusing a closed instance."

/**
 * JSON-RPC client that executes requests against an AWS Blocks backend endpoint.
 *
 * Obtained from [Blocks.client]; a [Blocks] instance owns one and closes it.
 */
class BlocksClient internal constructor(
    internal val server: BlocksServer,
    internal val httpClient: HttpClient = defaultHttpClient(),
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

    companion object {
        /**
         * Clears all persisted cookies (e.g. session tokens).
         * Call this to ensure a fully logged-out state across app restarts.
         */
        suspend fun clearCookies() {
            sharedCookiesStorage.clear()
        }
    }

    /**
     * POSTs [request] to `{server.url}/{namespace}` (e.g. `…/aws-blocks/api/reports` for
     * `reports.build`), so a namespace that runs on its own compute is served by it.
     */
    suspend fun execute(request: BlocksRequest): JsonElement {
        if (closed) throw BlocksException(CLOSED_MESSAGE)

        val json = Json.encodeToString(request)

        val response = httpClient.post(rpcUrl(server.url.toString(), request.method)) {
            contentType(ContentType.Application.Json)
            setBody(json)
        }

        val responseBody = response.bodyAsText()

        val responseJson = try {
            Json.parseToJsonElement(responseBody) as? JsonObject
        } catch (_: Exception) {
            null
        }

        if (!response.status.isSuccess()) {
            val message = responseJson?.get("error")?.jsonPrimitive?.content ?: "HTTP ${response.status.value}"
            throw NetworkException(message, response.status.value)
        }

        val errorObj = responseJson?.get("error")
        if (errorObj != null) {
            val error = errorObj.jsonObject
            val message = error["message"]?.jsonPrimitive?.content ?: "Unknown error"
            val code = error["code"]?.jsonPrimitive?.int ?: -1
            val data = error["data"] as? JsonObject
            throw ApiException(message, code, data)
        }

        val resultElement = responseJson?.get("result")
            ?: throw BlocksException("Missing result field in JSON-RPC response")

        return resultElement
    }
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
