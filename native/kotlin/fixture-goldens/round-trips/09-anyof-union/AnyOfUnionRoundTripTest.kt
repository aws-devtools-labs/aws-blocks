package com.example.app.roundtrip

import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import com.example.app.Api
import com.example.app.Api.Search
import com.sun.net.httpserver.HttpServer
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import java.net.InetSocketAddress

private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

/**
 * Fixture 09: `Search.Query` is `anyOf [string, { text, fuzzy? }]`, a union with no discriminator.
 * On the wire each value is the arm's bare JSON value: `"abc"` or `{"text":"t"}`, never a
 * `{"type": …}` wrapper.
 */
class AnyOfUnionRoundTripTest : FunSpec({

    val serializer = Search.Query.serializer()

    test("the string arm carries its value: \"abc\" round-trips") {
        BlocksJson.decodeFromJsonElement(serializer, json("\"abc\"")) shouldBe Search.Query.Variant1("abc")
        BlocksJson.encodeToJsonElement(serializer, Search.Query.Variant1("abc")) shouldBe json("\"abc\"")
    }

    test("the object arm is the bare object, without a type discriminator") {
        BlocksJson.decodeFromJsonElement(serializer, json("""{"text":"t"}""")) shouldBe Search.Query.Variant2("t")
        BlocksJson.decodeFromJsonElement(serializer, json("""{"text":"t","fuzzy":true}""")) shouldBe
            Search.Query.Variant2("t", fuzzy = true)
        BlocksJson.encodeToJsonElement(serializer, Search.Query.Variant2("t")) shouldBe json("""{"text":"t"}""")
        BlocksJson.encodeToJsonElement(serializer, Search.Query.Variant2("t", fuzzy = false)) shouldBe
            json("""{"text":"t","fuzzy":false}""")
    }

    test("a value no arm matches throws a SerializationException that names the union") {
        for (text in listOf("42", "true", "null", "[]", """{"fuzzy":true}""")) {
            val error = shouldThrow<SerializationException> { BlocksJson.decodeFromJsonElement(serializer, json(text)) }
            error.message shouldContain "Query"
        }
    }

    test("search() sends the bare value as its parameter") {
        val received = mutableListOf<JsonElement>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            val request = Json.parseToJsonElement(exchange.requestBody.readBytes().decodeToString()).jsonObject
            received.add(request.getValue("params").jsonArray.single())
            val body = """{"jsonrpc":"2.0","id":${request["id"]},"result":{"count":1}}""".encodeToByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            val api = Api(BlocksServer(name = "local", url = "http://127.0.0.1:${server.address.port}"))
            runBlocking {
                api.search(Search.Query.Variant1("abc")).count shouldBe 1
                api.search(Search.Query.Variant2("t", fuzzy = true)).count shouldBe 1
            }
        } finally {
            server.stop(0)
        }
        received shouldBe listOf(json("\"abc\""), json("""{"text":"t","fuzzy":true}"""))
        (received[1] as JsonObject).containsKey("type") shouldBe false
    }
})
