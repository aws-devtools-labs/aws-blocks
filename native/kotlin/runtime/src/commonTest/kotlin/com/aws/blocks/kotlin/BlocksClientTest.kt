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
import com.aws.blocks.kotlin.exceptions.ApiException
import com.aws.blocks.kotlin.exceptions.NetworkException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertFailsWith

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

    private fun clientAnswering(status: HttpStatusCode, body: String) = BlocksClient(
        BlocksServer("local", "http://localhost:3000/aws-blocks/api"),
        defaultHttpClient(
            MockEngine {
                respond(
                    content = ByteReadChannel(body),
                    status = status,
                    headers = headersOf(HttpHeaders.ContentType, "application/json"),
                )
            },
            cookiesStorage = AcceptAllCookiesStorage(),
        ),
    )

    private val unauthenticatedBody =
        """{"jsonrpc":"2.0","error":{"code":401,"message":"Authentication required","data":{"name":"NotAuthenticatedException"}},"id":1}"""

    @Test
    fun `a JSON-RPC error on HTTP 401 (httpErrorStatus) is the same ApiException as on HTTP 200`() = runTest {
        for (status in listOf(HttpStatusCode.Unauthorized, HttpStatusCode.OK)) {
            val e = assertFailsWith<ApiException> {
                clientAnswering(status, unauthenticatedBody)
                    .execute(BlocksRequest(method = "api.authRequired", params = emptyList(), id = 1))
            }
            e.code shouldBe 401
            e.message shouldBe "Authentication required"
            e.data?.get("name")?.jsonPrimitive?.content shouldBe "NotAuthenticatedException"
        }
    }

    @Test
    fun `a non-2xx response without a JSON-RPC error stays a NetworkException`() = runTest {
        val routeError = assertFailsWith<NetworkException> {
            clientAnswering(HttpStatusCode.NotFound, """{"error":"Not Found"}""")
                .execute(BlocksRequest(method = "api.x", params = emptyList(), id = 1))
        }
        routeError.statusCode shouldBe 404
        routeError.message shouldBe "Not Found"

        val notJson = assertFailsWith<NetworkException> {
            clientAnswering(HttpStatusCode.BadGateway, "<html>bad gateway</html>")
                .execute(BlocksRequest(method = "api.x", params = emptyList(), id = 1))
        }
        notJson.statusCode shouldBe 502
        notJson.message shouldBe "HTTP 502"
    }
}
