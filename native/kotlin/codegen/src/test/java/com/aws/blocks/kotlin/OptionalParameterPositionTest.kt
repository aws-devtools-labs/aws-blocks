package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

private const val STRING = """{ "type": "string" }"""

private fun param(name: String, required: Boolean, schema: String = STRING): String =
    """{ "name": "$name", "required": $required, "schema": $schema }"""

private fun req(name: String, schema: String = STRING) = param(name, required = true, schema = schema)
private fun opt(name: String, schema: String = STRING) = param(name, required = false, schema = schema)

/** The `Api` file generated for one method `api.send` with [params]. */
private fun api(vararg params: String): String {
    val spec = """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [ { "name": "api.send", "params": [ ${params.joinToString()} ], "result": { "name": "R", "schema": $STRING } } ]
    }
    """.trimIndent()
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app").generate(model).files.single { it.name == "Api" }.toString()
}

/**
 * JSON-RPC params are positional here: the server calls the method with `params` as its
 * argument list (`parseRpcRequest` passes an array as is, and an object's `Object.values()`, so
 * by-name params are positional too). The TypeScript client sends its arguments array, so an
 * argument left out before a later one is `null` in its slot (`api.send('a', undefined, 'c')`
 * sends `["a",null,"c"]`) and a trailing one is left off. Kotlin added each optional argument
 * that wasn't null to the end of the list, after every required one: leaving out `b` of
 * `send(a, b?, c?)` sent `["a","c"]`, which the server reads as `b = "c"`; and a required
 * parameter after an optional one was sent before it (`send(a?, b)` sent `[b, a]`).
 *
 * Every argument now keeps its slot. An optional parameter before a required one is sent as JSON
 * `null` when it is null. A trailing optional one is sent when it or a later one is set, as
 * `null` if it isn't; trailing ones that are all null are left off, as before. A method whose
 * only optional parameter is its last is unchanged.
 */
class OptionalParameterPositionTest : FunSpec({

    test("a left-out middle optional parameter is sent as null when a later one is set") {
        val source = api(req("a"), opt("b"), opt("c"))
        source shouldContain "val args = mutableListOf<JsonElement>(JsonPrimitive(a))\n"
        source shouldContain "    if (b != null || c != null) {\n      args.add(if (b != null) JsonPrimitive(b) else JsonNull)\n    }\n"
        source shouldContain "    if (c != null) {\n      args.add(JsonPrimitive(c))\n    }\n"
        source shouldContain "import kotlinx.serialization.json.JsonNull\n"
    }

    test("each trailing optional parameter is sent when it or a later one is set") {
        val source = api(opt("a"), opt("b"), opt("c"))
        source shouldContain "val args = mutableListOf<JsonElement>()\n"
        source shouldContain "    if (a != null || b != null || c != null) {\n      args.add(if (a != null) JsonPrimitive(a) else JsonNull)\n    }\n"
        source shouldContain "    if (b != null || c != null) {\n      args.add(if (b != null) JsonPrimitive(b) else JsonNull)\n    }\n"
        source shouldContain "    if (c != null) {\n      args.add(JsonPrimitive(c))\n    }\n"
    }

    test("an optional parameter before a required one keeps its slot, as null") {
        val source = api(req("a"), opt("b"), req("c"))
        source shouldContain
            "params = listOf(JsonPrimitive(a), if (b != null) JsonPrimitive(b) else JsonNull, JsonPrimitive(c))"
        source shouldNotContain "else listOf("
    }

    test("required parameters after optional ones stay in spec order") {
        val source = api(opt("a"), opt("b"), req("c"))
        source shouldContain
            "params = listOf(if (a != null) JsonPrimitive(a) else JsonNull, if (b != null) JsonPrimitive(b) else JsonNull, JsonPrimitive(c))"
    }

    test("a leading optional slot and trailing optional ones together") {
        val source = api(opt("a"), req("b"), opt("c"), opt("d"))
        source shouldContain
            "val args = mutableListOf<JsonElement>(if (a != null) JsonPrimitive(a) else JsonNull, JsonPrimitive(b))\n"
        source shouldContain "    if (c != null || d != null) {\n      args.add(if (c != null) JsonPrimitive(c) else JsonNull)\n    }\n"
        source shouldContain "    if (d != null) {\n      args.add(JsonPrimitive(d))\n    }\n"
    }

    test("a model or keyword-named optional parameter in the middle is encoded inside its guard") {
        val model = """{ "type": "object", "properties": { "x": $STRING }, "required": ["x"] }"""
        val source = api(req("a"), opt("class", model), opt("c"))
        source shouldContain
            "args.add(if (`class` != null) BlocksJson.encodeToJsonElement(`class`) else JsonNull)"
        source shouldContain "if (`class` != null || c != null) {"
    }

    test("a single trailing optional parameter is unchanged") {
        val source = api(req("a"), opt("b"))
        source shouldContain
            "val args: List<JsonElement> = if (b != null) listOf(JsonPrimitive(a), JsonPrimitive(b)) else listOf(JsonPrimitive(a))"
        source shouldNotContain "JsonNull"
    }

    test("a single optional parameter is unchanged") {
        val source = api(opt("a"))
        source shouldContain "val args: List<JsonElement> = if (a != null) listOf(JsonPrimitive(a)) else listOf()"
        source shouldNotContain "JsonNull"
    }
})
