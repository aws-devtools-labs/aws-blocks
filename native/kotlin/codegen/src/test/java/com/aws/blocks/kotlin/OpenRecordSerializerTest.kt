package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

private const val STRING = """{ "type": "string" }"""
private const val DOWNLOAD = """{ "x-blocks-transferable": "file-bucket/download" }"""
private const val OIDC = """{ "x-blocks-transferable": "oidc/client" }"""

private fun ref(name: String): String = """{ "${'$'}ref": "#/components/schemas/$name" }"""

private fun obj(properties: String, required: List<String>, additional: String? = null): String {
    val extra = additional?.let { """, "additionalProperties": $it""" } ?: ""
    return """{ "type": "object", "properties": { $properties }, "required": [ ${required.joinToString { "\"$it\"" }} ]$extra }"""
}

/** `api.op(input)` with [param] as its one parameter and [result] as its result, plus [schemas]. */
private fun spec(param: String? = null, result: String = """{ "type": "boolean" }""", schemas: String = ""): String {
    val params = param?.let { """[ { "name": "input", "required": true, "schema": $it } ]""" } ?: "[]"
    return """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [ { "name": "api.op", "params": $params, "result": { "name": "OpResult", "schema": $result } } ],
      "components": { "schemas": { $schemas } }
    }
    """.trimIndent()
}

/** Generated files by name, with KotlinPoet's line wrapping after a colon undone. */
private fun files(spec: String, relayTo: String? = "app://cb"): Map<String, String> {
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app", relayTo = relayTo).generate(model)
        .files.associate { it.name to it.toString().replace(Regex(":\\n +"), ": ") }
}

private fun Map<String, String>.all(): String = values.joinToString("\n")

/** `Auth`'s `signUp` action: a variant of the `action`-discriminated input union, open for attributes. */
private val authInput = """
    { "oneOf": [
      ${obj(""" "action": { "type": "string", "enum": ["signUp"] }, "username": $STRING, "password": $STRING """, listOf("action", "username", "password"), STRING)},
      ${obj(""" "action": { "type": "string", "enum": ["signOut"] } """, listOf("action"))}
    ] }
""".trimIndent()

/**
 * An open record (an object schema with `properties` and `additionalProperties`, TypeScript
 * `T & Record<string, V>`) collects its extra keys in `attributes: Map<String, V>`. The class
 * used the plugin's serializer, so the extra keys went out nested under an `"attributes"` key
 * (the server reads them as one attribute named `attributes`) and the response's extra keys
 * were ignored. Fixture 18's `SignUp` (`Auth`'s custom sign-up attributes) is one. Each open
 * record now has a custom serializer that writes and reads them flat; see the round trip
 * against the real `Auth` block in the Kotlin e2e suite (`AuthSignUpAttributesE2ETest`).
 */
