package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val STRING = """{ "type": "string" }"""

/** A JSON string literal for [text] (spec names here hold `\`, `"` and control characters). */
private fun q(text: String): String = JsonPrimitive(text).toString()

private fun obj(vararg properties: Pair<String, String>): String {
    val props = properties.joinToString(", ") { (name, schema) -> "${q(name)}: $schema" }
    val required = properties.joinToString(", ") { q(it.first) }
    return """{ "type": "object", "properties": { $props }, "required": [ $required ] }"""
}

private fun enumOf(vararg values: String): String = """{ "type": "string", "enum": [ ${values.joinToString { q(it) }} ] }"""

private fun ref(name: String) = """{ "${'$'}ref": ${q("#/components/schemas/$name")} }"""

private fun param(name: String, schema: String = STRING) = """{ "name": ${q(name)}, "required": true, "schema": $schema }"""

private fun method(name: String, vararg params: String, result: String = STRING) =
    """{ "name": ${q(name)}, "params": [ ${params.joinToString()} ], "result": { "name": "R", "schema": $result } }"""

private fun generate(methods: List<String>, schemas: Map<String, String> = emptyMap(), servers: String = "[]"): Map<String, String> {
    val spec = """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "servers": $servers,
      "methods": [ ${methods.joinToString(",\n")} ],
      "components": { "schemas": { ${schemas.entries.joinToString(", ") { (name, schema) -> "${q(name)}: $schema" }} } }
    }
    """.trimIndent()
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app").generate(model).files.associate { it.name to it.toString() }
}

/**
 * Kotlin can escape most spec names with backticks (`content-type`, `class`), but not one holding
 * `.`, `;`, `[`, `]`, `/`, `<`, `>`, `:` or `\` (rejected on the JVM), a backtick or a control
 * character such as a line break (which end a backticked name). KotlinPoet threw "Can't escape
 * identifier" on the first kind, so a spec with a key `back\slash`, or a method `a.b.ping`
 * (namespace `a`, operation `b.ping`), got no Kotlin client at all (FX40); the others it wrote
 * into a backticked name they broke.
 *
 * Such a name is now sanitized to its words, camel-cased (`back\slash` -> `backSlash`, `b.ping`
 * -> `bPing`, PascalCase `BackSlash` for a type), and the wire keeps the original: a property gets
 * `@SerialName`, an enum constant or variant its `@SerialName`, and an operation sends its spec
 * method name. A sanitized name never takes a name the spec already uses in that scope (it gets
 * `_2`). Every name Kotlin can declare is unchanged, backticks included.
 */
