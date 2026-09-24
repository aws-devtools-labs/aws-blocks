package com.aws.blocks.kotlin

import io.ktor.client.HttpClient
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.cookies.HttpCookies
import io.ktor.client.plugins.logging.LogLevel
import io.ktor.client.plugins.logging.Logging
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.serialization.kotlinx.json.json

internal fun defaultHttpClient(): HttpClient = HttpClient {
    install(WebSockets)
    install(HttpCookies) {
        storage = sharedCookiesStorage
    }
    install(ContentNegotiation) {
        json()
    }
}
