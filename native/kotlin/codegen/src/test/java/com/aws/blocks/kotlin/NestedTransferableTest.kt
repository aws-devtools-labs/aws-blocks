package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.generator.RelayToRequirement
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

private const val NOTE = """{ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }"""

private fun ref(name: String): String = """{ "${'$'}ref": "#/components/schemas/$name" }"""

private val CHANNEL = """{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [${ref("Note")}] }"""
private const val DOWNLOAD = """{ "x-blocks-transferable": "file-bucket/download" }"""
private const val UPLOAD = """{ "x-blocks-transferable": "file-bucket/upload" }"""
private const val OIDC = """{ "x-blocks-transferable": "oidc/client" }"""

private fun array(items: String): String = """{ "type": "array", "items": $items }"""
private fun map(values: String): String = """{ "type": "object", "additionalProperties": $values }"""
private fun nullable(inner: String): String = """{ "oneOf": [ $inner, { "type": "null" } ] }"""

/** One method per entry of [results] (`api.<name>` returning the schema), plus `Note` and [schemas]. */
private fun spec(results: Map<String, String>, schemas: String = ""): String {
    val methods = results.entries.joinToString(",\n") { (name, schema) ->
        """{ "name": "api.$name", "params": [], "result": { "name": "${name}Result", "schema": $schema } }"""
    }
    val extra = if (schemas.isBlank()) "" else ", $schemas"
    return """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [ $methods ],
      "components": { "schemas": { "Note": $NOTE $extra } }
    }
    """.trimIndent()
}

/** A component `Holder` with the given [required] properties, returned by `api.getHolder`. */
private fun holder(properties: String, vararg required: String): String = spec(
    mapOf("getHolder" to ref("Holder")),
    """ "Holder": { "type": "object", "properties": { $properties }, "required": [ ${required.joinToString { "\"$it\"" }} ] } """,
)

private class Generated(val files: Map<String, String>) {
    val all: String get() = files.values.joinToString("\n")
    fun file(name: String): String = files[name] ?: error("no $name.kt among ${files.keys}")
}

private fun generate(
    spec: String,
    relayTo: String? = "app://cb",
    requirement: RelayToRequirement = RelayToRequirement.Required,
): Generated {
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    val result = KotlinCodeGenerator("com.example.app", relayTo = relayTo, relayToRequirement = requirement).generate(model)
    return Generated(result.files.associate { it.name to it.toString().unwrapped() })
}

/** KotlinPoet wraps a long property type onto the next line after its colon; undo that so a declaration reads on one line. */
private fun String.unwrapped(): String = replace(Regex(":\\n +"), ": ")

/** Every `@Serializable(with = X::class)` names a serializer object that is generated. */
private fun Generated.shouldDeclareEveryReferencedSerializer() {
    Regex("@Serializable\\(with = ([A-Za-z0-9_]+)::class\\)").findAll(all).map { it.groupValues[1] }.toSet()
        .forEach { name -> withClue("missing serializer $name") { all shouldContain "object $name :" } }
}

/**
 * Kotlin hydrates a transferable through a kotlinx serializer. Only a transferable that was a
 * model's own property got one, so a transferable inside a list, a map or a nullable element
 * generated a model that didn't compile, a list of transferables returned directly threw at
 * runtime, and an `oidc/client` in a model threw `Unknown transferable: oidc/client` (R52).
 */
