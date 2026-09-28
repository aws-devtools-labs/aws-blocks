package com.aws.blocks.kotlin

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.DefaultRequest
import io.ktor.client.plugins.UserAgent
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.cookies.CookiesStorage
import io.ktor.client.plugins.cookies.HttpCookies
import io.ktor.client.plugins.logging.LogLevel
import io.ktor.client.plugins.logging.Logging
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.request.header
import io.ktor.serialization.kotlinx.json.json

internal fun defaultHttpClient(
    engine: HttpClientEngine? = null,
    cookiesStorage: CookiesStorage = PersistentCookiesStorage(),
): HttpClient {
    val configure: HttpClientConfig<*>.() -> Unit = {
        install(WebSockets)
        // Every request carries both headers: the Blocks server reads x-blocks-user-agent;
        // direct-to-AWS paths (presigned S3, WebSocket) read the standard User-Agent.
        install(UserAgent) { agent = blocksUserAgentToken }
        install(DefaultRequest) { header("x-blocks-user-agent", blocksUserAgentToken) }
        install(HttpCookies) {
            storage = cookiesStorage
        }
        install(ContentNegotiation) {
            json()
        }
    }
    return if (engine == null) HttpClient(configure) else HttpClient(engine, configure)
}
