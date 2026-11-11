package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.builder.IdentifierCollisionException
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContain as shouldContainElement
import io.kotest.matchers.collections.shouldNotContain as shouldNotContainElement
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import java.io.File

private fun generate(spec: String): String =
    KotlinCodeGenerator("com.example.app")
        .generate(CodegenModelBuilder().build(OpenRpcParser.parse(spec)))
        .files.joinToString("\n") { it.toString() }

/**
 * The generated source with every string literal and comment removed, which leaves only the
 * code a spec name could have reached as an identifier.
 */
private fun codeOnly(source: String): String {
    val out = StringBuilder()
    var i = 0
    while (i < source.length) {
        when {
            source.startsWith("/*", i) -> i = source.indexOf("*/", i + 2).let { if (it < 0) source.length else it + 2 }
            source.startsWith("//", i) -> i = source.indexOf('\n', i).let { if (it < 0) source.length else it }
            source[i] == '"' -> {
                i++
                while (i < source.length && source[i] != '"') {
                    // `${'$'}` is how a literal holds a dollar sign; its quotes are not the literal's.
                    if (source.startsWith("\${'\$'}", i)) i += 6
                    else if (source[i] == '\\') i += 2
                    else i++
                }
                i++
                out.append("\"\"")
            }
            else -> out.append(source[i++])
        }
    }
    return out.toString()
}

private fun recordSpec(vararg fields: String): String {
    val properties = fields.joinToString(", ") { "\"$it\": { \"type\": \"string\" }" }
    return """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [
        {
          "name": "api.get",
          "params": [],
          "result": { "name": "GetResult", "schema": { "type": "object", "properties": { $properties } } }
        }
      ]
    }
    """.trimIndent()
}

private fun unionSpec(vararg discriminatorValues: String): String {
    val members = discriminatorValues.joinToString(", ") { value ->
        """{ "type": "object", "properties": { "kind": { "type": "string", "enum": ["$value"] } }, "required": ["kind"] }"""
    }
    return """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [
        {
          "name": "api.put",
          "params": [{ "name": "input", "required": true, "schema": { "oneOf": [ $members ] } }],
          "result": { "name": "PutResult", "schema": { "type": "boolean" } }
        }
      ]
    }
    """.trimIndent()
}

private fun namespacesSpec(vararg namespaces: String): String {
    val methods = namespaces.joinToString(", ") { ns ->
        """{ "name": "$ns.run", "params": [], "result": { "name": "RunResult", "schema": { "type": "boolean" } } }"""
    }
    return """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [ $methods ]
    }
    """.trimIndent()
}

private fun generateResult(spec: String) =
    KotlinCodeGenerator("com.example.app").generate(CodegenModelBuilder().build(OpenRpcParser.parse(spec)))

