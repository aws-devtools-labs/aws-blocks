package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

private fun ref(name: String): String = """{ "${'$'}ref": "#/components/schemas/$name" }"""

private const val LEVEL = """{ "type": "string", "enum": ["low", "high"] }"""

/** `api.op(level)` returning a component `Holder`, plus `Level` and any [extra] component schemas. */
private fun spec(holderProperties: String, required: List<String>, extra: String = "", param: String = ref("Level")): String =
    """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [
        { "name": "api.op", "params": [ { "name": "level", "required": true, "schema": $param } ],
          "result": { "name": "OpResult", "schema": ${ref("Holder")} } },
        { "name": "api.getLevel", "params": [], "result": { "name": "GetLevelResult", "schema": ${ref("Level")} } }
      ],
      "components": { "schemas": {
        "Level": $LEVEL,
        "Holder": { "type": "object", "properties": { $holderProperties }, "required": [ ${required.joinToString { "\"$it\"" }} ] }
        $extra
      } }
    }
    """.trimIndent()

private fun generate(spec: String): Map<String, String> {
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app").generate(model).files.associate { it.name to it.toString() }
}

private fun String.count(needle: String): Int = windowed(needle.length).count { it == needle }

/**
 * The parser accepted a `$ref` only to an object schema and threw
 * `$ref '#/components/schemas/Level' resolved to non-object type` for anything else, such as
 * an enum (R52). Dart and Swift accept such a `$ref`.
 */
class NonObjectSchemaRefTest : FunSpec({

    test("a \$ref to an enum generates one top-level enum named after the schema") {
        val files = generate(
            spec(
                """ "level": ${ref("Level")}, "levels": { "type": "array", "items": ${ref("Level")} },
                    "byUser": { "type": "object", "additionalProperties": { "type": "array", "items": ${ref("Level")} } },
                    "maybe": { "oneOf": [ ${ref("Level")}, { "type": "null" } ] } """,
                listOf("level", "levels", "byUser", "maybe"),
            ),
        )
        val types = files.getValue("Types")
        types shouldContain """
            |@Serializable
            |public enum class Level {
            |  @SerialName("low")
            |  Low,
            |  @SerialName("high")
            |  High,
            |}
        """.trimMargin()
        types.count("enum class Level") shouldBe 1
        types shouldContain "public val level: Level,"
        types shouldContain "public val levels: List<Level>,"
        types shouldContain "public val byUser: Map<String, List<Level>>,"
        types shouldContain "public val maybe: Level?,"
        types shouldNotContain "enum class Levels"
        types shouldNotContain "Holder.Level"
    }

    test("a \$ref'd enum is shared by every schema, parameter and result that uses it") {
        val files = generate(
            spec(
                """ "level": ${ref("Level")}, "other": ${ref("Other")} """,
                listOf("level", "other"),
                extra = """, "Other": { "type": "object", "properties": { "level": ${ref("Level")} }, "required": ["level"] }""",
            ),
        )
        files.getValue("Types").count("enum class Level") shouldBe 1
        val api = files.getValue("Api")
        api shouldContain "public suspend fun op(level: Level): Holder"
        api shouldContain "public suspend fun getLevel(): Level"
        api shouldNotContain "enum class"
    }

    test("a \$ref to a primitive, array, map or nullable schema uses the referenced type") {
        val files = generate(
            spec(
                """ "id": ${ref("UserId")}, "tags": ${ref("Tags")}, "scores": ${ref("Scores")}, "note": ${ref("MaybeNote")} """,
                listOf("id", "tags", "scores", "note"),
                extra = """,
                  "UserId": { "type": "string" },
                  "Tags": { "type": "array", "items": { "type": "string" } },
                  "Scores": { "type": "object", "additionalProperties": { "type": "integer" } },
                  "Note": { "type": "object", "properties": { "body": { "type": "string" } }, "required": ["body"] },
                  "MaybeNote": { "oneOf": [ ${ref("Note")}, { "type": "null" } ] }
                """,
            ),
        )
        val types = files.getValue("Types")
        types shouldContain "public val id: String,"
        types shouldContain "public val tags: List<String>,"
        types shouldContain "public val scores: Map<String, Int>,"
        types shouldContain "public val note: Note?,"
        types shouldNotContain "class UserId"
        types shouldNotContain "class Tags"
    }

    test("a \$ref to an object schema is unchanged") {
        val types = generate(
            spec(""" "note": ${ref("Note")} """, listOf("note"), extra = """, "Note": { "type": "object", "properties": { "body": { "type": "string" } }, "required": ["body"] }"""),
        ).getValue("Types")
        types shouldContain "public val note: Note,"
        types shouldContain "public data class Note("
    }
})
