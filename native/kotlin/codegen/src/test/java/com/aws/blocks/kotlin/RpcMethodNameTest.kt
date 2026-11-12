package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.GeneratorResult
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

private const val STRING = """{ "type": "string" }"""

private fun method(name: String, vararg params: String, result: String = STRING): String =
    """{ "name": "$name", "params": [ ${params.joinToString()} ], "result": { "name": "R", "schema": $result } }"""

private fun param(name: String): String = """{ "name": "$name", "required": true, "schema": $STRING }"""

private fun generate(vararg methods: String): GeneratorResult {
    val spec = """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [ ${methods.joinToString(",\n")} ]
    }
    """.trimIndent()
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app").generate(model)
}

private fun sources(vararg methods: String): String =
    generate(*methods).files.joinToString("\n") { it.toString() }

/** Every `method = "…"` a generated request sends, in order. */
private fun sentMethods(source: String): List<String> =
    Regex("""BlocksRequest\(method = "([^"]*)"""").findAll(source).map { it.groupValues[1] }.toList()

/**
 * The JSON-RPC `method` a generated call sends is the spec's method name, exactly. A method with
 * no dot (`ping`, from a hand-written spec: the spec generator always writes
 * `<export>.<method>`) is grouped under `_default` for its Kotlin class, and the body joined the
 * namespace back on, so it sent `"_default.ping"`: a name the spec doesn't have, which the
 * server reads as the method `ping` of an export named `_default` (`parseRpcRequest` splits at
 * the first dot). Swift and Dart send `"ping"`. The server has no top-level method
 * (`parseRpcRequest` answers a name without a dot with `InvalidRequest`), so the call fails
 * either way against an AWS Blocks backend; but `"_default.ping"` would run another method of a
 * backend that exports `_default`, and a spec's method is the only name a client may send.
 */
class RpcMethodNameTest : FunSpec({

    test("a method with no dot sends its spec name") {
        val source = sources(method("ping"))
        sentMethods(source) shouldContainExactly listOf("ping")
        source shouldNotContain "_default"
    }

    test("a method with no dot and parameters sends its spec name") {
        sentMethods(sources(method("echo", param("text")))) shouldContainExactly listOf("echo")
    }

    test("a dotless method and a method of a namespace named _default each send their own name") {
        val source = sources(method("ping"), method("_default.pong"))
        sentMethods(source) shouldContainExactly listOf("ping", "_default.pong")
    }

    test("an unbound transferable warning names the spec method") {
        val unbound = """{ "x-blocks-transferable": "custom/thing" }"""
        val warnings = generate(method("watch", result = unbound)).warnings
        warnings.single() shouldContain "AWSBLOCKS-NATIVE-001: watch returns unbound transferable"
    }

    test("dotted methods are unchanged") {
        val source = sources(method("api.get"), method("a.b.ping"), method("todos.list", param("q")))
        sentMethods(source) shouldContainExactly listOf("api.get", "a.b.ping", "todos.list")
        sentMethods(source).size shouldBe 3
    }
})
