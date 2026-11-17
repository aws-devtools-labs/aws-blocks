package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

/** A method whose one parameter is a string enum of [values]. */
private fun enumParamSpec(vararg values: String): String {
    val literals = values.joinToString(", ") {
        val escaped = it.replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
        "\"$escaped\""
    }
    return """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [
        {
          "name": "api.pick",
          "params": [ { "name": "choice", "schema": { "type": "string", "enum": [$literals] } } ],
          "result": { "name": "PickResult", "schema": { "type": "boolean" } }
        }
      ]
    }
    """.trimIndent()
}

private fun generate(spec: String): String =
    KotlinCodeGenerator("com.example.app")
        .generate(CodegenModelBuilder().build(OpenRpcParser.parse(spec)))
        .files.joinToString("\n") { it.toString() }

/**
 * Enum constant naming for values no identifier can hold. Each of these previously failed code
 * generation inside KotlinPoet, naming its own internals rather than the value responsible.
 */
class EnumConstantNamingTest : FunSpec({

    test("a value an identifier can't hold even backticked is rebuilt from its segments") {
        val source = generate(enumParamSpec("v1.0", "v2.0"))

        source shouldContain "@SerialName(\"v1.0\")"
        source shouldContain "V10"
        source shouldContain "@SerialName(\"v2.0\")"
        source shouldContain "V20"
    }

    test("every character an identifier can't hold separates segments") {
        val source = generate(enumParamSpec("a.b", "c;d", "e[f", "g]h", "i/j", "k<l", "m>n", "o:p", "q\\r"))

        for (name in listOf("AB", "CD", "EF", "GH", "IJ", "KL", "MN", "OP", "QR")) {
            source shouldContain name
        }
    }

    test("a value that leaves no segments is named rather than dropped") {
        val source = generate(enumParamSpec("...", "-"))

        source shouldContain "Unnamed"
        // The second value leaves no segments either, so it takes a numbered name.
        source shouldContain "Unnamed2"
    }

    test("a value an identifier can only appear to hold is rebuilt too") {
        // KotlinPoet escapes these rather than refusing them, and the escape doesn't compile: a
        // backtick closes the quoting early and a line break ends the name.
        val source = generate(enumParamSpec("ab`", "c\nd", "e\rf", "`g`"))

        source shouldContain "Ab"
        source shouldContain "@SerialName(\"ab`\")"
        source shouldContain "CD"
        source shouldContain "@SerialName(\"c\\nd\")"
        source shouldContain "EF"
        // A carriage return has to survive as itself: %S would emit it as a line feed.
        source shouldContain "@SerialName(\"e\\rf\")"
        // A value the spec already wrote in backticks keeps them as its serial name, not its name.
        source shouldContain "G"
        source shouldContain "@SerialName(\"`g`\")"
        source shouldNotContain "`Ab`"
    }

    test("a value DEX can't hold is rebuilt, even though Kotlin could") {
        // d8 rejects these: "Field name 'C#' cannot be represented in dex format". Kotlin itself
        // compiles the backticked form, so only an Android build catches it.
        val source = generate(enumParamSpec("c#", "a+b", "sign in", "e\u00a0f"))

        source shouldContain "C"
        source shouldContain "@SerialName(\"c#\")"
        source shouldContain "AB"
        source shouldContain "SignIn"
        source shouldContain "EF"
        source shouldNotContain "`"
    }

    test("a value keeps the name the spec wrote when an identifier can hold it") {
        val source = generate(enumParamSpec("pending", "cost\$", "my-sso", "2fa", "é"))

        source shouldContain "Pending"
        source shouldContain "`Cost\$`"
        source shouldContain "MySso"
        source shouldContain "`2fa`"
        source shouldContain "é"
    }

    test("two values that reduce to one name are numbered apart") {
        val source = generate(enumParamSpec("my-sso", "my.sso"))

        source shouldContain "MySso"
        source shouldContain "MySso2"
        source shouldContain "@SerialName(\"my.sso\")"
    }

    test("a repeated value is emitted once") {
        val source = generate(enumParamSpec("pending", "pending"))

        // Two constants of one name don't compile, so the repeat is dropped.
        Regex("\\bPending\\b").findAll(source).count() shouldBe 1
    }
})
