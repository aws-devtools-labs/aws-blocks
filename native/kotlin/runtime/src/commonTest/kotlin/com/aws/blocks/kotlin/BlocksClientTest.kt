package com.aws.blocks.kotlin

import io.kotest.matchers.shouldBe
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.cookies.AcceptAllCookiesStorage
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.test.runTest
import kotlin.test.Test

class BlocksClientTest {

    @Test
    fun `execute posts to the method's namespace path`() = runTest {
        var captured: HttpRequestData? = null
        val engine = MockEngine { request ->
            captured = request
            respond(
                content = ByteReadChannel("""{"jsonrpc":"2.0","result":"ok","id":1}"""),
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val client = BlocksClient(
            BlocksServer("cloudfront", "https://d123.cloudfront.net/aws-blocks/api"),
            defaultHttpClient(engine, cookiesStorage = AcceptAllCookiesStorage()),
        )

        client.execute(BlocksRequest(method = "reports.build", params = emptyList(), id = 1))

        captured!!.url.toString() shouldBe "https://d123.cloudfront.net/aws-blocks/api/reports"
    }

    @Test
    fun `rpcUrl appends the namespace segment`() {
        rpcUrl("http://localhost:3001/aws-blocks/api", "api.greet") shouldBe "http://localhost:3001/aws-blocks/api/api"
        rpcUrl("https://a.example/prod/aws-blocks/api//", "reports.build") shouldBe "https://a.example/prod/aws-blocks/api/reports"
        // Only the first `.` separates the namespace.
        rpcUrl("https://a.example/aws-blocks/api", "ns.a.b") shouldBe "https://a.example/aws-blocks/api/ns"
        // Path-safe characters are sent as they are; others are percent-encoded.
        rpcUrl("https://a.example/aws-blocks/api", "\$ns.m") shouldBe "https://a.example/aws-blocks/api/\$ns"
        rpcUrl("https://a.example/aws-blocks/api", "café.m") shouldBe "https://a.example/aws-blocks/api/caf%C3%A9"
    }

    @Test
    fun `rpcUrl leaves the base for a method without namespace`() {
        rpcUrl("https://a.example/aws-blocks/api", "greet") shouldBe "https://a.example/aws-blocks/api"
        rpcUrl("https://a.example/aws-blocks/api", ".greet") shouldBe "https://a.example/aws-blocks/api"
    }
}
