package com.aws.blocks.kotlin

import io.kotest.matchers.shouldBe
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.cookies.AcceptAllCookiesStorage
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.get
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.test.runTest
import kotlin.test.Test

class HttpClientFactoryTest {

    @Test
    fun `outbound requests carry the user agent token on both headers`() = runTest {
        var captured: HttpRequestData? = null
        val engine = MockEngine { request ->
            captured = request
            respond(
                content = ByteReadChannel("{}"),
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }

        defaultHttpClient(engine, cookiesStorage = AcceptAllCookiesStorage()).get("https://example.com/")

        captured!!.headers["x-blocks-user-agent"] shouldBe blocksUserAgentToken
        captured!!.headers[HttpHeaders.UserAgent] shouldBe blocksUserAgentToken
    }
}
