package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.generator.RelayToRequirement
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

private fun spec(methods: String, schemas: String = ""): String =
    """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [ $methods ],
      "components": { "schemas": { $schemas } }
    }
    """.trimIndent()

/** A method taking one required parameter `value` of [schema], returning [result] (default: the same schema). */
private fun echo(name: String, schema: String, result: String = schema): String =
    """{ "name": "api.$name", "params": [ { "name": "value", "required": true, "schema": $schema } ],
         "result": { "name": "${name}Result", "schema": $result } }"""

private fun generate(spec: String, relayTo: String? = null): Map<String, String> {
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app", relayTo = relayTo, relayToRequirement = RelayToRequirement.Required)
        .generate(model).files.associate { it.name to it.toString() }
}

private fun api(spec: String): String = generate(spec).getValue("Api")

private fun String.count(needle: String): Int = windowed(needle.length).count { it == needle }

private const val STRING = """{ "type": "string" }"""
private const val OBJECT_TEXT = """{ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }"""

/**
 * A union without a JSON-string discriminator over object arms used kotlinx's default sealed
 * serializer, which writes and reads `{"type": "<serial name>", …}`. Fixture 09's `anyOf [string,
 * {text}]` couldn't decode `"abc"` or `{"text":"t"}`, and encoded `{"type":"variant1"}` (R63, R73).
 * Each test here fails on the base generator unless it says it's a guard.
 */
