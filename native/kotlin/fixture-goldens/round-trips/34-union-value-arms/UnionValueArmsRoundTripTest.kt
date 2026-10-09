package com.example.app.roundtrip

import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import com.example.app.Api
import com.example.app.Api.EchoCollection
import com.example.app.Api.EchoLiteral
import com.example.app.Api.EchoMoment
import com.example.app.Api.EchoPrimitive
import com.example.app.Api.EchoShape
import com.example.app.Api.EchoTagged
import com.example.app.Api.GetFile
import com.example.app.Point
import com.sun.net.httpserver.HttpServer
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlinx.coroutines.runBlocking
import kotlinx.datetime.Instant
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import java.net.InetSocketAddress

private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

/** Decodes [wire], checks the value, and checks that encoding it writes [wire] back. */
private fun <T> roundTrip(serializer: KSerializer<T>, wire: String, expected: T) {
    BlocksJson.decodeFromJsonElement(serializer, json(wire)) shouldBe expected
    BlocksJson.encodeToJsonElement(serializer, expected) shouldBe json(wire)
}

private fun <T> rejects(serializer: KSerializer<T>, vararg wires: String) {
    for (wire in wires) {
        val error = shouldThrow<SerializationException> { BlocksJson.decodeFromJsonElement(serializer, json(wire)) }
        error.message shouldContain "No variant of"
    }
}

/**
 * Fixture 34: unions with no discriminator (and one with a string discriminator plus a string arm)
 * whose arms are every JSON kind. Each value is the arm's bare JSON value on the wire, and decodes
 * to the first arm, in spec order, whose shape it has.
 */