class IdentifierSanitizingTest : FunSpec({

    test("a property key with a backslash is sanitized and keeps its wire name") {
        val types = generate(
            listOf(method("api.get", result = ref("Weird"))),
            mapOf("Weird" to obj("back\\slash" to STRING, "plain" to STRING)),
        ).getValue("Types")
        types shouldContain "@SerialName(\"back\\\\slash\")\n  public val backSlash: String,"
        types shouldContain "public val plain: String,"
    }

    test("an operation of a dotted namespace is sanitized and sends its spec method name") {
        val files = generate(listOf(method("a.b.ping"), method("a.b.c.pong", result = obj("ok" to STRING))))
        val source = files.getValue("A")
        source shouldContain "public suspend fun bPing(): String {"
        source shouldContain "method = \"a.b.ping\""
        source shouldContain "public suspend fun bCPong(): BCPong.Result {"
        source shouldContain "method = \"a.b.c.pong\""
        source shouldContain "public object BCPong {"
    }

    test("a parameter that can't be declared is sanitized, and its inline type is named after its words") {
        val source = generate(listOf(method("api.put", param("in\\line", obj("x\\y" to STRING)), param("a.b")))).getValue("Api")
        source shouldContain "public suspend fun put(inLine: Put.InLine, aB: String): String {"
        source shouldContain "params = listOf(BlocksJson.encodeToJsonElement(inLine), JsonPrimitive(aB))"
        source shouldContain "@SerialName(\"x\\\\y\")\n      public val xY: String,"
    }

    test("a sanitized name never takes a name the spec already uses in that scope") {
        val types = generate(
            listOf(method("api.get", result = ref("Weird"))),
            mapOf("Weird" to obj("a.b" to STRING, "aB" to STRING)),
        ).getValue("Types")
        types shouldContain "@SerialName(\"a.b\")\n  public val aB_2: String,"
        types shouldContain "public val aB: String,"
    }

    test("enum values and discriminator values that can't be declared are sanitized") {
        val union = """{ "oneOf": [ ${obj("kind" to enumOf("x.y"), "v" to STRING)}, ${obj("kind" to enumOf("p\\q"), "w" to STRING)} ] }"""
        val source = generate(listOf(method("api.get", result = obj("level" to enumOf("a.b", "c\\d", "ok"), "pick" to union)))).getValue("Api")
        source shouldContain "@SerialName(\"a.b\")\n        AB,"
        source shouldContain "@SerialName(\"c\\\\d\")\n        CD,"
        source shouldContain "@SerialName(\"x.y\")\n        public data class XY("
        source shouldContain "@SerialName(\"p\\\\q\")\n        public data class PQ("
    }

    test("a backtick, a line break or a tab in a key is sanitized") {
        val types = generate(
            listOf(method("api.get", result = ref("Weird"))),
            mapOf("Weird" to obj("tick`tick" to STRING, "new\nline" to STRING, "tab\tbed" to STRING)),
        ).getValue("Types")
        types shouldContain "@SerialName(\"tick`tick\")\n  public val tickTick: String,"
        types shouldContain "@SerialName(\"new\\nline\")\n  public val newLine: String,"
        types shouldContain "@SerialName(\"tab\\tbed\")\n  public val tabBed: String,"
    }

    test("names Kotlin can declare are unchanged, backticks included") {
        val types = generate(
            listOf(method("api.get", result = ref("Weird"))),
            mapOf("Weird" to obj("content-type" to STRING, "contentType" to STRING, "it's" to STRING, "a\$b" to STRING, "a b" to STRING)),
        ).getValue("Types")
        types shouldContain "public val `a b`: String,"
        types shouldContain "public val `content-type`: String,"
        types shouldContain "public val contentType: String,"
        types shouldContain "public val `it's`: String,"
        types shouldContain "public val `a\$b`: String,"
        types shouldNotContain "@SerialName"
    }

    test("a validation message escapes the spec's pattern and field name") {
        val digits = """{ "type": "string", "pattern": ${q("^\\d+\"$")} }"""
        val types = generate(
            listOf(method("api.get", result = ref("Code"))),
            mapOf("Code" to obj("pin" to digits, "a\$b" to """{ "type": "string", "minLength": 2 }""")),
        ).getValue("Types")
        types shouldContain "{ \"pin must match pattern ^\\\\d+\\\"$\" }"
        types shouldContain "require(`a\$b`.length >= 2) { \"a\\\$b must be at least 2 characters\" }"
    }

    test("no spec name makes the generator throw") {
        val awkward = listOf("back\\slash", "a.b", "semi;colon", "br[ack]et", "sl/ash", "lt<gt>", "co:lon", "tick`tick", "new\nline", "tab\tbed", "a b", "", "\\", "_", "1st")
        val schemas = mapOf(
            "my.doc" to obj(*awkward.map { it to STRING }.toTypedArray()),
            "Holder" to obj(*awkward.map { it to obj("x" to STRING) }.toTypedArray()),
        )
        val methods = awkward.filter { it.isNotEmpty() }.mapIndexed { i, name ->
            val union = """{ "oneOf": [ ${obj("k" to enumOf(name), "v" to STRING)}, ${obj("k" to enumOf("other"), "w" to STRING)} ] }"""
            method("ns$i.$name", param(name, enumOf(*awkward.toTypedArray())), result = obj(name to union))
        } + method("x\\y.z", param("d", ref("my.doc")), param("h", ref("Holder")))
        val servers = JsonArray(
            awkward.filter { it.isNotEmpty() }.map { name ->
                buildJsonObject {
                    put("name", name)
                    put("url", "http://localhost/$name")
                }
            },
        ).toString()
        val files = generate(methods, schemas, servers)
        files.isNotEmpty() shouldBe true
        files.values.joinToString("\n") shouldContain "public data class myDoc("
    }
})