class NestedTransferableTest : FunSpec({

    context("a model field holding transferables inside containers") {
        test("a list of channels annotates the element with the channel serializer") {
            val gen = generate(holder(""" "feeds": ${array(CHANNEL)} """, "feeds"))
            gen.file("Types") shouldContain
                "public val feeds: List<@Serializable(with = RealtimeChannelNoteSerializer::class) RealtimeChannel<Note>>,"
            gen.file("Serializers") shouldContain "public object RealtimeChannelNoteSerializer : KSerializer<RealtimeChannel<Note>>"
            gen.shouldDeclareEveryReferencedSerializer()
        }

        test("a map of channels annotates the value") {
            val gen = generate(holder(""" "byRoom": ${map(CHANNEL)} """, "byRoom"))
            gen.file("Types") shouldContain
                "public val byRoom: Map<String, @Serializable(with = RealtimeChannelNoteSerializer::class) RealtimeChannel<Note>>,"
            gen.shouldDeclareEveryReferencedSerializer()
        }

        test("lists of file handles annotate the element") {
            val gen = generate(holder(""" "downloads": ${array(DOWNLOAD)}, "uploads": ${array(UPLOAD)} """, "downloads", "uploads"))
            gen.file("Types") shouldContain
                "public val downloads: List<@Serializable(with = FileDownloadHandleSerializer::class) FileDownloadHandle>,"
            gen.file("Types") shouldContain
                "public val uploads: List<@Serializable(with = FileUploadHandleSerializer::class) FileUploadHandle>,"
            gen.file("Serializers") shouldContain "return FileDownloadHandle.fromJson(element)"
            gen.file("Serializers") shouldContain "return FileUploadHandle.fromJson(element)"
            gen.shouldDeclareEveryReferencedSerializer()
        }

        test("nested containers and nullable elements annotate the innermost transferable") {
            val gen = generate(
                holder(""" "grid": ${array(array(CHANNEL))}, "maybe": ${array(nullable(CHANNEL))}, "rooms": ${map(array(DOWNLOAD))} """, "grid", "maybe", "rooms"),
            )
            val types = gen.file("Types")
            types shouldContain
                "public val grid: List<List<@Serializable(with = RealtimeChannelNoteSerializer::class) RealtimeChannel<Note>>>,"
            types shouldContain
                "public val maybe: List<@Serializable(with = RealtimeChannelNoteSerializer::class) RealtimeChannel<Note>?>,"
            types shouldContain
                "public val rooms: Map<String, List<@Serializable(with = FileDownloadHandleSerializer::class) FileDownloadHandle>>,"
            gen.shouldDeclareEveryReferencedSerializer()
        }

        test("an optional list of channels annotates the element and stays nullable") {
            val spec = spec(
                mapOf("getHolder" to ref("Holder")),
                """ "Holder": { "type": "object", "properties": { "feeds": ${array(CHANNEL)} } } """,
            )
            generate(spec).file("Types") shouldContain
                "public val feeds: List<@Serializable(with = RealtimeChannelNoteSerializer::class) RealtimeChannel<Note>>? = null,"
        }

        test("a channel that is the property itself keeps its property annotation") {
            val types = generate(holder(""" "feed": $CHANNEL """, "feed")).file("Types")
            types shouldContain """
                |  @Serializable(with = RealtimeChannelNoteSerializer::class)
                |  public val feed: RealtimeChannel<Note>,
            """.trimMargin()
        }

        test("a channel list's payload type argument is the element's, one serializer per payload") {
            val spec = spec(
                mapOf("getHolder" to ref("Holder")),
                """ "Holder": { "type": "object", "properties": {
                      "feed": $CHANNEL,
                      "feeds": ${array(CHANNEL)},
                      "tags": ${array("""{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [${array("""{ "type": "string" }""")}] }""")}
                    }, "required": ["feed", "feeds", "tags"] } """,
            )
            val gen = generate(spec)
            gen.file("Types") shouldContain
                "public val tags: List<@Serializable(with = RealtimeChannelListStringSerializer::class) RealtimeChannel<List<String>>>,"
            gen.file("Serializers").windowed("object RealtimeChannelNoteSerializer".length)
                .count { it == "object RealtimeChannelNoteSerializer" } shouldBe 1
            gen.shouldDeclareEveryReferencedSerializer()
        }

        test("a union variant's list of channels annotates the element") {
            val spec = spec(
                mapOf("getEvent" to ref("Holder")),
                """ "Event": { "oneOf": [
                      { "type": "object", "properties": { "kind": { "type": "string", "enum": ["feeds"] }, "feeds": ${array(CHANNEL)} }, "required": ["kind", "feeds"] },
                      { "type": "object", "properties": { "kind": { "type": "string", "enum": ["none"] } }, "required": ["kind"] }
                    ] },
                    "Holder": { "type": "object", "properties": { "event": ${ref("Event")} }, "required": ["event"] } """,
            )
            val gen = generate(spec)
            gen.all shouldContain
                "public val feeds: List<@Serializable(with = RealtimeChannelNoteSerializer::class) RealtimeChannel<Note>>,"
            gen.shouldDeclareEveryReferencedSerializer()
        }

        test("an inline result object's map of channels annotates the value with the qualified payload") {
            val spec = spec(
                mapOf(
                    "getRooms" to """{ "type": "object", "properties": { "rooms": ${map("""{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [{ "type": "object", "properties": { "n": { "type": "integer" } }, "required": ["n"] }] }""")} }, "required": ["rooms"] }""",
                ),
            )
            val gen = generate(spec)
            gen.file("Api") shouldContain
                "public val rooms: Map<String, @Serializable(with = RealtimeChannelApiGetRoomsResultRoomsSerializer::class) RealtimeChannel<Result.Rooms>>,"
            gen.file("Serializers") shouldContain "KSerializer<RealtimeChannel<Api.GetRooms.Result.Rooms>>"
            gen.shouldDeclareEveryReferencedSerializer()
        }
    }

    context("an operation that returns transferables inside containers") {
        test("a list of channels decodes through the channel serializer") {
            val gen = generate(spec(mapOf("listFeeds" to array(CHANNEL))))
            val api = gen.file("Api")
            api shouldContain "public suspend fun listFeeds(): List<RealtimeChannel<Note>>"
            api shouldContain "return BlocksJson.decodeFromJsonElement(ListSerializer(RealtimeChannelNoteSerializer), result)"
            gen.shouldDeclareEveryReferencedSerializer()
            gen.file("Serializers") shouldContain "object RealtimeChannelNoteSerializer"
        }

        test("a map of lists of nullable file handles decodes through nested builtin serializers") {
            val api = generate(spec(mapOf("getFiles" to map(array(nullable(DOWNLOAD)))))).file("Api")
            api shouldContain "public suspend fun getFiles(): Map<String, List<FileDownloadHandle?>>"
            api shouldContain
                "return BlocksJson.decodeFromJsonElement(MapSerializer(String.serializer(), ListSerializer(FileDownloadHandleSerializer.nullable)), result)"
        }

        test("a model result keeps the plain decode") {
            val api = generate(holder(""" "feeds": ${array(CHANNEL)} """, "feeds")).file("Api")
            api shouldContain "return BlocksJson.decodeFromJsonElement(result)"
        }

        test("a direct channel result is unchanged") {
            val api = generate(spec(mapOf("getFeed" to CHANNEL))).file("Api")
            api shouldContain "return RealtimeChannel.fromJson(result) { BlocksJson.decodeFromJsonElement<Note>(it) }"
        }
    }

    context("an oidc/client inside a model") {
        val loginMenu = spec(
            mapOf("getLoginMenu" to ref("LoginMenu")),
            """ "SignInOption": { "type": "object", "properties": { "label": { "type": "string" }, "client": $OIDC }, "required": ["label", "client"] },
                "LoginMenu": { "type": "object", "properties": {
                  "primary": ${ref("SignInOption")},
                  "options": ${array(ref("SignInOption"))},
                  "byName": ${map(OIDC)},
                  "fallback": $OIDC
                }, "required": ["primary", "options", "byName"] } """,
        )

        test("is a contextual property or element, never a throwing serializer") {
            val gen = generate(loginMenu)
            val types = gen.file("Types")
            types shouldContain """
                |  @Contextual
                |  public val client: OidcClient,
            """.trimMargin()
            types shouldContain "public val byName: Map<String, @Contextual OidcClient>,"
            types shouldContain """
                |  @Contextual
                |  public val fallback: OidcClient? = null,
            """.trimMargin()
            gen.all shouldNotContain "Unknown transferable"
            gen.all shouldNotContain "OidcClientSerializer"
        }

        test("the operation decodes with the OIDC Json bound to the calling client") {
            val api = generate(loginMenu).file("Api")
            api shouldContain "public suspend fun getLoginMenu(): LoginMenu"
            api shouldContain "return OidcClient.json(client, \"app://cb\").decodeFromJsonElement(result)"
        }

        test("a list of OIDC clients returned directly decodes with the OIDC Json") {
            val api = generate(spec(mapOf("getClients" to array(OIDC)))).file("Api")
            api shouldContain "public suspend fun getClients(): List<OidcClient>"
            api shouldContain "return OidcClient.json(client, \"app://cb\").decodeFromJsonElement(result)"
        }

        test("without a relay target the operation is a stub and the model still compiles") {
            val model = CodegenModelBuilder().build(OpenRpcParser.parse(loginMenu))
            val result = KotlinCodeGenerator("com.example.app").generate(model)
            val files = result.files.associate { it.name to it.toString().unwrapped() }
            result.warnings.single() shouldContain "relayTo"
            files.getValue("Api") shouldContain "OIDC is not configured"
            files.getValue("Api") shouldNotContain "OidcClient.json("
            files.getValue("Types") shouldContain "public val byName: Map<String, @Contextual OidcClient>,"
        }

        test("a recommended relay target still emits the real decode") {
            val api = generate(loginMenu, relayTo = null, requirement = RelayToRequirement.Recommended).file("Api")
            api shouldContain "return OidcClient.json(client, \"\").decodeFromJsonElement(result)"
        }
    }
})
