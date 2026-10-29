package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

private const val STRING = """{ "type": "string" }"""

private fun param(name: String, schema: String = STRING, required: Boolean = true): String =
    """{ "name": "$name", "required": $required, "schema": $schema }"""

private fun method(name: String, vararg params: String, result: String = STRING): String =
    """{ "name": "api.$name", "params": [ ${params.joinToString()} ], "result": { "name": "${name}Result", "schema": $result } }"""

private fun generate(methods: List<String>, schemas: String = "{}", relayTo: String? = null): Map<String, String> {
    val spec = """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [ ${methods.joinToString(",\n")} ],
      "components": { "schemas": $schemas }
    }
    """.trimIndent()
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app", relayTo = relayTo).generate(model).files.associate { it.name to it.toString() }
}

private fun api(vararg methods: String): String = generate(methods.toList()).getValue("Api")

/**
 * Names the generator declares next to names from the spec, and the user names that met them.
 *
 * In an operation's method: the `request`, `args`, `result` and `json` locals, and the API
 * class's `client` property, which every method reads. A parameter named `client` shadowed the
 * property, so `client.execute(request)` didn't compile; one named `args` (beside another
 * optional parameter) did the same to `args.add(…)`; `request`, `result`, `json` and a single
 * optional `args` compiled with a shadowing warning. The body also read every parameter with
 * `%L`, so a keyword parameter (`class`) was written unescaped and didn't parse, and so did a
 * keyword property's validation (`require(in.length …)`). In a model: an open record's
 * `attributes` property met a property of that name ("Conflicting declarations"), a nested type
 * `Companion` met the serialization plugin's companion, and a hybrid arm's decoder declared a
 * local named after its nested union, which met its own `input`, `flat` or `fields`.
 *
 * Generated names now step aside: a local becomes `result_2` (`_3`, … if that is taken too) only
 * when a parameter has its name; the property is read as `this.client` only when a parameter is
 * named `client`; an open record's extras become `attributes_2` beside a property `attributes`.
 * User names never change (they are public: named arguments and properties), and every name that
 * doesn't collide is byte-identical.
 */
