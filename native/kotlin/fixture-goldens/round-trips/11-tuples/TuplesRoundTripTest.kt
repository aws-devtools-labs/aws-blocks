package com.example.app.roundtrip

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import com.example.app.Api
import com.example.app.Api.GetCoords
import com.example.app.Api.GetPair
import com.example.app.Api.GetShortTuples
import com.example.app.Api.QueryRange
import com.sun.net.httpserver.HttpServer
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
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
 * Fixture 11: tuples (`prefixItems`, TypeScript `[number, number]`) as results, parameters, an
 * object's property and a list's elements. Each is a data class with `item0`, `item1`, …, and on
 * the wire a JSON array of their values. The plugin serializer the base generator used read and
 * wrote `{"item0":…,"item1":…}`, which the server neither sends nor reads.
 */
class TuplesRoundTripTest : FunSpec({

    test("a tuple decodes from and encodes to a JSON array") {
        BlocksJson.decodeFromJsonElement(GetCoords.Result.serializer(), json("""[1.5,2,"z"]""")) shouldBe
            GetCoords.Result(1.5, 2.0, "z")
        BlocksJson.encodeToJsonElement(GetCoords.Result.serializer(), GetCoords.Result(1.5, 2.0, "z")) shouldBe
            json("""[1.5,2.0,"z"]""")
        BlocksJson.decodeFromJsonElement(GetPair.Result.serializer(), json("""["a",3]""")) shouldBe GetPair.Result("a", 3)
    }

    test("a missing optional element decodes as null") {
        BlocksJson.decodeFromJsonElement(QueryRange.Cursor.serializer(), json("""["c"]""")) shouldBe QueryRange.Cursor("c", null)
        BlocksJson.decodeFromJsonElement(QueryRange.Cursor.serializer(), json("""["c",4]""")) shouldBe QueryRange.Cursor("c", 4)
    }

    test("a one-element tuple is a one-element array, and a short tuple's missing optional element is null") {
        val wire = json("""{"one":[5],"short":["c"]}""")
        val decoded = BlocksJson.decodeFromJsonElement(GetShortTuples.Result.serializer(), wire)
        decoded shouldBe GetShortTuples.Result(GetShortTuples.Result.One(5.0), GetShortTuples.Result.Short("c", null))
        BlocksJson.encodeToJsonElement(GetShortTuples.One.serializer(), GetShortTuples.One("x")) shouldBe json("""["x"]""")
    }

    test("an object, or an array missing a required element, is not a tuple") {
        shouldThrow<SerializationException> {
            BlocksJson.decodeFromJsonElement(QueryRange.Range.serializer(), json("""{"item0":0,"item1":10}"""))
        }
        shouldThrow<SerializationException> {
            BlocksJson.decodeFromJsonElement(QueryRange.Range.serializer(), json("""[0]"""))
        }
    }

    test("queryRange() sends its tuples as arrays and decodes the tuples in its result") {
        val reply = """{"where":{"between":["a","m"]},"pairs":[["p",1],["q",2]]}"""
        val received = withServer(mapOf("api.queryRange" to reply)) { client ->
            runBlocking {
                Api(client).queryRange(QueryRange.Range(0.0, 10.0), QueryRange.Cursor("c", 4)) shouldBe QueryRange.Result(
                    where = QueryRange.Result.Where(QueryRange.Result.Where.Between("a", "m")),
                    pairs = listOf(QueryRange.Result.Pairs("p", 1), QueryRange.Result.Pairs("q", 2)),
                )
                Api(client).queryRange(QueryRange.Range(0.0, 10.0))
            }
        }
        received.map { it.getValue("params") } shouldBe listOf(json("""[[0.0,10.0],["c",4]]"""), json("""[[0.0,10.0]]"""))
    }
})
