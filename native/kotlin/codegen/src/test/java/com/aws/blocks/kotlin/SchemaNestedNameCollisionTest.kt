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

private fun ref(name: String) = """{ "${'$'}ref": "#/components/schemas/$name" }"""

/** Every file the generator writes for [schemas] (one method per schema, returning it), joined. */
private fun generate(vararg schemas: Pair<String, String>, extraMethods: List<String> = emptyList()): String {
    val methods = schemas.map { (name, _) ->
        """{ "name": "api.get$name", "params": [], "result": { "name": "Get${name}Result", "schema": ${ref(name)} } }"""
    } + extraMethods
    val spec = """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [ ${methods.joinToString(",\n")} ],
      "components": { "schemas": { ${schemas.joinToString(", ") { (name, schema) -> "\"$name\": $schema" }} } }
    }
    """.trimIndent()
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app").generate(model).files.joinToString("\n") { it.toString() }
}

/** Number of occurrences of [needle]. */
private fun String.count(needle: String): Int = windowed(needle.length).count { it == needle }

/**
 * A component schema's nested types were keyed by their PascalCase path (`Holder.UserName`), so
 * `Holder.user_name` and `Holder.userName` (both inline objects) registered one type: the second
 * property silently got the first one's (`userName: UserName` with `first`, not `last`), and its
 * own type was never declared. Two kinds with one name (an enum `kind` beside an object `KIND`)
 * declared two `Kind`s ("Conflicting declarations"), and so did a nested type named like a
 * property of its class (a property `Meta` holding an inline object: Kotlin rejects a property and
 * a nested class of one name). FX29 fixed this for an operation's types
 * (`allocateNestedName`, R71); a schema's are now allocated per scope the same way: they are keyed
 * by the property's spec name, the first keeps its name, and a later sibling gets `_2`, `_3`, ….
 * The same schema reached through several `$ref`s still registers its nested types once, and the
 * wire name of each property is unchanged.
 *
 * Union variants and enum constants are camel-cased too, so they are allocated per union and per
 * enum: discriminator values `in-progress` and `in_progress` were two `InProgress` subclasses, and
 * enum values with those spellings two `InProgress` constants. The `@SerialName` keeps each one's
 * wire value.
 */
class SchemaNestedNameCollisionTest : FunSpec({

    test("schema properties whose names differ only in separators get distinct nested types") {
        val source = generate("Holder" to obj("user_name" to obj("first" to STRING), "userName" to obj("last" to STRING)))
        source shouldContain "public val user_name: UserName,"
        source shouldContain "public val userName: UserName_2,"
        source shouldContain "public data class UserName(\n    public val first: String,\n  )"
        source shouldContain "public data class UserName_2(\n    public val last: String,\n  )"
    }

    test("an enum and an object of one name in a schema get distinct names") {
        val source = generate("Holder" to obj("kind" to enumOf("a", "b"), "KIND" to obj("k" to STRING)))
        source shouldContain "public val kind: Kind,"
        source shouldContain "public val KIND: Kind_2,"
        source shouldContain "public enum class Kind {"
        source shouldContain "public data class Kind_2("
    }

    test("a nested type never takes the name of a property of its class") {
        val source = generate("Holder" to obj("Meta" to obj("x" to STRING), "kind" to enumOf("a"), "Kind" to STRING))
        source shouldContain "public val Meta: Meta_2,"
        source shouldContain "public data class Meta_2("
        source shouldContain "public val kind: Kind_2,"
        source shouldContain "public val Kind: String,"
        source shouldContain "public enum class Kind_2 {"
    }

    test("a deeper scope is allocated on its own, and a renamed type's children nest under it") {
        val source = generate(
            "Holder" to obj(
                "deep" to obj(
                    "a_b" to obj("x" to STRING),
                    "aB" to obj("inner" to obj("y" to NUMBER)),
                ),
            ),
        )
        source shouldContain "public val a_b: AB,"
        source shouldContain "public val aB: AB_2,"
        source shouldContain "public data class AB_2(\n      public val `inner`: Inner,\n    ) {"
        source shouldContain "public data class Inner(\n        public val y: Double,\n      )"
    }

    test("a schema reached through several refs declares its nested types once") {
        val holder = obj("user_name" to obj("first" to STRING), "userName" to obj("last" to STRING))
        val again = """{ "name": "api.again", "params": [ { "name": "h", "required": true, "schema": ${ref("Holder")} } ], "result": { "name": "AgainResult", "schema": ${ref("Holder")} } }"""
        val source = generate("Holder" to holder, extraMethods = listOf(again))
        source.count("public data class UserName(") shouldBe 1
        source.count("public data class UserName_2(") shouldBe 1
        source shouldNotContain "UserName_3"
    }

    test("discriminator values that camel-case alike get distinct variants") {
        val union = """{ "oneOf": [ ${obj("kind" to enumOf("in-progress"), "a" to STRING)}, ${obj("kind" to enumOf("in_progress"), "b" to STRING)} ] }"""
        val source = generate("Task" to obj("state" to union))
        source shouldContain "@SerialName(\"in-progress\")\n    public data class InProgress("
        source shouldContain "@SerialName(\"in_progress\")\n    public data class InProgress_2("
    }

    test("enum values that camel-case alike get distinct constants") {
        val source = generate("Task" to obj("state" to enumOf("in-progress", "in_progress", "done")))
        source shouldContain "@SerialName(\"in-progress\")\n    InProgress,"
        source shouldContain "@SerialName(\"in_progress\")\n    InProgress_2,"
        source shouldContain "@SerialName(\"done\")\n    Done,"
    }

    test("schema names that collide with nothing are unchanged") {
        val source = generate(
            "Holder" to obj("payload" to obj("meta" to obj("x" to STRING)), "kind" to enumOf("a")),
            "Envelope" to obj("payload" to obj("y" to STRING)),
        )
        source shouldContain "public val payload: Payload,"
        source shouldContain "public val meta: Meta,"
        source shouldContain "public val kind: Kind,"
        source shouldNotContain "_2"
    }
})
