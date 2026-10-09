package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.string.shouldStartWith

private const val UUID = """{ "type": "string", "format": "uuid" }"""

private const val ACTION = """{ "oneOf": [
    { "type": "object", "properties": { "kind": { "type": "string", "enum": ["a"] } }, "required": ["kind"] },
    { "type": "object", "properties": { "kind": { "type": "string", "enum": ["b"] } }, "required": ["kind"] }
] }"""

private fun spec(methods: String, schemas: String = ""): String =
    """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [ $methods ],
      "components": { "schemas": { $schemas } }
    }
    """.trimIndent()

private fun method(name: String, params: String, result: String): String =
    """{ "name": "api.$name", "params": [ $params ], "result": { "name": "${name}Result", "schema": $result } }"""

private fun generate(spec: String): Map<String, String> {
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app").generate(model).files.associate { it.name to it.toString() }
}

private fun String.count(needle: String): Int = windowed(needle.length).count { it == needle }

/**
 * `format: uuid` maps to `kotlin.uuid.Uuid`, which is `@ExperimentalUuidApi`, an opt-in marker at
 * level ERROR. The generated files used it without opting in, so a client generated from any spec
 * with a uuid didn't compile (fixture `06-format-types`, found by compiling every golden, R58).
 */
class UuidOptInTest : FunSpec({

    test("an API file that uses Uuid in a parameter or result opts in to ExperimentalUuidApi") {
        val api = generate(
            spec(method("getEvent", """{ "name": "id", "required": true, "schema": $UUID }""",
                """{ "type": "object", "properties": { "id": $UUID }, "required": ["id"] }""")),
        ).getValue("Api")
        api shouldStartWith "@file:OptIn(ExperimentalUuidApi::class)\n"
        api shouldContain "import kotlin.uuid.ExperimentalUuidApi"
        api shouldContain "public suspend fun getEvent(id: Uuid)"
    }

    test("Types.kt opts in when a component schema has a uuid field; a file that doesn't use Uuid doesn't") {
        val files = generate(
            spec(
                method("get", "", """{ "${'$'}ref": "#/components/schemas/Event" }"""),
                """ "Event": { "type": "object", "properties": { "id": $UUID, "tags": { "type": "array", "items": $UUID } }, "required": ["id", "tags"] } """,
            ),
        )
        val types = files.getValue("Types")
        types shouldStartWith "@file:OptIn(ExperimentalUuidApi::class)\n"
        types shouldContain "public val tags: List<Uuid>,"
        files.getValue("Api") shouldNotContain "ExperimentalUuidApi"
        files.getValue("Servers") shouldNotContain "ExperimentalUuidApi"
    }

    test("a file that also needs ExperimentalSerializationApi gets one @OptIn naming both markers") {
        val api = generate(
            spec(method("act", """{ "name": "action", "required": true, "schema": $ACTION }""",
                """{ "type": "object", "properties": { "id": $UUID }, "required": ["id"] }""")),
        ).getValue("Api")
        api shouldStartWith "@file:OptIn(\n  ExperimentalSerializationApi::class,\n  ExperimentalUuidApi::class,\n)\n"
        api.count("@file:OptIn") shouldBe 1
    }

    test("a spec without a uuid has no ExperimentalUuidApi opt-in") {
        val files = generate(
            spec(method("act", """{ "name": "action", "required": true, "schema": $ACTION }""",
                """{ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }""")),
        )
        files.values.forEach { it shouldNotContain "ExperimentalUuidApi" }
        files.getValue("Api") shouldStartWith "@file:OptIn(ExperimentalSerializationApi::class)\n"
    }
})
