// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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
import com.aws.blocks.kotlin.exceptions.TransportException
import com.aws.blocks.kotlin.exceptions.isBlocksError
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlin.coroutines.cancellation.CancellationException
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
            BlocksServer("cloudfront", "https://d123.cloudfront.net/cdk-blocks/api"),
            defaultHttpClient(engine, cookiesStorage = AcceptAllCookiesStorage()),
        )

        client.execute(BlocksRequest(method = "reports.build", params = emptyList(), id = 1))

        captured!!.url.toString() shouldBe "https://d123.cloudfront.net/cdk-blocks/api/reports"
    }

    @Test
    fun `rpcUrl appends the namespace segment`() {
        rpcUrl("http://localhost:3001/cdk-blocks/api", "api.greet") shouldBe "http://localhost:3001/cdk-blocks/api/api"
        rpcUrl("https://a.example/prod/cdk-blocks/api//", "reports.build") shouldBe "https://a.example/prod/cdk-blocks/api/reports"
        // Only the first `.` separates the namespace.
        rpcUrl("https://a.example/cdk-blocks/api", "ns.a.b") shouldBe "https://a.example/cdk-blocks/api/ns"
        // Path-safe characters are sent as they are; others are percent-encoded.
        rpcUrl("https://a.example/cdk-blocks/api", "\$ns.m") shouldBe "https://a.example/cdk-blocks/api/\$ns"
        rpcUrl("https://a.example/cdk-blocks/api", "café.m") shouldBe "https://a.example/cdk-blocks/api/caf%C3%A9"
    }

    @Test
    fun `rpcUrl leaves the base for a method without namespace`() {
        rpcUrl("https://a.example/cdk-blocks/api", "greet") shouldBe "https://a.example/cdk-blocks/api"
        rpcUrl("https://a.example/cdk-blocks/api", ".greet") shouldBe "https://a.example/cdk-blocks/api"
    }

    private fun clientAnswering(status: HttpStatusCode, body: String) = BlocksClient(
        BlocksServer("local", "http://localhost:3000/cdk-blocks/api"),
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
    fun `a JSON-RPC error on HTTP 401 via httpErrorStatus is the same ApiException as on HTTP 200`() = runTest {
        for (status in listOf(HttpStatusCode.Unauthorized, HttpStatusCode.OK)) {
            val e = assertFailsWith<ApiException> {
                clientAnswering(status, unauthenticatedBody)
                    .execute(BlocksRequest(method = "api.authRequired", params = emptyList(), id = 1))
            }
            e.status shouldBe 401
            e.message shouldBe "Authentication required"
            e.name shouldBe "NotAuthenticatedException"
            e.retriable shouldBe false
        }
    }

    @Test
    fun `a reserved JSON-RPC code is reported as 500 with its name intact`() = runTest {
        val body =
            """{"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params","data":{"name":"InvalidParams"}},"id":1}"""
        val e = assertFailsWith<ApiException> {
            clientAnswering(HttpStatusCode.OK, body)
                .execute(BlocksRequest(method = "api.x", params = emptyList(), id = 1))
        }
        e.status shouldBe 500
        e.name shouldBe "InvalidParams"
    }

    @Test
    fun `a reserved code the server leaves unnamed gets its name synthesized`() = runTest {
        val body =
            """{"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found: api.nope"},"id":1}"""
        val e = assertFailsWith<ApiException> {
            clientAnswering(HttpStatusCode.OK, body)
                .execute(BlocksRequest(method = "api.nope", params = emptyList(), id = 1))
        }
        e.status shouldBe 500
        e.name shouldBe "MethodNotFound"
        e.isBlocksError("MethodNotFound") shouldBe true
    }

    @Test
    fun `a name the server sent wins over the synthesized one`() = runTest {
        val body =
            """{"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid Request","data":{"name":"SomethingSpecific"}},"id":1}"""
        val e = assertFailsWith<ApiException> {
            clientAnswering(HttpStatusCode.OK, body)
                .execute(BlocksRequest(method = "api.x", params = emptyList(), id = 1))
        }
        e.name shouldBe "SomethingSpecific"
    }

    @Test
    fun `a 500 with a name still matches by name`() = runTest {
        val body =
            """{"jsonrpc":"2.0","error":{"code":500,"message":"Batch contains 150 payloads","data":{"name":"ValidationFailedException"}},"id":1}"""
        val e = assertFailsWith<ApiException> {
            clientAnswering(HttpStatusCode.OK, body)
                .execute(BlocksRequest(method = "api.x", params = emptyList(), id = 1))
        }
        e.status shouldBe 500
        e.isBlocksError("ValidationFailedException") shouldBe true
    }

    @Test
    fun `retriable crosses the wire`() = runTest {
        val body =
            """{"jsonrpc":"2.0","error":{"code":400,"message":"Wrong code","data":{"name":"CodeMismatchException","retriable":true}},"id":1}"""
        val e = assertFailsWith<ApiException> {
            clientAnswering(HttpStatusCode.OK, body)
                .execute(BlocksRequest(method = "api.x", params = emptyList(), id = 1))
        }
        e.retriable shouldBe true
    }

    @Test
    fun `a non-2xx response without a JSON-RPC error object is a TransportException`() = runTest {
        val routeError = assertFailsWith<TransportException> {
            clientAnswering(HttpStatusCode.NotFound, """{"error":"Not Found"}""")
                .execute(BlocksRequest(method = "api.x", params = emptyList(), id = 1))
        }
        routeError.statusCode shouldBe 404
        routeError.message shouldBe "Not Found"

        val notJson = assertFailsWith<TransportException> {
            clientAnswering(HttpStatusCode.BadGateway, "<html>bad gateway</html>")
                .execute(BlocksRequest(method = "api.x", params = emptyList(), id = 1))
        }
        notJson.statusCode shouldBe 502
        notJson.message shouldBe "HTTP 502"
    }

    @Test
    fun `a 2xx envelope with no result is a void success`() = runTest {
        val result = clientAnswering(HttpStatusCode.OK, """{"jsonrpc":"2.0","id":1}""")
            .execute(BlocksRequest(method = "api.x", params = emptyList(), id = 1))
        result shouldBe JsonNull
    }

    @Test
    fun `a 2xx envelope with a null result is a void success`() = runTest {
        val result = clientAnswering(HttpStatusCode.OK, """{"jsonrpc":"2.0","result":null,"id":1}""")
            .execute(BlocksRequest(method = "api.x", params = emptyList(), id = 1))
        result shouldBe JsonNull
    }

    @Test
    fun `a 2xx response that is not JSON is a TransportException`() = runTest {
        val e = assertFailsWith<TransportException> {
            clientAnswering(HttpStatusCode.OK, "<html>captive portal</html>")
                .execute(BlocksRequest(method = "api.x", params = emptyList(), id = 1))
        }
        e.statusCode shouldBe 200
        e.message shouldBe "Response was not a JSON-RPC envelope"
    }

    @Test
    fun `a cancellation is not turned into a TransportException`() = runTest {
        val client = BlocksClient(
            BlocksServer("local", "http://localhost:3000/cdk-blocks/api"),
            defaultHttpClient(
                MockEngine { throw CancellationException("cancelled") },
                cookiesStorage = AcceptAllCookiesStorage(),
            ),
        )
        assertFailsWith<CancellationException> {
            client.execute(BlocksRequest(method = "api.x", params = emptyList(), id = 1))
        }
    }

    @Test
    fun `a connection failure is a TransportException with no status`() = runTest {
        val client = BlocksClient(
            BlocksServer("local", "http://localhost:3000/cdk-blocks/api"),
            defaultHttpClient(
                MockEngine { throw RuntimeException("Connection refused") },
                cookiesStorage = AcceptAllCookiesStorage(),
            ),
        )
        val e = assertFailsWith<TransportException> {
            client.execute(BlocksRequest(method = "api.x", params = emptyList(), id = 1))
        }
        e.statusCode shouldBe null
        e.cause!!.message shouldBe "Connection refused"
    }

    private val request = BlocksRequest(method = "api.x", params = emptyList(), id = 1)

    @Test
    fun `a 2xx JSON object that is not an envelope is a TransportException`() = runTest {
        val e = assertFailsWith<TransportException> {
            clientAnswering(HttpStatusCode.OK, """{"status":"ok"}""").execute(request)
        }
        e.statusCode shouldBe 200
        e.message shouldBe "Response was not a JSON-RPC envelope"
    }

    @Test
    fun `a 2xx object whose jsonrpc is not 2_0 is a TransportException`() = runTest {
        val e = assertFailsWith<TransportException> {
            clientAnswering(HttpStatusCode.OK, """{"jsonrpc":"1.0","result":1,"id":1}""").execute(request)
        }
        e.message shouldBe "Response was not a JSON-RPC envelope"
    }

    @Test
    fun `a 2xx JSON array is a TransportException`() = runTest {
        val e = assertFailsWith<TransportException> {
            clientAnswering(HttpStatusCode.OK, """[1,2,3]""").execute(request)
        }
        e.statusCode shouldBe 200
        e.message shouldBe "Response was not a JSON-RPC envelope"
    }

    @Test
    fun `an error envelope populates the name and retriable and keeps the message verbatim`() = runTest {
        val body = """{"jsonrpc":"2.0","error":{"code":400,"message":"Wrong code, try again","data":{"name":"CodeMismatchException","retriable":true}},"id":1}"""
        val e = assertFailsWith<ApiException> {
            clientAnswering(HttpStatusCode.OK, body).execute(request)
        }
        e.name shouldBe "CodeMismatchException"
        e.retriable shouldBe true
        e.message shouldBe "Wrong code, try again"
        e.status shouldBe 400
    }

    @Test
    fun `retriable counts only a JSON boolean`() = runTest {
        for (retriable in listOf("\"true\"", "1", "null")) {
            val body = """{"jsonrpc":"2.0","error":{"code":400,"message":"m","data":{"name":"N","retriable":$retriable}},"id":1}"""
            val e = assertFailsWith<ApiException> {
                clientAnswering(HttpStatusCode.OK, body).execute(request)
            }
            e.retriable shouldBe false
        }
    }

    @Test
    fun `a gateway message body becomes the TransportException message`() = runTest {
        val e = assertFailsWith<TransportException> {
            clientAnswering(HttpStatusCode.GatewayTimeout, """{"message":"Endpoint request timed out"}""")
                .execute(request)
        }
        e.statusCode shouldBe 504
        e.message shouldBe "Endpoint request timed out"
    }

    @Test
    fun `a gateway message wins over an error string and an empty one falls through`() = runTest {
        val both = assertFailsWith<TransportException> {
            clientAnswering(HttpStatusCode.TooManyRequests, """{"message":"Too Many Requests","error":"other"}""")
                .execute(request)
        }
        both.message shouldBe "Too Many Requests"

        val empty = assertFailsWith<TransportException> {
            clientAnswering(HttpStatusCode.Forbidden, """{"message":"","error":"Forbidden"}""").execute(request)
        }
        empty.message shouldBe "Forbidden"

        val neither = assertFailsWith<TransportException> {
            clientAnswering(HttpStatusCode.Forbidden, """{"message":"","error":""}""").execute(request)
        }
        neither.message shouldBe "HTTP 403"
    }
}
