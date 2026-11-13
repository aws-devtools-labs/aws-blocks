package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

private fun obj(field: String, type: String) =
    """{ "type": "object", "properties": { "$field": { "type": "$type" } }, "required": [ "$field" ] }"""

private fun method(name: String, resultName: String?, schema: String): String {
    val named = resultName?.let { "\"name\": \"$it\", " } ?: ""
    return """{ "name": "$name", "params": [], "result": { $named"schema": $schema } }"""
}

private fun generate(vararg methods: String): Map<String, String> {
    val spec = """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [ ${methods.joinToString(",\n")} ],
      "components": { "schemas": {} }
    }
    """.trimIndent()
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app").generate(model).files.associate { it.name to it.toString() }
}

/**
 * An inline result named by the spec (`"result": { "name": "Same", … }`) was registered as
 * `explicit:Same`, not per method, so a second method whose result has the same `name` reused the
 * first one's registration: its own `Result` was never declared, and its signature named a
 * top-level `Result` that doesn't exist (it resolved to `kotlin.Result<T>`: "One type argument
 * expected"). A result without a `name` is named `result` by the parser, so every such method
 * shared one too. The spec generator names results `<Namespace><Method>Result`, so real specs
 * didn't meet it. The registration is now per method (`explicit:<method>:<name>`).
 */
class ExplicitResultNameTest : FunSpec({

    test("two methods whose results have the same name each declare their own Result") {
        val source = generate(
            method("api.one", "Same", obj("a", "string")),
            method("api.two", "Same", obj("b", "number")),
        ).getValue("Api")
        source shouldContain "public suspend fun one(): One.Result {"
        source shouldContain "public suspend fun two(): Two.Result {"
        source shouldContain "public object One {\n    @Serializable\n    public data class Result(\n      public val a: String,\n    )"
        source shouldContain "public object Two {\n    @Serializable\n    public data class Result(\n      public val b: Double,\n    )"
    }

    test("methods of different namespaces whose results have the same name each declare their own") {
        val files = generate(
            method("api.one", "Same", obj("a", "string")),
            method("other.three", "Same", obj("c", "string")),
        )
        files.getValue("Other") shouldContain "public suspend fun three(): Three.Result {"
        files.getValue("Other") shouldContain "public val c: String,"
    }

    test("results without a name each declare their own Result") {
        val source = generate(
            method("api.four", null, obj("d", "string")),
            method("api.five", null, obj("e", "string")),
        ).getValue("Api")
        source shouldContain "public suspend fun four(): Four.Result {"
        source shouldContain "public suspend fun five(): Five.Result {"
        source shouldContain "public val e: String,"
    }

    test("a named result that no other method shares is unchanged") {
        val source = generate(method("api.one", "OneResult", obj("a", "string"))).getValue("Api")
        source shouldContain "public suspend fun one(): One.Result {"
        source shouldNotContain "Result_2"
    }
})
