package com.example.app.roundtrip

import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import com.example.app.A
import com.example.app.Api
import com.example.app.Api.One
import com.example.app.Api.Two
import com.example.app.Profile
import com.sun.net.httpserver.HttpServer
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.InetSocketAddress

private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

/**
 * A JSON-RPC server on a free port that answers each method with [results] and records every
 * request it receives. [block] runs with the server's URL; the server stops afterwards.
 */
private fun withServer(results: Map<String, String>, block: (BlocksServer) -> Unit): List<JsonObject> {
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
        block(BlocksServer(name = "local", url = "http://127.0.0.1:${server.address.port}"))
    } finally {
        server.stop(0)
    }
    return received
}

/**
 * Fixture 35: names from the spec that met each other, or names the generator declares, in the
 * Kotlin client. On the base generator this fixture doesn't generate (KotlinPoet throws on
 * `a.b.ping`'s operation `b.ping`); without that method its golden doesn't compile (`Profile`
 * declares a property and a nested class `Meta`, and two `State.InProgress`), and `two()` names a
 * `Result` that doesn't exist. Here every one round-trips its wire JSON.
 */
class GeneratedNameCollisionsRoundTripTest : FunSpec({

    test("Profile's user_name and userName each decode into their own type, and keep their wire names") {
        val wire = json(
            """{"user_name":{"first":"Ada"},"userName":{"last":"Lovelace"},"Meta":{"x":"m"},"state":"in_progress"}""",
        )
        val profile = Profile(
            user_name = Profile.UserName(first = "Ada"),
            userName = Profile.UserName_2(last = "Lovelace"),
            Meta = Profile.Meta_2(x = "m"),
            state = Profile.State.InProgress_2,
        )
        BlocksJson.decodeFromJsonElement(Profile.serializer(), wire) shouldBe profile
        BlocksJson.encodeToJsonElement(Profile.serializer(), profile) shouldBe wire
        BlocksJson.encodeToJsonElement(Profile.State.serializer(), Profile.State.InProgress) shouldBe json("\"in-progress\"")
    }

    test("send() sends request, class, args and json as its parameters, beside the stepped-aside locals") {
        val received = withServer(mapOf("api.send" to """{"sent":"ok"}""")) { server ->
            runBlocking {
                Api(server).send(request = "r", `class` = "c", args = "a", json = "j").sent shouldBe "ok"
                Api(server).send(request = "r", `class` = "c").sent shouldBe "ok"
            }
        }
        received.map { it.getValue("params") } shouldBe listOf(json("""["r","c","a","j"]"""), json("""["r","c"]"""))
        received.map { it.getValue("method").jsonPrimitive.content } shouldBe listOf("api.send", "api.send")
    }

    // FX45 (R81): params are positional on the server, so a left-out optional argument before a
    // set one is null in its slot, as the TypeScript client sends it. The base sent ["r","c","j"]:
    // the server read json's value as args.
    test("send() keeps json in its slot when args is left out, and leaves off trailing unset arguments") {
        val received = withServer(mapOf("api.send" to """{"sent":"ok"}""")) { server ->
            runBlocking {
                Api(server).send(request = "r", `class` = "c", json = "j").sent shouldBe "ok"
                Api(server).send(request = "r", `class` = "c", args = "a").sent shouldBe "ok"
            }
        }
        received.map { it.getValue("params") } shouldBe listOf(json("""["r","c",null,"j"]"""), json("""["r","c","a"]"""))
    }

    test("one() and two(), whose results share the spec name Same, decode into their own Result") {
        withServer(mapOf("api.one" to """{"a":"x"}""", "api.two" to """{"b":2}""")) { server ->
            runBlocking {
                Api(server).one() shouldBe One.Result(a = "x")
                Api(server).two() shouldBe Two.Result(b = 2.0)
            }
        }
    }

    test("bPing() sends its spec method name a.b.ping") {
        val received = withServer(mapOf("a.b.ping" to "\"pong\"")) { server ->
            runBlocking { A(server).bPing() shouldBe "pong" }
        }
        received.single().getValue("method").jsonPrimitive.content shouldBe "a.b.ping"
    }
})