class OpenRecordSerializerTest : FunSpec({

    context("a union variant (Auth's signUp action)") {
        val auth = files(spec(param = authInput)).getValue("Api")

        test("uses the open-record serializer, named by its discriminator value") {
            auth shouldContain "@Serializable(with = SignUp.OpenRecordSerializer::class)\n      @SerialName(\"signUp\")\n      public data class SignUp("
            auth shouldContain "internal object OpenRecordSerializer : KSerializer<SignUp>"
            auth shouldContain "override val descriptor: SerialDescriptor = buildClassSerialDescriptor(\"signUp\")"
        }

        test("keeps the public constructor, and copies it into the plugin-serialized fields class") {
            auth shouldContain """
                |      public data class SignUp(
                |        public val username: String,
                |        public val password: String,
                |        public val attributes: Map<String, String> = emptyMap(),
                |      ) : Input() {
                |        @Serializable
                |        private data class OpenRecordFields(
                |          public val username: String,
                |          public val password: String,
                |          public val attributes: Map<String, String> = emptyMap(),
                |        )
            """.trimMargin()
        }

        test("writes attributes flat, never over a property or the discriminator") {
            auth shouldContain "private val fieldKeys: Set<String> = setOf(\"username\", \"password\")"
            auth shouldContain "for ((key, element) in fields) if (key != \"attributes\") put(key, element)"
            auth shouldContain
                "fields[\"attributes\"]?.jsonObject?.forEach { (key, element) -> if (key !in fieldKeys && key != \"action\") put(key, element) }"
            auth shouldContain "output.encodeJsonElement(flat)"
        }

        test("reads every key that is neither a property nor the discriminator into attributes") {
            auth shouldContain "for ((key, element) in flat) if (key in fieldKeys) put(key, element)"
            auth shouldContain
                "put(\"attributes\", buildJsonObject { for ((key, element) in flat) if (key !in fieldKeys && key != \"action\") put(key, element) })"
            auth shouldContain "return SignUp(fields.username, fields.password, fields.attributes)"
        }

        test("a closed variant of the same union keeps the plugin's serializer") {
            auth shouldContain "@Serializable\n      @SerialName(\"signOut\")\n      public data object SignOut : Input()"
            auth.split("OpenRecordSerializer : KSerializer").size shouldBe 2
        }
    }

    context("a top-level model") {
        val directory = obj(""" "title": $STRING """, listOf("title"), OIDC)
        val gen = files(spec(result = ref("Directory"), schemas = """ "Directory": $directory """))
        val types = gen.getValue("Types")

        test("names the serializer without importing the model from the default package") {
            types shouldContain "@Serializable(with = Directory.OpenRecordSerializer::class)\npublic data class Directory("
            types shouldNotContain "import Directory"
            types shouldContain "override val descriptor: SerialDescriptor = buildClassSerialDescriptor(\"Directory\")"
        }

        test("an OIDC client value keeps its contextual serializer and decodes with the calling Json") {
            types shouldContain "public val attributes: Map<String, @Contextual OidcClient> = emptyMap(),\n) {\n  @Serializable\n  private data class OpenRecordFields("
            types shouldContain "val fields = input.json.decodeFromJsonElement(Directory.OpenRecordFields.serializer(), nested)"
            types shouldContain "val fields = output.json.encodeToJsonElement(Directory.OpenRecordFields.serializer(), "
            // No union, so no discriminator key is excluded.
            types shouldContain "if (key !in fieldKeys) put(key, element) }"
            types shouldNotContain "key != \"action\""
        }
    }

    context("an operation's inline input") {
        val api = files(spec(param = obj(""" "username": $STRING, "password": $STRING """, listOf("username", "password"), STRING))).getValue("Api")

        test("the nested Input class gets the serializer") {
            api shouldContain "@Serializable(with = Input.OpenRecordSerializer::class)\n    public data class Input("
            api shouldContain "return Input(fields.username, fields.password, fields.attributes)"
        }
    }

    context("the fields class carries every property annotation and default") {
        val holder = obj(
            """ "in": $STRING, "file": $DOWNLOAD, "note": { "type": "string", "default": "hi" }, "count": { "type": "number" } """,
            listOf("in", "file"),
            STRING,
        )
        val types = files(spec(result = ref("Holder"), schemas = """ "Holder": $holder """)).getValue("Types")
        val fieldsClass = types.substringAfter("private data class OpenRecordFields(").substringBefore("\n  )")

        test("keyword names keep @SerialName, and their wire name is a field key") {
            fieldsClass shouldContain "@SerialName(\"in\")\n    public val `in`: String,"
            types shouldContain "setOf(\"in\", \"file\", \"note\", \"count\")"
            types shouldContain "value.`in`"
            types shouldContain "fields.`in`"
        }

        test("a transferable property keeps its serializer annotation") {
            fieldsClass shouldContain "@Serializable(with = FileDownloadHandleSerializer::class)\n    public val `file`: FileDownloadHandle,"
        }

        test("defaults are the record's own") {
            types shouldContain "private data class OpenRecordFields("
            fieldsClass shouldContain "public val note: String? = \"hi\","
            fieldsClass shouldContain "public val count: Double? = null,"
            fieldsClass shouldContain "public val attributes: Map<String, String> = emptyMap(),"
        }
    }

    context("records that aren't open are unchanged") {
        test("a closed model keeps the plugin's serializer") {
            val types = files(spec(result = ref("Note"), schemas = """ "Note": ${obj(""" "id": $STRING """, listOf("id"))} """)).getValue("Types")
            types shouldContain "@Serializable\npublic data class Note("
            types shouldNotContain "OpenRecord"
        }

        test("an object with only additionalProperties is a plain map") {
            val api = files(spec(result = """{ "type": "object", "additionalProperties": { "type": "number" } }""")).getValue("Api")
            api shouldContain "public suspend fun op(): Map<String, Double>"
            api shouldNotContain "OpenRecord"
        }
    }
})
