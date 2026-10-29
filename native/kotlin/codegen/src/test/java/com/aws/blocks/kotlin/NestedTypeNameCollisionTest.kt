package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

private const val STRING = """{ "type": "string" }"""
private const val NUMBER = """{ "type": "number" }"""

private fun obj(vararg properties: Pair<String, String>): String {
    val props = properties.joinToString(", ") { (name, schema) -> "\"$name\": $schema" }
    val required = properties.joinToString(", ") { "\"${it.first}\"" }
    return """{ "type": "object", "properties": { $props }, "required": [ $required ] }"""
}

private fun enumOf(vararg values: String): String =
    """{ "type": "string", "enum": [ ${values.joinToString { "\"$it\"" }} ] }"""

private fun param(name: String, schema: String): String = """{ "name": "$name", "required": true, "schema": $schema }"""

/** `api.<name>` taking [params] and returning [result] (named `<name>Result`, as the spec generator names it). */
private fun method(name: String, result: String, vararg params: String): String =
    """{ "name": "api.$name", "params": [ ${params.joinToString()} ], "result": { "name": "${name}Result", "schema": $result } }"""

private fun api(vararg methods: String): String {
    val spec = """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [ ${methods.joinToString(",\n")} ],
      "components": { "schemas": {} }
    }
    """.trimIndent()
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app").generate(model).files.single { it.name == "Api" }.toString()
}

/** Number of occurrences of [needle]. */
private fun String.count(needle: String): Int = windowed(needle.length).count { it == needle }

/**
 * An operation's nested types live in one object (`Api.Check`), named after the parameter or
 * property that declares them, and the inline result is `Result`. Nothing checked a name against
 * its siblings, so a parameter named `result` declared a second `Result` next to the result's
 * ("Conflicting declarations"), and so did two properties whose names differ only in their
 * separators (`user_name`, `userName`). Names are now allocated per scope (the operation's
 * root, an inline object, a union variant): the first declaration keeps its name (the result,
 * which is collected first, keeps `Result`), and a later sibling with the same name gets `_2`,
 * `_3`, ..., as Swift does. A name that didn't collide is unchanged.
 */
class NestedTypeNameCollisionTest : FunSpec({

    test("a parameter named result gets Result_2, and the inline result keeps Result") {
        val source = api(method("check", obj("passed" to """{ "type": "boolean" }"""), param("result", obj("input" to STRING))))
        source shouldContain "public suspend fun check(result: Check.Result_2): Check.Result {"
        source.count("public data class Result(") shouldBe 1
        source shouldContain "public data class Result(\n      public val passed: Boolean,\n    )"
        source shouldContain "public data class Result_2(\n      public val input: String,\n    )"
    }

    test("a parameter named result keeps Result when the result declares no type") {
        val source = api(method("check", STRING, param("result", obj("input" to STRING))))
        source shouldContain "public suspend fun check(result: Check.Result): String {"
        source shouldNotContain "Result_2"
    }

    test("an enum or union parameter named result is renamed too") {
        val union = """{ "oneOf": [ ${obj("kind" to enumOf("a"), "x" to STRING)}, ${obj("kind" to enumOf("b"), "y" to NUMBER)} ] }"""
        val source = api(
            method("pick", obj("ok" to STRING), param("result", enumOf("yes", "no"))),
            method("route", obj("ok" to STRING), param("result", union)),
        )
        source shouldContain "public suspend fun pick(result: Pick.Result_2): Pick.Result {"
        source shouldContain "public enum class Result_2 {"
        source shouldContain "public suspend fun route(result: Route.Result_2): Route.Result {"
        source shouldContain "public sealed class Result_2 {"
    }

    test("the suffix skips a name a sibling already took") {
        val source = api(
            method(
                "check",
                obj("passed" to STRING),
                param("result", obj("a" to STRING)),
                param("Result", obj("b" to STRING)),
            ),
        )
        source shouldContain "public suspend fun check(result: Check.Result_2, Result: Check.Result_3): Check.Result {"
    }

    test("properties whose names differ only in separators get distinct nested types") {
        val result = obj("user_name" to obj("first" to STRING), "userName" to obj("last" to STRING))
        val source = api(method("whoami", result))
        source shouldContain "public val user_name: Result.UserName,"
        source shouldContain "public val userName: Result.UserName_2,"
        source shouldContain "public data class UserName(\n        public val first: String,\n      )"
        source shouldContain "public data class UserName_2(\n        public val last: String,\n      )"
    }

    test("names that don't collide are unchanged, including the same name in different scopes") {
        val source = api(
            method(
                "putItems",
                obj("item" to obj("count" to NUMBER), "items" to """{ "type": "array", "items": ${obj("sku" to STRING)} }"""),
                param("item", obj("sku" to STRING)),
                param("items", """{ "type": "array", "items": ${obj("qty" to NUMBER)} }"""),
            ),
        )
        source shouldContain "public suspend fun putItems(item: PutItems.Item, items: List<PutItems.Items>): PutItems.Result {"
        source shouldContain "public val item: Result.Item,"
        source shouldContain "public val items: List<Result.Items>,"
        source shouldNotContain "_2"
    }
})
