package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
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
 * Transferables are read-only: the server hands them out, and nothing sends one back (the server
 * never re-hydrates a `{ "__blocks": … }` parameter). An operation that takes a channel, a file
 * handle or an OIDC client, directly or inside a list, map or nullable, fails code generation with
 * a clear error. A model holding one still generates, and encoding it throws at runtime.
 */
class TransferableParameterTest : FunSpec({

    fun refuses(tag: String, vararg params: String) {
        shouldThrow<CodegenException> { generate(spec(*params)) }.message shouldBe
            "Transferable types ($tag) cannot be serialized — they are read-only"
    }

    test("a channel parameter is refused, required, optional or nullable") {
        refuses("realtime/channel", param("feed", CHANNEL))
        refuses("realtime/channel", param("feed", CHANNEL, required = false))
        refuses("realtime/channel", param("feed", nullable(CHANNEL)))
    }

    test("lists and maps of channels are refused") {
        refuses("realtime/channel", param("feeds", array(CHANNEL)))
        refuses("realtime/channel", param("byRoom", map(CHANNEL)))
        refuses("realtime/channel", param("maybe", array(nullable(CHANNEL))))
    }

    test("file handles, OIDC clients and unbound tags are refused") {
        refuses("file-bucket/download", param("download", DOWNLOAD))
        refuses("file-bucket/upload", param("upload", UPLOAD))
        refuses("oidc/client", param("login", OIDC))
        refuses("acme/widget", param("widget", UNBOUND))
    }

    test("a model holding a channel generates, and its serializer refuses to encode the channel") {
        val holder = """ "Holder": { "type": "object", "properties": { "feed": $CHANNEL }, "required": ["feed"] } """
        val files = generate(spec(param("holder", ref("Holder")), schemas = holder))
        files.getValue("Api") shouldContain "params = listOf(BlocksJson.encodeToJsonElement(holder))"
        val serializers = files.getValue("Serializers")
        serializers shouldContain "override fun serialize(encoder: Encoder, `value`: RealtimeChannel<Note>): Unit = " +
            "throw UnsupportedOperationException(\"Transferables are read-only\")"
        serializers shouldNotContain "toJson()"
    }

    test("a model holding an OIDC client encodes with plain BlocksJson, which can't encode one") {
        val holder = """ "Holder": { "type": "object", "properties": { "login": $OIDC }, "required": ["login"] } """
        val source = api(spec(param("holder", ref("Holder")), schemas = holder))
        source shouldContain "params = listOf(BlocksJson.encodeToJsonElement(holder))"
        source shouldNotContain "OidcClient.json(client, \"app://cb\").encodeToJsonElement"
    }
})