/** Names the spec supplies reach generated code only as sanitized identifiers or escaped literals. */
class NonIdentifierNamesTest : FunSpec({

    val fixtureSpec = File(System.getProperty("FIXTURES_DIR"), "29-non-identifier-names/spec.json").readText()

    test("the non-identifier-names fixture generates") {
        val source = generate(fixtureSpec)

        source shouldContain "public val run___error__x________id: String"
        source shouldContain "require(run___error__x________id.length >= 2)"
        source shouldContain "JsonPrimitive(run___error__xParam________p)"
        // A validation message names the field's key as the spec spells it.
        source shouldContain "{ \"run { error(\\\"x\\\") } || id must be at least 2 characters\" }"
        source shouldContain "{ \"with space must be >= 1\" }"
    }

    test("no spec text survives outside a string literal or comment") {
        val code = codeOnly(generate(fixtureSpec))

        for (fragment in listOf("error(", "{ error", "`", "\${", "\\(", "*/", "'", ";", "||", " sp ace", "with space")) {
            code shouldNotContain fragment
        }
    }

    test("each original key is kept as an escaped serial name") {
        val source = generate(fixtureSpec)

        source shouldContain "@SerialName(\"run { error(\\\"x\\\") } || id\")"
        source shouldContain "@SerialName(\"new\\nline\")"
        source shouldContain "@SerialName(\"back`tick\")"
        source shouldContain "@SerialName(\"\${'\$'}{x}\")"
        source shouldContain "@SerialName(\"9lives\")"
        source shouldContain "@JsonClassDiscriminator(\"ty pe\")"
        source shouldContain "method = \"api.get\\\"Sample`;x\""
        source shouldContain "method = \"ns.do`Action\""
    }

    test("a namespace that is not an identifier keeps its spelling on the wire") {
        val spec = """
        {
          "openrpc": "1.3.2",
          "info": { "title": "test", "version": "1.0.0" },
          "methods": [
            { "name": "my ns${'$'}x;.run", "params": [], "result": { "name": "RunResult", "schema": { "type": "boolean" } } }
          ]
        }
        """.trimIndent()
        val source = generate(spec)

        source shouldContain "public class MyNsX("
        source shouldContain "method = \"my ns\${'\$'}x;.run\""
        codeOnly(source) shouldNotContain ";"
    }

    test("an identifier the spec already spells is left alone") {
        val source = generate(recordSpec("id", "class", "_private", "camelCase"))

        source shouldContain "public val id: String?"
        source shouldContain "public val `class`: String?"
        source shouldContain "public val _private: String?"
        source shouldContain "public val camelCase: String?"
        // Only the keyword needs its key named.
        Regex("@SerialName").findAll(source).count() shouldBe 1
    }

    test("two fields that reduce to one identifier fail generation") {
        val error = shouldThrow<IdentifierCollisionException> { generate(recordSpec("a-b", "a_b")) }

        error.message shouldContain "'a-b'"
        error.message shouldContain "'a_b'"
        error.message shouldContain "'a_b'. Rename one in the spec."
    }

    test("two parameters that reduce to one identifier fail generation") {
        val spec = """
        {
          "openrpc": "1.3.2",
          "info": { "title": "test", "version": "1.0.0" },
          "methods": [
            {
              "name": "api.put",
              "params": [
                { "name": "a b", "required": true, "schema": { "type": "string" } },
                { "name": "a;b", "required": true, "schema": { "type": "string" } }
              ],
              "result": { "name": "PutResult", "schema": { "type": "boolean" } }
            }
          ]
        }
        """.trimIndent()

        val error = shouldThrow<IdentifierCollisionException> { generate(spec) }

        error.message shouldContain "parameters"
        error.message shouldContain "'a_b'"
    }

    test("two operations that reduce to one identifier fail generation") {
        val spec = """
        {
          "openrpc": "1.3.2",
          "info": { "title": "test", "version": "1.0.0" },
          "methods": [
            { "name": "api.get-x", "params": [], "result": { "name": "R1", "schema": { "type": "boolean" } } },
            { "name": "api.get;x", "params": [], "result": { "name": "R2", "schema": { "type": "boolean" } } }
          ]
        }
        """.trimIndent()

        shouldThrow<IdentifierCollisionException> { generate(spec) }.message shouldContain "operations"
    }

    test("two operations whose types nest in one object fail generation") {
        val inlineResult = "{ \"type\": \"object\", \"properties\": { \"a\": { \"type\": \"string\" } } }"
        val spec = """
        {
          "openrpc": "1.3.2",
          "info": { "title": "test", "version": "1.0.0" },
          "methods": [
            { "name": "api.get-x", "params": [], "result": { "name": "R1", "schema": $inlineResult } },
            { "name": "api.getX", "params": [], "result": { "name": "R2", "schema": $inlineResult } }
          ]
        }
        """.trimIndent()

        val error = shouldThrow<IdentifierCollisionException> { generate(spec) }

        error.message shouldContain "'get-x'"
        error.message shouldContain "'getX'"
        error.message shouldContain "'GetX'"
    }

    test("two servers that reduce to one identifier fail generation") {
        val spec = """
        {
          "openrpc": "1.3.2",
          "info": { "title": "test", "version": "1.0.0" },
          "servers": [
            { "name": "my-server", "url": "https://a.example.com" },
            { "name": "my_server", "url": "https://b.example.com" }
          ],
          "methods": [
            { "name": "api.run", "params": [], "result": { "name": "RunResult", "schema": { "type": "boolean" } } }
          ]
        }
        """.trimIndent()

        val error = shouldThrow<IdentifierCollisionException> { generate(spec) }

        error.message shouldContain "servers"
        error.message shouldContain "'my-server'"
    }
    test("two discriminator values that name one union variant fail generation") {
        for ((first, second, identifier) in listOf(Triple("a-b", "a_b", "AB"), Triple("Foo", "foo", "Foo"))) {
            val error = shouldThrow<IdentifierCollisionException> { generate(unionSpec(first, second)) }

            error.message shouldContain "union variants"
            error.message shouldContain "'$first'"
            error.message shouldContain "'$second'"
            error.message shouldContain "'$identifier'. Rename one in the spec."
        }
    }

    test("the reserved-file warning names the namespace as the spec spells it") {
        val warnings = generateResult(namespacesSpec("types${'$'}")).warnings

        warnings.single() shouldContain "The \"types${'$'}\" namespace would be generated as Types.kt"
    }

    test("a namespace matching a reserved file name in another case is suffixed") {
        for ((namespace, className) in listOf("seRvers" to "SeRversApi", "tYPES" to "TYPESApi")) {
            val result = generateResult(namespacesSpec(namespace))

            val fileNames = result.files.map { it.name }
            fileNames shouldContainElement className
            fileNames shouldNotContainElement className.removeSuffix("Api")
            result.warnings.single() shouldContain "The \"$namespace\" namespace"
        }
    }

    test("two namespaces whose files differ only in case fail generation") {
        val error = shouldThrow<IllegalStateException> { generate(namespacesSpec("foo", "fOO")) }

        error.message shouldContain "\"foo\""
        error.message shouldContain "\"fOO\""
    }

    test("the namespace collision error names the namespaces as the spec spells them") {
        val error = shouldThrow<IllegalStateException> { generate(namespacesSpec("types", "types;Api")) }

        error.message shouldContain "\"types\""
        error.message shouldContain "\"types;Api\""
        error.message shouldContain "TypesApi"
    }
})
