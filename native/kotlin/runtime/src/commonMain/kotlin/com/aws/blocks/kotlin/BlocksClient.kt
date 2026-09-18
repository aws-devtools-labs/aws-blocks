package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.exceptions.ApiException
import com.aws.blocks.kotlin.exceptions.BlocksException
import com.aws.blocks.kotlin.exceptions.NetworkException
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.URLBuilder
import io.ktor.http.Url
import io.ktor.http.appendPathSegments
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** JSON-RPC client that executes requests against an AWS Blocks backend endpoint. */
class BlocksClient(
    internal val server: BlocksServer
) {
    internal val httpClient: HttpClient = defaultHttpClient()

    companion object {
        /**
         * Clears all persisted cookies (e.g. session tokens).
         * Call this to ensure a fully logged-out state across app restarts.
         */
        fun clearCookies() {
            PersistentCookiesStorage().clear()
        }
    }

    /**
     * The URL a JSON-RPC call is POSTed to: the server URL plus the API
     * namespace as a path segment (`{server.url}/{namespace}`).
     *
     * The namespace segment lets a front door route each namespace to the compute
     * that hosts it; a single-compute backend serves every namespace path from the
     * same origin, so it is safe there too. The namespace also stays in the
     * JSON-RPC body, which is what the server dispatches on — the path is purely a
     * routing hint.
     *
     * `method` is `"{namespace}.{method}"`; a method with no namespace (the
     * generator emits a bare name for un-namespaced operations) posts to
     * `server.url` unchanged. The stored `server` is left untouched so raw-route
     * and auth URL derivation ([BlocksServer.rawRoute]) keeps working.
     */
    internal fun rpcUrl(method: String): Url {
        val namespace = method.substringBefore('.', missingDelimiterValue = "")
        if (namespace.isEmpty()) return server.url
        return URLBuilder(server.url).appendPathSegments(namespace).build()
    }

    suspend fun execute(request: BlocksRequest): JsonElement {
        val json = Json.encodeToString(request)

        val response = httpClient.post(rpcUrl(request.method)) {
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