class GeneratedNameCollisionTest : FunSpec({

    test("a parameter named client reads the API's client as this.client") {
        val source = api(method("send", param("client")))
        source shouldContain "public suspend fun send(client: String): String {"
        source shouldContain "params = listOf(JsonPrimitive(client))"
        source shouldContain "val result = this.client.execute(request)"
    }

    test("an optional parameter named client reads the API's client as this.client") {
        val source = api(method("send", param("a"), param("client", required = false)))
        source shouldContain "if (client != null) listOf(JsonPrimitive(a), JsonPrimitive(client))"
        source shouldContain "val result = this.client.execute(request)"
    }

    test("parameters named request and result move the locals aside") {
        val source = api(method("check", param("request"), param("result")))
        source shouldContain "public suspend fun check(request: String, result: String): String {"
        source shouldContain "val request_2 = BlocksRequest(method = \"api.check\", params = listOf(JsonPrimitive(request), JsonPrimitive(result)),"
        source shouldContain "val result_2 = client.execute(request_2)"
        source shouldContain "return BlocksJson.decodeFromJsonElement(result_2)"
    }

    test("the suffix skips a name a parameter already has") {
        val source = api(method("check", param("result"), param("result_2")))
        source shouldContain "val result_3 = client.execute(request)"
    }

    test("an optional parameter named args beside another moves the args local aside") {
        val source = api(method("find", param("args", required = false), param("limit", required = false)))
        source shouldContain "val args_2 = mutableListOf<JsonElement>()"
        // FX45: a trailing optional argument is sent (as null if unset) when a later one is set.
        source shouldContain "if (args != null || limit != null) {\n      args_2.add(if (args != null) JsonPrimitive(args) else JsonNull)"
        source shouldContain "if (limit != null) {\n      args_2.add(JsonPrimitive(limit))"
        source shouldContain "params = args_2,"
    }

    test("a parameter named json moves the channel's json local aside") {
        val channel = """{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [ { "type": "object", "properties": { "c": { "x-blocks-transferable": "oidc/client" } }, "required": ["c"] } ] }"""
        val files = generate(listOf(method("watch", param("json"), result = channel)), relayTo = "app://callback")
        val source = files.getValue("Api")
        source shouldContain "val json_2 = OidcClient.json(client, \"app://callback\")"
        source shouldContain "json_2.decodeFromJsonElement"
    }

    test("hard-keyword parameters are escaped where the body reads them; soft keywords needn't be") {
        val list = """{ "type": "array", "items": { "type": "string" } }"""
        val source = api(
            method("all", param("class"), param("is", list), param("value")),
            method("one", param("fun"), param("in", required = false)),
            method("many", param("object", required = false), param("when", required = false)),
        )
        source shouldContain "    `class`: String,\n    `is`: List<String>,\n    `value`: String,\n  ): String {"
        source shouldContain "params = listOf(JsonPrimitive(`class`), buildJsonArray { addAll(`is`) }, JsonPrimitive(value))"
        source shouldContain "if (`in` != null) listOf(JsonPrimitive(`fun`), JsonPrimitive(`in`)) else listOf(JsonPrimitive(`fun`))"
        source shouldContain "if (`object` != null || `when` != null) {\n      args.add(if (`object` != null) JsonPrimitive(`object`) else JsonNull)"
    }

    test("a keyword property's validation is escaped") {
        val schemas = """{ "Doc": { "type": "object", "properties": { "in": { "type": "string", "minLength": 1 }, "is": { "type": "string", "maxLength": 3 } }, "required": ["in"] } }"""
        val types = generate(listOf(method("get", param("d", """{ "${'$'}ref": "#/components/schemas/Doc" }"""))), schemas).getValue("Types")
        types shouldContain "require(`in`.length >= 1) { \"in must be at least 1 characters\" }"
        types shouldContain "`is`?.let {\n      require(it.length <= 3) { \"is must be at most 3 characters\" }"
    }

    test("an open record's extras step aside for a property named attributes") {
        val schemas = """{ "Bag": { "type": "object", "properties": { "attributes": { "type": "string" } }, "required": ["attributes"], "additionalProperties": { "type": "number" } } }"""
        val types = generate(listOf(method("put", param("b", """{ "${'$'}ref": "#/components/schemas/Bag" }"""))), schemas).getValue("Types")
        types shouldContain "public val attributes: String,"
        types shouldContain "public val attributes_2: Map<String, Double> = emptyMap(),"
        types shouldContain "private val fieldKeys: Set<String> = setOf(\"attributes\")"
        types shouldContain "for ((key, element) in fields) if (key != \"attributes_2\") put(key, element)"
        types shouldContain "fields[\"attributes_2\"]?.jsonObject?.forEach"
        types shouldContain "put(\"attributes_2\", buildJsonObject { for ((key, element) in flat) if (key !in fieldKeys) put(key, element) })"
        types shouldContain "return Bag(fields.attributes, fields.attributes_2)"
    }

    test("an open record without a property named attributes keeps attributes") {
        val schemas = """{ "Bag": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"], "additionalProperties": { "type": "number" } } }"""
        val types = generate(listOf(method("put", param("b", """{ "${'$'}ref": "#/components/schemas/Bag" }"""))), schemas).getValue("Types")
        types shouldContain "public val attributes: Map<String, Double> = emptyMap(),"
        types shouldNotContain "attributes_2"
    }

    test("a nested type named Companion steps aside for the serialization plugin's companion") {
        val result = """{ "type": "object", "properties": { "companion": { "type": "object", "properties": { "x": { "type": "string" } }, "required": ["x"] } }, "required": ["companion"] }"""
        val source = api(method("pair", result = result))
        source shouldContain "public val `companion`: Result.Companion_2,"
        source shouldContain "public data class Companion_2("
        source shouldNotContain "class Companion("
    }

    test("a hybrid arm's decoder local steps aside for a nested union named after it") {
        fun arm(tag: String, field: String) =
            """{ "type": "object", "properties": { "fields": { "type": "string", "enum": ["$tag"] }, "$field": { "type": "string" } }, "required": ["fields", "$field"] }"""
        val hybrid = """{ "type": "object", "properties": { "action": { "type": "string", "enum": ["go"] }, "session": { "type": "string" } }, "required": ["action", "session"], "oneOf": [ ${arm("a", "x")}, ${arm("b", "y")} ] }"""
        val other = """{ "type": "object", "properties": { "action": { "type": "string", "enum": ["stop"] } }, "required": ["action"] }"""
        val source = api(method("act", param("input", """{ "oneOf": [ $hybrid, $other ] }""")))
        source shouldContain "val fields_2 = input.json.decodeFromJsonElement(Fields.serializer(), JsonObject(flat.filterKeys { key -> key !in fieldKeys && key != \"action\" }))"
        source shouldContain "return Go(session = fields.session, fields = fields_2)"
    }

    test("names that collide with nothing are unchanged") {
        val source = api(method("check", param("id"), param("limit", required = false)))
        source shouldContain "val args: List<JsonElement> = if (limit != null) listOf(JsonPrimitive(id), JsonPrimitive(limit)) else listOf(JsonPrimitive(id))"
        source shouldContain "val request = BlocksRequest(method = \"api.check\", params = args, id = BlocksRequest.nextId())"
        source shouldContain "val result = client.execute(request)"
        source shouldContain "return BlocksJson.decodeFromJsonElement(result)"
        source shouldNotContain "this.client"
        source shouldNotContain "_2"
    }

    test("a parameter named after an object the body reads gets an aliased import") {
        val source = api(method("send", param("BlocksJson"), param("BlocksRequest", """{ "type": "object", "properties": { "x": { "type": "string" } }, "required": ["x"] }""")))
        source shouldContain "import com.aws.blocks.kotlin.json.BlocksJson as BlocksJson_2"
        source shouldContain "import com.aws.blocks.kotlin.BlocksRequest as BlocksRequest_2"
        source shouldContain "BlocksJson_2.encodeToJsonElement(BlocksRequest)"
        source shouldContain "id = BlocksRequest_2.nextId()"
    }
})