class UnionSerializerTest : FunSpec({

    test("a union without a discriminator gets its own serializer; no kotlinx polymorphism, no `type` key") {
        val api = api(spec(echo("search", """{ "anyOf": [ $STRING, $OBJECT_TEXT ] }""")))
        api shouldContain "@Serializable(with = Value.ValueSerializer::class)\n    public sealed class Value {"
        api shouldContain "public object ValueSerializer : KSerializer<Value> {"
        api shouldNotContain "@SerialName(\"variant1\")"
        api shouldNotContain "@SerialName(\"variant2\")"
        api shouldNotContain "\"type\""
    }

    test("a string arm is a class holding its value, read and written as the bare string") {
        val api = api(spec(echo("search", """{ "anyOf": [ $STRING, $OBJECT_TEXT ] }""")))
        api shouldContain "public data class Variant1(\n        public val `value`: String,\n      ) : Value()"
        api shouldNotContain "data object Variant1"
        api shouldContain "is Variant1 -> output.json.encodeToJsonElement<String>(value.value)"
        api shouldContain "if (element is JsonPrimitive && element.isString) {"
        api shouldContain "return Variant1(input.json.decodeFromJsonElement<String>(element))"
    }

    test("an object arm matches by its required keys and is written without a discriminator") {
        val api = api(spec(echo("search", """{ "anyOf": [ $STRING, $OBJECT_TEXT ] }""")))
        api shouldContain "if (element is JsonObject && \"text\" in element) {"
        api shouldContain "return input.json.decodeFromJsonElement(Variant2.serializer(), element)"
        api shouldContain "is Variant2 -> output.json.encodeToJsonElement(Variant2.serializer(), value)"
    }

    test("a value that matches no arm throws a SerializationException naming the union and its arms") {
        val api = api(spec(echo("search", """{ "anyOf": [ $STRING, $OBJECT_TEXT ] }""")))
        api shouldContain
            "throw SerializationException(\"No variant of Value matches this JSON value; expected a string; or an object with \\\"text\\\"\", failure)"
    }

    test("each value arm kind is matched by its JSON kind: integer, number, boolean, array, map, date-time, unknown") {
        val api = api(
            spec(
                echo(
                    "mixed",
                    """{ "anyOf": [ { "type": "integer" }, { "type": "number" }, { "type": "boolean" },
                        { "type": "array", "items": $STRING }, { "type": "string", "format": "date-time" },
                        { "type": "object", "additionalProperties": { "type": "integer" } }, { "type": "unknown" } ] }""",
                ),
            ),
        )
        api shouldContain "if (element is JsonPrimitive && !element.isString && element.intOrNull != null) {"
        api shouldContain "if (element is JsonPrimitive && !element.isString && element.doubleOrNull != null) {"
        api shouldContain "if (element is JsonPrimitive && !element.isString && element.booleanOrNull != null) {"
        api shouldContain "if (element is JsonArray) {"
        api shouldContain "return Variant4(input.json.decodeFromJsonElement<List<String>>(element))"
        api shouldContain "return Variant5(input.json.decodeFromJsonElement<Instant>(element))"
        api shouldContain "return Variant6(input.json.decodeFromJsonElement<Map<String, Int>>(element))"
        api shouldContain "if (true) {"
        api shouldContain "return Variant7(input.json.decodeFromJsonElement<JsonElement>(element))"
    }

    test("arms are tried in spec order in a union without a discriminator") {
        val api = api(
            spec(
                echo(
                    "shape",
                    """{ "anyOf": [ $OBJECT_TEXT, { "type": "object", "additionalProperties": $STRING } ] }""",
                ),
            ),
        )
        val objectArm = api.indexOf("if (element is JsonObject && \"text\" in element)")
        val mapArm = api.indexOf("return Variant2(input.json.decodeFromJsonElement<Map<String, String>>(element))")
        (objectArm in 0 until mapArm) shouldBe true
    }

    test("guard: a nullable union still decodes null through the nullable serializer, outside the union's serializer") {
        val api = api(spec(echo("get", """{ "anyOf": [ $STRING, $OBJECT_TEXT, { "type": "null" } ] }""")))
        api shouldContain "public suspend fun `get`(`value`: Get.Value?): Get.Result?"
        api shouldNotContain "JsonNull"
    }

    test("literal arms keep their JSON type and declare no enum named after the union") {
        val api = api(
            spec(
                echo(
                    "pick",
                    """{ "anyOf": [ { "const": "auto" }, { "const": 5 }, { "const": true },
                        { "type": "string", "enum": ["small", "large"] }, $OBJECT_TEXT ] }""",
                ),
            ),
        )
        api shouldContain "public data object Variant1 : Value()"
        api shouldContain "if (element == JsonPrimitive(\"auto\")) return Variant1"
        api shouldContain "if (element == JsonPrimitive(5L)) return Variant2"
        api shouldContain "if (element == JsonPrimitive(true)) return Variant3"
        api shouldContain "is Variant3 -> JsonPrimitive(true)"
        api shouldContain "if (element in setOf(JsonPrimitive(\"small\"), JsonPrimitive(\"large\"))) {"
        api shouldNotContain "enum class Value"
        api shouldNotContain "enum class Result"
    }

    test("a transferable arm is matched by its `__blocks` tag and decodes through its serializer") {
        val api = api(
            spec(
                """{ "name": "api.getFile", "params": [], "result": { "name": "GetFileResult", "schema":
                    { "anyOf": [ { "x-blocks-transferable": "file-bucket/download" }, $OBJECT_TEXT ] } } }""",
            ),
        )
        api shouldContain "if (element is JsonObject && element[\"__blocks\"] == JsonPrimitive(\"file-bucket/download\")) {"
        api shouldContain "return Variant1(input.json.decodeFromJsonElement(FileDownloadHandleSerializer, element))"
        api shouldContain "public val `value`: FileDownloadHandle,"
        api shouldContain "is Variant1 -> output.json.encodeToJsonElement(FileDownloadHandleSerializer, value.value)"
    }

    test("an OIDC client in a value arm makes the operation need a relay target") {
        val oidcSpec = spec(
            """{ "name": "api.getClient", "params": [], "result": { "name": "GetClientResult", "schema":
                { "anyOf": [ { "x-blocks-transferable": "oidc/client" }, $OBJECT_TEXT ] } } }""",
        )
        generate(oidcSpec).getValue("Api") shouldContain "OIDC is not configured"
        val bound = generate(oidcSpec, relayTo = "app://cb").getValue("Api")
        bound shouldContain "return OidcClient.json(client, \"app://cb\").decodeFromJsonElement(result)"
        bound shouldContain "return Variant1(input.json.decodeFromJsonElement<OidcClient>(element))"
    }

    test("a boolean discriminator is written and matched as a JSON boolean") {
        val api = api(
            spec(
                echo(
                    "update",
                    """{ "oneOf": [
                        { "type": "object", "properties": { "isUpdated": { "type": "boolean", "enum": [true] } }, "required": ["isUpdated"] },
                        { "type": "object", "properties": { "isUpdated": { "type": "boolean", "enum": [false] }, "step": $STRING }, "required": ["isUpdated", "step"] }
                    ] }""",
                ),
            ),
        )
        api shouldNotContain "JsonContentPolymorphicSerializer"
        api shouldContain "put(\"isUpdated\", JsonPrimitive(true))"
        api shouldContain "put(\"isUpdated\", JsonPrimitive(false))"
        api shouldContain "when (element[\"isUpdated\"]) {"
        api shouldContain "JsonPrimitive(true) -> return IsUpdatedTrue"
        api shouldContain "JsonPrimitive(false) -> return input.json.decodeFromJsonElement(IsUpdatedFalse.serializer(), fields)"
    }

    test("a numeric discriminator is written as a JSON number, not a string") {
        val api = api(
            spec(
                echo(
                    "version",
                    """{ "oneOf": [
                        { "type": "object", "properties": { "v": { "const": 1 }, "a": $STRING }, "required": ["v", "a"] },
                        { "type": "object", "properties": { "v": { "const": 2 }, "b": $STRING }, "required": ["v", "b"] }
                    ] }""",
                ),
            ),
        )
        api shouldNotContain "@JsonClassDiscriminator"
        api shouldContain "put(\"v\", JsonPrimitive(1L))"
        api shouldContain "JsonPrimitive(2L) -> return input.json.decodeFromJsonElement(`2`.serializer(), fields)"
    }

    test("a string discriminator with a string arm reads the value arms first, then the discriminator") {
        val api = api(
            spec(
                echo(
                    "tagged",
                    """{ "oneOf": [ $STRING,
                        { "type": "object", "properties": { "kind": { "const": "circle" }, "r": { "type": "number" } }, "required": ["kind", "r"] },
                        { "type": "object", "properties": { "kind": { "const": "square" }, "s": { "type": "number" } }, "required": ["kind", "s"] }
                    ] }""",
                ),
            ),
        )
        api shouldNotContain "@JsonClassDiscriminator"
        api shouldContain "@SerialName(\"circle\")"
        val valueArm = api.indexOf("return Variant1(input.json.decodeFromJsonElement<String>(element))")
        val discriminated = api.indexOf("when (element[\"kind\"]) {")
        (valueArm in 0 until discriminated) shouldBe true
        api shouldContain "put(\"kind\", JsonPrimitive(\"circle\"))"
    }

    test("guard: a string discriminator over object arms keeps kotlinx's @JsonClassDiscriminator") {
        val api = api(
            spec(
                echo(
                    "act",
                    """{ "oneOf": [
                        { "type": "object", "properties": { "action": { "const": "add" }, "n": { "type": "number" } }, "required": ["action", "n"] },
                        { "type": "object", "properties": { "action": { "const": "clear" } }, "required": ["action"] }
                    ] }""",
                ),
            ),
        )
        api shouldContain "@Serializable\n    @JsonClassDiscriminator(\"action\")\n    public sealed class Value {"
        api shouldContain "@SerialName(\"add\")"
        api shouldNotContain "ValueSerializer"
    }

    test("a string-valued \"true\" discriminator is a string discriminator, not a boolean one") {
        val api = api(
            spec(
                echo(
                    "flag",
                    """{ "oneOf": [
                        { "type": "object", "properties": { "on": { "const": "true" }, "a": $STRING }, "required": ["on", "a"] },
                        { "type": "object", "properties": { "on": { "const": "false" } }, "required": ["on"] }
                    ] }""",
                ),
            ),
        )
        api shouldContain "@JsonClassDiscriminator(\"on\")"
        api shouldNotContain "JsonPrimitive(true)"
    }

    test("a hybrid arm writes its own properties and its nested union as one flat object") {
        val hybrid = """{ "oneOf": [
            { "type": "object", "properties": { "action": { "const": "signOut" } }, "required": ["action"] },
            { "type": "object", "properties": { "action": { "const": "confirm" }, "session": $STRING }, "required": ["action", "session"],
              "oneOf": [
                { "type": "object", "properties": { "challenge": { "const": "code" }, "code": $STRING }, "required": ["challenge", "code"] },
                { "type": "object", "properties": { "challenge": { "const": "password" }, "password": $STRING }, "required": ["challenge", "password"] }
              ] }
        ] }"""
        val api = api(spec(echo("act", hybrid, """{ "type": "boolean" }""")))
        api shouldContain "@Serializable(with = Confirm.HybridArmSerializer::class)\n      @SerialName(\"confirm\")"
        api shouldContain "private data class HybridArmFields(\n          public val session: String,\n        )"
        api shouldContain "override val descriptor: SerialDescriptor = buildClassSerialDescriptor(\"confirm\")"
        api shouldContain "output.encodeJsonElement(JsonObject(fields + union))"
        api shouldContain
            "val challenge = input.json.decodeFromJsonElement(Challenge.serializer(), JsonObject(flat.filterKeys { key -> key !in fieldKeys && key != \"action\" }))"
        api.count("HybridArmSerializer") shouldBe 2
    }

    test("a union in a component schema gets the same serializer in Types.kt") {
        val files = generate(
            spec(
                """{ "name": "api.get", "params": [], "result": { "name": "GetResult", "schema": { "${'$'}ref": "#/components/schemas/Holder" } } }""",
                """ "Holder": { "type": "object", "properties": { "value": { "anyOf": [ $STRING, $OBJECT_TEXT ] } }, "required": ["value"] } """,
            ),
        )
        val types = files.getValue("Types")
        types shouldContain "@Serializable(with = Value.ValueSerializer::class)\n  public sealed class Value {"
        types shouldContain "public data class Variant1(\n      public val `value`: String,\n    ) : Value()"
        types shouldNotContain "OptIn"
    }
})
