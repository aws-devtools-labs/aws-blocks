package com.aws.blocks.kotlin

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.HttpTimeoutCapability
import io.ktor.client.plugins.HttpTimeoutConfig
import io.ktor.client.plugins.cookies.AcceptAllCookiesStorage
import io.ktor.client.plugins.cookies.CookiesStorage
import io.ktor.client.plugins.timeout
import io.ktor.client.request.HttpRequestBuilder
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

    @Test
    fun `requests carry the default connect and socket timeouts and no request timeout`() = runTest {
        val timeouts = timeoutsSentFor { }

        timeouts.connectTimeoutMillis shouldBe DEFAULT_CONNECT_TIMEOUT_MILLIS
        timeouts.socketTimeoutMillis shouldBe DEFAULT_SOCKET_TIMEOUT_MILLIS
        timeouts.requestTimeoutMillis.shouldBeNull()
    }

    @Test
    fun `a per-request timeout overrides the default`() = runTest {
        val timeouts = timeoutsSentFor { timeout { socketTimeoutMillis = 500 } }

        timeouts.socketTimeoutMillis shouldBe 500
        timeouts.connectTimeoutMillis shouldBe DEFAULT_CONNECT_TIMEOUT_MILLIS
    }

    @Test
    fun `a client given no storage keeps no cookies`() = runTest {
        // What the realtime channel and the file handles get. Each authenticates with the
        // credential on its own URL, and the jar belongs to a Blocks instance they cannot reach,
        // so they must not hold one — a cookie accepted here would be sent on an unrelated
        // transfer to the same host for the life of the handle.
        val sent = cookieHeadersAcrossTwoRequests(cookiesStorage = null)

        sent[0].shouldBeNull()
        sent[1].shouldBeNull()
    }

    @Test
    fun `a client given storage sends back what the server set`() = runTest {
        // The other half of the test above: proves the assertion can see a jar, so the absence
        // one is not just an assertion that never fires.
        val sent = cookieHeadersAcrossTwoRequests(cookiesStorage = AcceptAllCookiesStorage())

        sent[0].shouldBeNull()
        sent[1] shouldBe "session=abc123"
    }

    /** The `Cookie` header on each of two requests to a host that sets one on every response. */
    private suspend fun cookieHeadersAcrossTwoRequests(cookiesStorage: CookiesStorage?): List<String?> {
        val sent = mutableListOf<String?>()
        val engine = MockEngine { request ->
            sent += request.headers[HttpHeaders.Cookie]
            respond(
                content = ByteReadChannel("{}"),
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.SetCookie, "session=abc123; Path=/"),
            )
        }

        val client = defaultHttpClient(engine, cookiesStorage)
        client.get("https://example.com/")
        client.get("https://example.com/")

        return sent
    }

    private suspend fun timeoutsSentFor(block: HttpRequestBuilder.() -> Unit): HttpTimeoutConfig {
        var captured: HttpRequestData? = null
        val engine = MockEngine { request ->
            captured = request
            respond(content = ByteReadChannel("{}"), status = HttpStatusCode.OK)
        }

        defaultHttpClient(engine, cookiesStorage = AcceptAllCookiesStorage()).get("https://example.com/", block)

        return captured!!.getCapabilityOrNull(HttpTimeoutCapability)!!
    }
}
