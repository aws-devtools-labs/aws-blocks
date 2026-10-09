package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

/** One method `api.op` returning [result], plus the given component [schemas]. */
private fun spec(schemas: String, result: String = ref("Holder"), params: String = ""): String =
    """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [
        { "name": "api.op", "params": [ $params ], "result": { "name": "OpResult", "schema": $result } }
      ],
      "components": { "schemas": $schemas }
    }
    """.trimIndent()

private fun ref(name: String): String = """{ "${'$'}ref": "#/components/schemas/$name" }"""

private fun obj(properties: String, vararg required: String): String =
    """{ "type": "object", "properties": { $properties }, "required": [ ${required.joinToString { "\"$it\"" }} ] }"""

/** A component `Holder` with the given properties. */
private fun holder(properties: String, vararg required: String): String =
    spec(schemas = """{ "Holder": ${obj(properties, *required)} }""")

private fun types(spec: String): String {
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    val files = KotlinCodeGenerator("com.example.app").generate(model).files
    return files.single { it.name == "Types" }.toString()
}

/** Number of occurrences of [needle]. */
private fun String.count(needle: String): Int = windowed(needle.length).count { it == needle }

/**
 * A component schema's inline-object property is referenced as a nested type of the schema
 * (`Holder.Payload`). It used to be emitted only when its name happened to sort before the
 * schema's, so most such schemas generated a client that didn't compile.
 */
