package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

private fun ref(name: String): String = """{ "${'$'}ref": "#/components/schemas/$name" }"""

/** One method per entry of [results] (`api.get<Name>` returning that schema), and the [schemas] components. */
private fun spec(results: Map<String, String>, schemas: String): String =
    """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [ ${results.entries.joinToString { (name, schema) ->
        """{ "name": "api.get$name", "params": [], "result": { "name": "Get${name}Result", "schema": $schema } }"""
    }} ],
      "components": { "schemas": { $schemas } }
    }
    """.trimIndent()

private fun generate(spec: String): Map<String, String> {
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app").generate(model).files.associate { it.name to it.toString() }
}

/**
 * The parser expanded every `$ref` in place, so a schema that refers to itself (directly or through
 * another schema) expanded without end: a `StackOverflowError`. A reference back to a schema being
 * parsed now names its type.
 */
class RecursiveSchemaRefTest : FunSpec({

    test("a nullable self-reference is a nullable field of the class's own type") {
        val types = generate(
            spec(
                mapOf("List" to ref("ListItem")),
                """ "ListItem": { "type": "object", "properties": {
                      "value": { "type": "integer" },
                      "next": { "oneOf": [ ${ref("ListItem")}, { "type": "null" } ] },
                      "previous": ${ref("ListItem")}
                    }, "required": ["value", "next"] } """,
            ),
        ).getValue("Types")
        types shouldContain """
            |@Serializable
            |public data class ListItem(
            |  public val `value`: Int,
            |  public val next: ListItem?,
            |  public val previous: ListItem? = null,
            |)
        """.trimMargin()
    }

    test("a self-reference in a list or a map is a list or map of the class's own type") {
        val types = generate(
            spec(
                mapOf("Tree" to ref("TreeNode")),
                """ "TreeNode": { "type": "object", "properties": {
                      "children": { "type": "array", "items": ${ref("TreeNode")} },
                      "byName": { "type": "object", "additionalProperties": ${ref("TreeNode")} }
                    }, "required": ["children", "byName"] } """,
            ),
        ).getValue("Types")
        types shouldContain "public val children: List<TreeNode>,"
        types shouldContain "public val byName: Map<String, TreeNode>,"
    }

    test("mutually recursive schemas each refer to the other's class, whichever a method reaches first") {
        val types = generate(
            spec(
                mapOf("Category" to ref("Category"), "Product" to ref("Product")),
                """ "Category": { "type": "object", "properties": { "featured": ${ref("Product")} } },
                    "Product": { "type": "object", "properties": { "category": ${ref("Category")} } } """,
            ),
        ).getValue("Types")
        types shouldContain "public data class Category(\n  public val featured: Product? = null,\n)"
        types shouldContain "public data class Product(\n  public val category: Category? = null,\n)"
    }

    test("a self-reference in a union arm names the class") {
        val types = generate(
            spec(
                mapOf("Expr" to ref("Expr")),
                """ "Expr": { "type": "object", "properties": {
                      "operand": { "oneOf": [ ${ref("Expr")}, { "type": "number" } ] }
                    }, "required": ["operand"] } """,
            ),
        ).getValue("Types")
        types shouldContain "public data class Expr(\n  public val operand: Operand,\n)"
        types shouldContain "public data class Variant1(\n      public val `value`: Expr,\n    ) : Operand()"
    }

    test("a recursive schema that declares no class (a union) is an unknown value where it recurs") {
        val api = generate(
            spec(
                mapOf("Value" to ref("JsonValue")),
                """ "JsonValue": { "oneOf": [ { "type": "string" }, { "type": "array", "items": ${ref("JsonValue")} } ] } """,
            ),
        ).getValue("Api")
        api shouldContain "List<JsonElement>"
    }

    test("an object with no properties is a map of any values, never a class with no properties") {
        val files = generate(
            spec(
                mapOf(
                    "Any" to """{ "type": "object" }""",
                    "Empty" to """{ "type": "object", "properties": {} }""",
                    "Settings" to ref("Settings"),
                    "Holder" to """{ "type": "object", "properties": { "meta": { "type": "object" } }, "required": ["meta"] }""",
                ),
                """ "Settings": { "type": "object" } """,
            ),
        )
        val all = files.values.joinToString("\n")
        all shouldNotContain "data class Result()"
        all shouldNotContain "data class Settings()"
        all shouldNotContain "()\n"
        val api = files.getValue("Api")
        api shouldContain "public suspend fun getAny(): Map<String, JsonElement>"
        api shouldContain "public suspend fun getEmpty(): Map<String, JsonElement>"
        api shouldContain "public suspend fun getSettings(): Map<String, JsonElement>"
        api shouldContain "public val meta: Map<String, JsonElement>,"
    }
})