class UnionValueArmsRoundTripTest : FunSpec({

    test("string, integer, number, boolean and null arms") {
        val serializer = EchoPrimitive.Value.serializer().nullable
        roundTrip(serializer, "\"abc\"", EchoPrimitive.Value.Variant1("abc"))
        roundTrip(serializer, "42", EchoPrimitive.Value.Variant2(42))
        roundTrip(serializer, "1.5", EchoPrimitive.Value.Variant3(1.5))
        roundTrip(serializer, "true", EchoPrimitive.Value.Variant4(true))
        roundTrip(serializer, "null", null)
        // A quoted number or boolean is a string, not the number or boolean.
        roundTrip(serializer, "\"42\"", EchoPrimitive.Value.Variant1("42"))
        roundTrip(serializer, "\"true\"", EchoPrimitive.Value.Variant1("true"))
        rejects(EchoPrimitive.Value.serializer(), "[]", "{}", "null")
    }

    test("array and map arms") {
        val serializer = EchoCollection.Value.serializer()
        roundTrip(serializer, """["a","b"]""", EchoCollection.Value.Variant1(listOf("a", "b")))
        roundTrip(serializer, """{"a":1,"b":2}""", EchoCollection.Value.Variant2(mapOf("a" to 1, "b" to 2)))
        rejects(serializer, "\"a\"", "[1]", """{"a":"x"}""")
    }

    test("object arms (a \$ref and inline), an array of a \$ref, and a map, in spec order") {
        val serializer = EchoShape.Value.serializer()
        roundTrip(serializer, """{"x":1.0,"y":2.0}""", EchoShape.Value.Point(1.0, 2.0))
        roundTrip(serializer, """{"label":"l","tags":["t"]}""", EchoShape.Value.Variant2("l", listOf("t")))
        roundTrip(serializer, """{"label":"l"}""", EchoShape.Value.Variant2("l"))
        roundTrip(serializer, """[{"x":1.0,"y":2.0}]""", EchoShape.Value.Variant3(listOf(Point(1.0, 2.0))))
        // An object without either arm's required keys is the map arm.
        roundTrip(serializer, """{"note":"n"}""", EchoShape.Value.Variant4(mapOf("note" to "n")))
        // Required keys present but the wrong type: the object arm fails, so the next arm is tried.
        roundTrip(serializer, """{"x":"a","y":"b"}""", EchoShape.Value.Variant4(mapOf("x" to "a", "y" to "b")))
        rejects(serializer, "\"a\"", "1", "[1]", """{"note":1}""")
    }

    test("literal arms keep their JSON type") {
        val serializer = EchoLiteral.Value.serializer()
        roundTrip(serializer, "\"auto\"", EchoLiteral.Value.Variant1)
        roundTrip(serializer, "5", EchoLiteral.Value.Variant2)
        roundTrip(serializer, "true", EchoLiteral.Value.Variant3)
        roundTrip(serializer, "\"large\"", EchoLiteral.Value.Variant4("large"))
        roundTrip(serializer, """{"size":2.5}""", EchoLiteral.Value.Variant5(2.5))
        rejects(serializer, "\"5\"", "\"true\"", "false", "6", "\"medium\"")
    }

    test("a string-discriminated union with a string arm") {
        val serializer = EchoTagged.Value.serializer()
        roundTrip(serializer, "\"plain\"", EchoTagged.Value.Variant1("plain"))
        roundTrip(serializer, """{"kind":"circle","radius":1.0}""", EchoTagged.Value.Circle(1.0))
        roundTrip(serializer, """{"kind":"square","side":2.0}""", EchoTagged.Value.Square(2.0))
        rejects(serializer, """{"kind":"triangle"}""", """{"radius":1.0}""", "1")
    }

    test("a date-time arm and an integer arm") {
        val serializer = EchoMoment.Value.serializer()
        roundTrip(serializer, "\"2026-01-02T03:04:05Z\"", EchoMoment.Value.Variant1(Instant.parse("2026-01-02T03:04:05Z")))
        roundTrip(serializer, "1767323045", EchoMoment.Value.Variant2(1767323045))
        rejects(serializer, "\"yesterday\"", "true")
    }

    test("a transferable arm decodes by its __blocks tag and encodes as its descriptor") {
        val serializer = GetFile.Result.serializer()
        val handle = BlocksJson.decodeFromJsonElement(
            serializer,
            json("""{"__blocks":"file-bucket/download","url":"https://example.com/f"}"""),
        ).shouldBeInstanceOf<GetFile.Result.Variant1>()
        handle.value.url shouldBe "https://example.com/f"
        // A transferable arm encodes as its descriptor (FX29's toJson), with its tag.
        BlocksJson.encodeToJsonElement(serializer, handle) shouldBe
            json("""{"__blocks":"file-bucket/download","url":"https://example.com/f"}""")
        roundTrip(serializer, """{"reason":"gone"}""", GetFile.Result.Variant2("gone"))
        rejects(serializer, """{"__blocks":"file-bucket/upload","url":"u"}""")
    }

    test("the generated client sends and reads the bare values") {
        val received = mutableListOf<JsonElement>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            val request = Json.parseToJsonElement(exchange.requestBody.readBytes().decodeToString()).jsonObject
            val param = request.getValue("params").jsonArray.single()
            received.add(param)
            val body = """{"jsonrpc":"2.0","id":${request["id"]},"result":$param}""".encodeToByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            val api = Api(BlocksServer(name = "local", url = "http://127.0.0.1:${server.address.port}"))
            runBlocking {
                api.echoPrimitive(EchoPrimitive.Value.Variant2(7)) shouldBe EchoPrimitive.Result.Variant2(7)
                api.echoPrimitive(null) shouldBe null
                api.echoShape(EchoShape.Value.Variant4(mapOf("k" to "v"))) shouldBe EchoShape.Result.Variant4(mapOf("k" to "v"))
                api.echoLiteral(EchoLiteral.Value.Variant3) shouldBe EchoLiteral.Result.Variant3
                api.echoTagged(EchoTagged.Value.Circle(2.0)) shouldBe EchoTagged.Result.Circle(2.0)
            }
        } finally {
            server.stop(0)
        }
        received shouldBe listOf(json("7"), json("null"), json("""{"k":"v"}"""), json("true"), json("""{"kind":"circle","radius":2.0}"""))
    }
})