class InlineObjectPropertyTest : FunSpec({

    val payload = """ "payload": ${obj(""" "label": { "type": "string" } """, "label")} """

    test("a required inline-object property generates a nested @Serializable data class") {
        val source = types(holder(payload, "payload"))
        source shouldContain "public val payload: Payload,"
        source shouldContain """
            |  @Serializable
            |  public data class Payload(
            |    public val label: String,
            |  )
        """.trimMargin()
    }

    test("the nested class is emitted whatever the property name sorts relative to the schema") {
        // "aardvark" sorts before "Holder", "zebra" after: both must be nested in Holder.
        val props = """
            "aardvark": ${obj(""" "a": { "type": "string" } """, "a")},
            "zebra": ${obj(""" "z": { "type": "string" } """, "z")}
        """
        val source = types(holder(props, "aardvark", "zebra"))
        source shouldContain "\n  public data class Aardvark("
        source shouldContain "\n  public data class Zebra("
        source shouldContain "public val aardvark: Aardvark,"
        source shouldContain "public val zebra: Zebra,"
    }

    test("an inline object inside an inline object nests one level deeper") {
        val meta = """ "meta": ${obj(""" "count": { "type": "integer" } """, "count")} """
        val props = """ "payload": ${obj("""$meta, "label": { "type": "string" }""", "meta", "label")} """
        val source = types(holder(props, "payload"))
        source shouldContain "public val payload: Payload,"
        source shouldContain "public val meta: Meta,"
        source shouldContain """
            |    @Serializable
            |    public data class Meta(
            |      public val count: Int,
            |    )
        """.trimMargin()
    }

    test("three levels deep") {
        val c = """ "c": ${obj(""" "v": { "type": "boolean" } """, "v")} """
        val b = """ "b": ${obj(c, "c")} """
        val a = """ "a": ${obj(b, "b")} """
        val source = types(holder(a, "a"))
        source shouldContain """
            |      @Serializable
            |      public data class C(
            |        public val v: Boolean,
            |      )
        """.trimMargin()
        source shouldContain "public val c: C,"
    }

    test("an optional inline-object property is nullable with a null default") {
        val source = types(holder(payload))
        source shouldContain "public val payload: Payload? = null,"
        source shouldContain "\n  public data class Payload("
    }

    test("a nullable inline-object property (oneOf object | null) is nullable") {
        val nullable = """ "payload": { "oneOf": [ ${obj(""" "flag": { "type": "boolean" } """, "flag")}, { "type": "null" } ] } """
        val source = types(holder(nullable, "payload"))
        source shouldContain "public val payload: Payload?,"
        source shouldContain "\n  public data class Payload("
        source shouldContain "public val flag: Boolean,"
    }

    test("an array of inline objects generates a nested element class") {
        val items = """ "items": { "type": "array", "items": ${obj(""" "sku": { "type": "string" } """, "sku")} } """
        val source = types(holder(items, "items"))
        source shouldContain "public val items: List<Items>,"
        source shouldContain "\n  public data class Items("
        source shouldContain "public val sku: String,"
    }

    test("a map of inline objects generates a nested value class") {
        val tags = """ "tags": { "type": "object", "additionalProperties": ${obj(""" "n": { "type": "integer" } """, "n")} } """
        val source = types(holder(tags, "tags"))
        source shouldContain "public val tags: Map<String, Tags>,"
        source shouldContain "\n  public data class Tags("
    }

    test("an enum inside an inline object is nested in that object") {
        val inner = """ "kind": { "type": "string", "enum": ["a", "b"] } """
        val source = types(holder(""" "payload": ${obj(inner, "kind")} """, "payload"))
        source shouldContain "public val kind: Kind,"
        source shouldContain """
            |    @Serializable
            |    public enum class Kind {
        """.trimMargin()
    }

    test("two schemas with a same-named inline property each get their own class") {
        val schemas = """
            {
              "Holder": ${obj(""" "payload": ${obj(""" "label": { "type": "string" } """, "label")} """, "payload")},
              "Envelope": ${obj(""" "payload": ${obj(""" "size": { "type": "integer" } """, "size")} """, "payload")},
              "Both": ${obj(""" "h": ${ref("Holder")}, "e": ${ref("Envelope")} """, "h", "e")}
            }
        """
        val source = types(spec(schemas = schemas, result = ref("Both")))
        source shouldContain """
            |public data class Envelope(
            |  public val payload: Payload,
            |) {
            |  @Serializable
            |  public data class Payload(
            |    public val size: Int,
            |  )
        """.trimMargin()
        source shouldContain """
            |public data class Holder(
            |  public val payload: Payload,
            |) {
            |  @Serializable
            |  public data class Payload(
            |    public val label: String,
            |  )
        """.trimMargin()
        source.count("public data class Payload(") shouldBe 2
    }

    test("a schema referenced more than once emits its nested class once") {
        val schemas = """
            {
              "Holder": ${obj(payload, "payload")},
              "Pair": ${obj(""" "first": ${ref("Holder")}, "second": ${ref("Holder")} """, "first", "second")}
            }
        """
        val source = types(spec(schemas = schemas, result = ref("Pair")))
        source.count("public data class Payload(") shouldBe 1
        source.count("public data class Holder(") shouldBe 1
    }

    test("a nested class named like a top-level schema doesn't shadow that schema") {
        val schemas = """
            {
              "Payload": ${obj(""" "top": { "type": "string" } """, "top")},
              "Holder": ${obj("""$payload, "other": ${ref("Payload")}""", "payload", "other")}
            }
        """
        val source = types(spec(schemas = schemas))
        source shouldContain "public val payload: Payload,"
        // Inside Holder, a bare `Payload` would mean Holder.Payload, so the top-level schema is qualified.
        source shouldContain "public val other: com.example.app.Payload,"
        source shouldContain "public val top: String,"
        source shouldContain "public val label: String,"
    }

    test("a method-level inline object is unaffected (still scoped to the operation)") {
        val source = KotlinCodeGenerator("com.example.app").generate(
            CodegenModelBuilder().build(
                OpenRpcParser.parse(spec(schemas = "{}", result = obj(payload, "payload"))),
            ),
        ).files.joinToString("\n") { it.toString() }
        source shouldContain "public val payload: Result.Payload,"
        source shouldNotContain "Holder"
    }
})
