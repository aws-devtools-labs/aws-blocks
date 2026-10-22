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

private fun obj(vararg properties: Pair<String, String>, description: String? = null): String {
    val props = properties.joinToString(", ") { (name, schema) -> "\"$name\": $schema" }
    val required = properties.joinToString(", ") { "\"${it.first}\"" }
    val doc = description?.let { """"description": "$it", """ }.orEmpty()
    return """{ $doc"type": "object", "properties": { $props }, "required": [ $required ] }"""
}

private fun enumOf(vararg values: String): String =
    """{ "type": "string", "enum": [ ${values.joinToString { "\"$it\"" }} ] }"""

/** A union arm discriminated by `type`. */
private fun arm(type: String, vararg properties: Pair<String, String>): String =
    obj("type" to enumOf(type), *properties)

private fun oneOf(vararg arms: String): String = """{ "oneOf": [ ${arms.joinToString()} ] }"""

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
 * The types a component schema's union variants declare are collected into the schema's scope
 * (`Holder.Payload`, beside `Holder.Event`) and keyed by the property's spec name, so two
 * variants whose `payload` properties are inline objects of different shapes registered one type:
 * every variant decoded its payload with the first variant's fields (`B.payload` with `x`, not
 * `y`), and the second shape was never declared. FX42 left it (R80 (d)): keying a variant's
 * types per variant would rename the ones that are shared today and match (`NextStep` in the
 * auth fixtures).
 *
 * A same-named type is now shared only when it has the same shape (the same `TypeRef`, ignoring
 * descriptions): a variant whose type differs gets its own, allocated in the schema's scope as
 * FX29 and FX42 do (`Payload_2`, `_3`, …). Types that match keep the one name they have today,
 * and the same schema reached through several `$ref`s still declares its types once.
 */
class SchemaUnionVariantTypeTest : FunSpec({

    test("variants whose same-named payloads differ in shape get distinct types") {
        val source = generate(
            "Holder" to obj("event" to oneOf(arm("a", "payload" to obj("x" to STRING)), arm("b", "payload" to obj("y" to NUMBER)))),
        )
        source shouldContain "public data class A(\n      public val payload: Payload,\n    ) : Event()"
        source shouldContain "public data class B(\n      public val payload: Payload_2,\n    ) : Event()"
        source shouldContain "public data class Payload(\n    public val x: String,\n  )"
        source shouldContain "public data class Payload_2(\n    public val y: Double,\n  )"
    }

    test("a third shape gets the next name, and a repeat of an earlier one shares it") {
        val source = generate(
            "Holder" to obj(
                "event" to oneOf(
                    arm("a", "payload" to obj("x" to STRING)),
                    arm("b", "payload" to obj("y" to NUMBER)),
                    arm("c", "payload" to obj("z" to STRING)),
                    arm("d", "payload" to obj("y" to NUMBER)),
                ),
            ),
        )
        source shouldContain "public data class C(\n      public val payload: Payload_3,\n    ) : Event()"
        source shouldContain "public data class D(\n      public val payload: Payload_2,\n    ) : Event()"
        source.count("public data class Payload_2(") shouldBe 1
        source shouldNotContain "Payload_4"
    }

    test("variants whose same-named enums differ get distinct enums") {
        val source = generate(
            "Holder" to obj("event" to oneOf(arm("a", "status" to enumOf("on", "off")), arm("b", "status" to enumOf("up", "down")))),
        )
        source shouldContain "public data class A(\n      public val status: Status,\n    ) : Event()"
        source shouldContain "public data class B(\n      public val status: Status_2,\n    ) : Event()"
        source shouldContain "public enum class Status_2 {"
    }

    test("a differing payload's own nested types nest under its renamed type") {
        val source = generate(
            "Holder" to obj(
                "event" to oneOf(
                    arm("a", "payload" to obj("meta" to obj("x" to STRING))),
                    arm("b", "payload" to obj("meta" to obj("y" to NUMBER))),
                ),
            ),
        )
        source shouldContain "public data class Payload_2(\n    public val meta: Meta,\n  ) {"
        source shouldContain "public data class Meta(\n      public val y: Double,\n    )"
        source shouldContain "public data class Payload(\n    public val meta: Meta,\n  ) {"
        source shouldContain "public data class Meta(\n      public val x: String,\n    )"
    }

    test("variants whose same-named payloads match share one type") {
        val source = generate(
            "Holder" to obj("event" to oneOf(arm("a", "payload" to obj("x" to STRING)), arm("b", "payload" to obj("x" to STRING)))),
        )
        source shouldContain "public data class B(\n      public val payload: Payload,\n    ) : Event()"
        source.count("public data class Payload(") shouldBe 1
        source shouldNotContain "_2"
    }

    test("payloads that differ only in their descriptions share one type") {
        val source = generate(
            "Holder" to obj(
                "event" to oneOf(
                    arm("a", "payload" to obj("x" to STRING, description = "first")),
                    arm("b", "payload" to obj("x" to STRING, description = "second")),
                ),
            ),
        )
        source shouldNotContain "_2"
    }

    test("a schema reached through several refs declares its variants' types once") {
        val holder = obj("event" to oneOf(arm("a", "payload" to obj("x" to STRING)), arm("b", "payload" to obj("y" to NUMBER))))
        val again = """{ "name": "api.again", "params": [ { "name": "h", "required": true, "schema": ${ref("Holder")} } ], "result": { "name": "AgainResult", "schema": ${ref("Holder")} } }"""
        val source = generate("Holder" to holder, extraMethods = listOf(again))
        source.count("public data class Payload(") shouldBe 1
        source.count("public data class Payload_2(") shouldBe 1
        source shouldNotContain "Payload_3"
    }
})
