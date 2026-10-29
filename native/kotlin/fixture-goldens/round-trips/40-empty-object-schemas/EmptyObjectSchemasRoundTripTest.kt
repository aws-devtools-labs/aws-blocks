package com.example.app.roundtrip

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksServer
import com.example.app.Api
import com.example.app.Api.GetEnvelope
import com.sun.net.httpserver.HttpServer
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.InetSocketAddress

private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

/**
 * A JSON-RPC server on a free port that answers each method with [results] and records every
 * request it receives. [block] runs with a client for the server; the server stops afterwards.
 */
private fun withServer(results: Map<String, String>, block: (BlocksClient) -> Unit): List<JsonObject> {
    val received = mutableListOf<JsonObject>()
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    server.createContext("/") { exchange ->
        val request = Json.parseToJsonElement(exchange.requestBody.readBytes().decodeToString()).jsonObject
        received.add(request)
        val result = results.getValue(request.getValue("method").jsonPrimitive.content)
        val body = """{"jsonrpc":"2.0","id":${request["id"]},"result":$result}""".encodeToByteArray()
        exchange.responseHeaders.add("Content-Type", "application/json")
        exchange.sendResponseHeaders(200, body.size.toLong())
        exchange.responseBody.use { it.write(body) }
    }
    server.start()
    try {
        block(Blocks(BlocksServer(name = "local", url = "http://127.0.0.1:${server.address.port}")).client())
    } finally {
        server.stop(0)
    }
    return received
}

/**
 * Fixture 40: objects with no properties (`{ "type": "object" }`, `"properties": {}`, and a
 * component schema that is one). The base generator declared a `data class X()` for each, which
 * doesn't compile; here each is a `Map<String, JsonElement>` that keeps every field it carries.
 */
class EmptyObjectSchemasRoundTripTest : FunSpec({

    test("getOptions() sends its objects as they are and keeps every field of the one it gets back") {
        val received = withServer(mapOf("api.getOptions" to """{"a":1,"b":{"c":[true]}}""")) { client ->
            runBlocking {
                Api(client).getOptions(options = mapOf("x" to JsonPrimitive("y"))) shouldBe
                    json("""{"a":1,"b":{"c":[true]}}""").jsonObject
                Api(client).getOptions(options = emptyMap(), extra = mapOf("n" to JsonPrimitive(2))) shouldBe
                    json("""{"a":1,"b":{"c":[true]}}""").jsonObject
            }
        }
        received.map { it.getValue("params") } shouldBe listOf(json("""[{"x":"y"}]"""), json("""[{},{"n":2}]"""))
    }

    test("getSettings() round-trips a component schema with no properties") {
        val received = withServer(mapOf("api.getSettings" to """{"theme":"dark"}""")) { client ->
            runBlocking {
                Api(client).getSettings(mapOf("theme" to JsonPrimitive("light"))) shouldBe mapOf("theme" to JsonPrimitive("dark"))
            }
        }
        received.single().getValue("params") shouldBe json("""[{"theme":"light"}]""")
    }

    test("getEnvelope() decodes empty-object properties, list items and a missing optional one") {
        val reply = """{"id":"e","meta":{"k":"v"},"attachments":[{},{"size":3}]}"""
        withServer(mapOf("api.getEnvelope" to reply)) { client ->
            runBlocking {
                Api(client).getEnvelope() shouldBe GetEnvelope.Result(
                    id = "e",
                    meta = mapOf("k" to JsonPrimitive("v")),
                    attachments = listOf(emptyMap(), mapOf("size" to JsonPrimitive(3))),
                )
            }
        }
    }
})
