package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

private const val UNKNOWN = """{ "type": "unknown" }"""
private const val NULLABLE_UNKNOWN = """{ "oneOf": [ { "type": "unknown" }, { "type": "null" } ] }"""
private const val MAP_OF_UNKNOWN = """{ "type": "object", "additionalProperties": { "type": "unknown" } }"""
private const val LIST_OF_UNKNOWN = """{ "type": "array", "items": { "type": "unknown" } }"""

/** One method `api.op` with the given params and result, plus optional component schemas. */
private fun spec(params: String = "", result: String = """{ "type": "boolean" }""", schemas: String = "{}"): String =
    """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [
        { "name": "api.op", "params": [ $params ], "result": { "name": "OpResult", "schema": $result } }
      ],
      "components": { "schemas": $schemas }
    }
    """.trimIndent()

/** A component `Holder` with one property payload of [schema], required or not. */
private fun holder(schema: String, required: Boolean = true): String =
    spec(
        result = """{ "${'$'}ref": "#/components/schemas/Holder" }""",
        schemas = """
            { "Holder": { "type": "object", "properties": { "payload": $schema },
              "required": [ ${if (required) "\"payload\"" else ""} ] } }
        """.trimIndent(),
    )

private fun param(schema: String, required: Boolean = true): String =
    """{ "name": "payload", "required": $required, "schema": $schema }"""

private fun generate(spec: String): String {
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app").generate(model).files.joinToString("\n") { it.toString() }
}

/**
 * `unknown` (any JSON value) generates as kotlinx.serialization's `JsonElement`, which has a
 * built-in serializer — `Any` has none, so a `@Serializable` class holding it did not compile.
 */
class UnknownTypeTest : FunSpec({

    context("properties") {
        test("a required unknown property is JsonElement") {
            val source = generate(holder(UNKNOWN))
            source shouldContain "import kotlinx.serialization.json.JsonElement"
            source shouldContain "public val payload: JsonElement,"
        }

        test("an optional unknown property is JsonElement? defaulting to null") {
            generate(holder(UNKNOWN, required = false)) shouldContain "public val payload: JsonElement? = null,"
        }

        test("a nullable unknown property is JsonElement?") {
            generate(holder(NULLABLE_UNKNOWN)) shouldContain "public val payload: JsonElement?,"
        }

        test("a map of unknown is Map<String, JsonElement>") {
            generate(holder(MAP_OF_UNKNOWN)) shouldContain "public val payload: Map<String, JsonElement>,"
        }

        test("an optional, nullable map of unknown (AuthenticatedUser.claims) is Map<String, JsonElement>? = null") {
            val claims = """{ "oneOf": [ $MAP_OF_UNKNOWN, { "type": "null" } ] }"""
            generate(holder(claims, required = false)) shouldContain
                "public val payload: Map<String, JsonElement>? = null,"
        }

        test("a map of nullable unknown is Map<String, JsonElement?>") {
            val schema = """{ "type": "object", "additionalProperties": $NULLABLE_UNKNOWN }"""
            generate(holder(schema)) shouldContain "public val payload: Map<String, JsonElement?>,"
        }

        test("a list of unknown is List<JsonElement>") {
            generate(holder(LIST_OF_UNKNOWN)) shouldContain "public val payload: List<JsonElement>,"
        }

        test("an open-shape object with unknown extra properties keeps them as Map<String, JsonElement>") {
            val schema = """
                { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"],
                  "additionalProperties": { "type": "unknown" } }
            """.trimIndent()
            generate(spec(params = param(schema))) shouldContain
                "public val attributes: Map<String, JsonElement> = emptyMap(),"
        }
    }

    context("parameters") {
        test("a required unknown parameter is sent as-is") {
            val source = generate(spec(params = param(UNKNOWN)))
            source shouldContain "public suspend fun op(payload: JsonElement): Boolean"
            source shouldContain "params = listOf(payload)"
        }

        test("a required, nullable unknown parameter sends JSON null for null") {
            val source = generate(spec(params = param(NULLABLE_UNKNOWN)))
            source shouldContain "public suspend fun op(payload: JsonElement?): Boolean"
            source shouldContain "params = listOf(payload ?: JsonNull)"
        }

        test("an optional unknown parameter is added only when present") {
            val source = generate(spec(params = param(UNKNOWN, required = false)))
            source shouldContain "public suspend fun op(payload: JsonElement? = null): Boolean"
            source shouldContain "if (payload != null) listOf(payload) else listOf()"
        }

        test("a list of unknown parameter adds each element") {
            val source = generate(spec(params = param(LIST_OF_UNKNOWN)))
            source shouldContain "public suspend fun op(payload: List<JsonElement>): Boolean"
            source shouldContain "buildJsonArray { payload.forEach { add(it) } }"
        }

        test("a list of nullable unknown parameter adds JSON null for null elements") {
            val schema = """{ "type": "array", "items": $NULLABLE_UNKNOWN }"""
            val source = generate(spec(params = param(schema)))
            source shouldContain "public suspend fun op(payload: List<JsonElement?>): Boolean"
            source shouldContain "buildJsonArray { payload.forEach { add(it ?: JsonNull) } }"
        }

        test("a map of unknown parameter puts each value") {
            val source = generate(spec(params = param(MAP_OF_UNKNOWN)))
            source shouldContain "public suspend fun op(payload: Map<String, JsonElement>): Boolean"
            source shouldContain "buildJsonObject { payload.forEach { put(it.key, it.value) } }"
        }

        test("a map of nullable unknown parameter puts JSON null for null values") {
            val schema = """{ "type": "object", "additionalProperties": $NULLABLE_UNKNOWN }"""
            val source = generate(spec(params = param(schema)))
            source shouldContain "public suspend fun op(payload: Map<String, JsonElement?>): Boolean"
            source shouldContain "buildJsonObject { payload.forEach { put(it.key, it.value ?: JsonNull) } }"
        }
    }

    context("results") {
        test("an unknown result decodes as JsonElement") {
            val source = generate(spec(result = UNKNOWN))
            source shouldContain "public suspend fun op(): JsonElement"
            source shouldContain "return BlocksJson.decodeFromJsonElement(result)"
        }

        test("a nullable unknown result decodes as JsonElement?") {
            generate(spec(result = NULLABLE_UNKNOWN)) shouldContain "public suspend fun op(): JsonElement?"
        }

        test("a map of unknown result decodes as Map<String, JsonElement>") {
            generate(spec(result = MAP_OF_UNKNOWN)) shouldContain "public suspend fun op(): Map<String, JsonElement>"
        }

        test("a list of unknown result decodes as List<JsonElement>") {
            generate(spec(result = LIST_OF_UNKNOWN)) shouldContain "public suspend fun op(): List<JsonElement>"
        }

        test("a realtime channel of unknown messages is RealtimeChannel<JsonElement>") {
            val channel = """{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [ $UNKNOWN ] }"""
            val source = generate(spec(result = channel))
            source shouldContain "public suspend fun op(): RealtimeChannel<JsonElement>"
            source shouldContain "BlocksJson.decodeFromJsonElement<JsonElement>(it)"
        }
    }

    test("no unknown shape generates Any") {
        val shapes = listOf(UNKNOWN, NULLABLE_UNKNOWN, MAP_OF_UNKNOWN, LIST_OF_UNKNOWN)
        for (shape in shapes) {
            generate(holder(shape)) shouldNotContain "Any"
            generate(spec(params = param(shape), result = shape)) shouldNotContain "Any"
        }
    }
})
