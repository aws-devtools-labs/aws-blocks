package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

private const val NOTE = """{ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }"""

private fun ref(name: String): String = """{ "${'$'}ref": "#/components/schemas/$name" }"""

private val CHANNEL = """{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [${ref("Note")}] }"""
private const val DOWNLOAD = """{ "x-blocks-transferable": "file-bucket/download" }"""
private const val UPLOAD = """{ "x-blocks-transferable": "file-bucket/upload" }"""
private const val OIDC = """{ "x-blocks-transferable": "oidc/client" }"""
private const val UNBOUND = """{ "x-blocks-transferable": "acme/widget" }"""

private fun array(items: String): String = """{ "type": "array", "items": $items }"""
private fun map(values: String): String = """{ "type": "object", "additionalProperties": $values }"""
private fun nullable(inner: String): String = """{ "oneOf": [ $inner, { "type": "null" } ] }"""

private fun param(name: String, schema: String, required: Boolean = true): String =
    """{ "name": "$name", "required": $required, "schema": $schema }"""

/** `api.relay` taking [params] and returning a string, plus `Note` and [schemas]. */
private fun spec(vararg params: String, schemas: String = ""): String {
    val extra = if (schemas.isBlank()) "" else ", $schemas"
    return """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [
        { "name": "api.relay", "params": [ ${params.joinToString()} ], "result": { "name": "RelayResult", "schema": { "type": "string" } } }
      ],
      "components": { "schemas": { "Note": $NOTE $extra } }
    }
    """.trimIndent()
}

private fun generate(spec: String): Map<String, String> {
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app", relayTo = "app://cb").generate(model).files
        .associate { it.name to it.toString() }
}

private fun api(spec: String): String = generate(spec).getValue("Api")

/**
 * A transferable parameter (an operation that takes a `RealtimeChannel`, a file handle or an
 * OIDC client) made the Kotlin generator throw "Transferable types (…) cannot be serialized", so
 * a backend with one generated no Kotlin client at all. Swift encodes a transferable as its
 * `{ "__blocks": … }` descriptor, the shape the server's `toJSON()` sends; Kotlin now does too,
 * with the runtime's `toJson()`, directly and inside lists, maps, nullables and models.
 */
class TransferableParameterTest : FunSpec({

    test("a channel parameter is sent as its descriptor") {
        val source = api(spec(param("feed", CHANNEL)))
        source shouldContain "public suspend fun relay(feed: RealtimeChannel<Note>): String {"
        source shouldContain "params = listOf(feed.toJson())"
    }

    test("an optional channel parameter is sent only when present") {
        val source = api(spec(param("feed", CHANNEL, required = false)))
        source shouldContain "public suspend fun relay(feed: RealtimeChannel<Note>? = null): String {"
        source shouldContain "if (feed != null) listOf(feed.toJson()) else listOf()"
    }

    test("a required nullable channel parameter sends null as JSON null") {
        val source = api(spec(param("feed", nullable(CHANNEL))))
        source shouldContain "public suspend fun relay(feed: RealtimeChannel<Note>?): String {"
        source shouldContain "params = listOf(feed?.toJson() ?: JsonNull)"
    }

    test("lists and maps of channels send each descriptor") {
        val source = api(spec(param("feeds", array(CHANNEL)), param("byRoom", map(CHANNEL)), param("maybe", array(nullable(CHANNEL)))))
        source shouldContain "buildJsonArray { feeds.forEach { add(it.toJson()) } }"
        source shouldContain "buildJsonObject { byRoom.forEach { put(it.key, it.value.toJson()) } }"
        source shouldContain "buildJsonArray { maybe.forEach { add(if (it != null) it.toJson() else JsonNull) } }"
    }

    test("a map of nullable channels sends JSON null for a null value") {
        val source = api(spec(param("byRoom", map(nullable(CHANNEL)))))
        source shouldContain "buildJsonObject { byRoom.forEach { put(it.key, it.value?.toJson() ?: JsonNull) } }"
    }

    test("file handles and OIDC clients are sent as their descriptors") {
        val source = api(spec(param("download", DOWNLOAD), param("upload", UPLOAD), param("login", OIDC)))
        source shouldContain "download: FileDownloadHandle,\n    upload: FileUploadHandle,\n    login: OidcClient,\n  ): String {"
        source shouldContain "params = listOf(download.toJson(), upload.toJson(), login.toJson())"
    }

    test("an unbound tag's parameter is a JsonElement and is sent as is") {
        val source = api(spec(param("widget", UNBOUND)))
        source shouldContain "public suspend fun relay(widget: JsonElement): String {"
        source shouldContain "params = listOf(widget)"
    }

    test("a channel's inline payload is a nested type of the operation") {
        val inline = """{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [{ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }] }"""
        val source = api(spec(param("feed", inline)))
        source shouldContain "public suspend fun relay(feed: RealtimeChannel<Relay.Feed>): String {"
        source shouldContain "public data class Feed("
    }

    test("a model holding a channel encodes it through its serializer, as its descriptor") {
        val holder = """ "Holder": { "type": "object", "properties": { "feed": $CHANNEL }, "required": ["feed"] } """
        val files = generate(spec(param("holder", ref("Holder")), schemas = holder))
        files.getValue("Api") shouldContain "params = listOf(BlocksJson.encodeToJsonElement(holder))"
        val serializers = files.getValue("Serializers")
        serializers shouldContain
            "override fun serialize(encoder: Encoder, `value`: RealtimeChannel<Note>) {\n" +
            "    (encoder as JsonEncoder).encodeJsonElement(value.toJson())\n" +
            "  }"
        serializers shouldNotContain "read-only"
    }

    test("a model holding an OIDC client encodes with OidcClient.json, which can encode it") {
        val holder = """ "Holder": { "type": "object", "properties": { "login": $OIDC }, "required": ["login"] } """
        val source = api(spec(param("holder", ref("Holder")), schemas = holder))
        source shouldContain "params = listOf(OidcClient.json(client, \"app://cb\").encodeToJsonElement(holder))"
    }
})
