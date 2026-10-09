package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.GeneratorResult
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.generator.RelayToRequirement
import com.aws.blocks.kotlin.model.ResolvedType
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.types.shouldBeInstanceOf

private const val NOTE = """{ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }"""
private const val DOWNLOAD = """{ "x-blocks-transferable": "file-bucket/download" }"""
private const val UPLOAD = """{ "x-blocks-transferable": "file-bucket/upload" }"""
private const val OIDC = """{ "x-blocks-transferable": "oidc/client" }"""

private fun ref(name: String): String = """{ "${'$'}ref": "#/components/schemas/$name" }"""
private fun channel(payload: String): String = """{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [$payload] }"""
private fun array(items: String): String = """{ "type": "array", "items": $items }"""
private fun map(values: String): String = """{ "type": "object", "additionalProperties": $values }"""

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
private fun holder(properties: String, vararg required: String, schemas: String = ""): String = spec(
    mapOf("getHolder" to ref("Holder")),
    """ "Holder": { "type": "object", "properties": { $properties }, "required": [ ${required.joinToString { "\"$it\"" }} ] } """ +
        if (schemas.isBlank()) "" else ", $schemas",
)

private fun run(
    spec: String,
    relayTo: String? = "app://cb",
    requirement: RelayToRequirement = RelayToRequirement.Required,
): GeneratorResult {
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app", relayTo = relayTo, relayToRequirement = requirement).generate(model)
}

/** Generated files by name, with KotlinPoet's line wrapping after a colon undone. */
private fun files(spec: String, relayTo: String? = "app://cb"): Map<String, String> =
    run(spec, relayTo).files.associate { it.name to it.toString().replace(Regex(":\\n +"), ": ") }

/** Every `@Serializable(with = X::class)` and every `XSerializer` a decode names is a generated object. */
private fun Map<String, String>.shouldDeclareEveryReferencedSerializer() {
    val all = values.joinToString("\n")
    Regex("\\b([A-Za-z0-9_]+Serializer)\\b").findAll(all).map { it.groupValues[1] }
        .filter { it !in setOf("KSerializer", "ListSerializer", "MapSerializer", "OidcClientSerializer") }
        .toSet()
        .forEach { name -> withClue("missing serializer $name") { all shouldContain "object $name :" } }
}

/**
 * A realtime channel decodes each message with a lambda over its payload type. That lambda
 * was always `BlocksJson.decodeFromJsonElement<Payload>(it)`, so a payload that is or holds a
 * transferable through lists and maps only (`RealtimeChannel<List<FileDownloadHandle>>`), which
 * a reified decode can't find a serializer for, threw on every message; and a payload holding an
 * `oidc/client` anywhere threw because plain `BlocksJson` can't bind it to a client (R55, "Not
 * covered"). Separately, an `oidc/client` reached only through a `$ref`'d schema's
 * `additionalProperties` wasn't seen, so the operation decoded with plain `BlocksJson` and wasn't
 * gated on a relay target.
 */
class ChannelPayloadTransferableTest : FunSpec({

    context("a channel returned directly whose payload holds transferables in containers") {
        test("a list of file handles decodes each message through ListSerializer") {
            val api = files(spec(mapOf("getDownloads" to channel(array(DOWNLOAD))))).getValue("Api")
            api shouldContain "public suspend fun getDownloads(): RealtimeChannel<List<FileDownloadHandle>>"
            api shouldContain
                "return RealtimeChannel.fromJson(result) { BlocksJson.decodeFromJsonElement(ListSerializer(FileDownloadHandleSerializer), it) }"
        }

        test("a payload that is a file handle decodes through its serializer") {
            val gen = files(spec(mapOf("getUploads" to channel(UPLOAD))))
            gen.getValue("Api") shouldContain
                "return RealtimeChannel.fromJson(result) { BlocksJson.decodeFromJsonElement(FileUploadHandleSerializer, it) }"
            gen.shouldDeclareEveryReferencedSerializer()
        }

        test("a list of channels decodes through the inner channel's serializer") {
            val gen = files(spec(mapOf("getRooms" to channel(array(channel(ref("Note")))))))
            gen.getValue("Api") shouldContain "public suspend fun getRooms(): RealtimeChannel<List<RealtimeChannel<Note>>>"
            gen.getValue("Api") shouldContain
                "return RealtimeChannel.fromJson(result) { BlocksJson.decodeFromJsonElement(ListSerializer(RealtimeChannelNoteSerializer), it) }"
            gen.getValue("Serializers") shouldContain "public object RealtimeChannelNoteSerializer : KSerializer<RealtimeChannel<Note>>"
            gen.shouldDeclareEveryReferencedSerializer()
        }

        test("a map of nullable upload handles decodes through nested builtin serializers") {
            val api = files(spec(mapOf("getSlots" to channel(map("""{ "oneOf": [ $UPLOAD, { "type": "null" } ] }"""))))).getValue("Api")
            api shouldContain
                "{ BlocksJson.decodeFromJsonElement(MapSerializer(String.serializer(), FileUploadHandleSerializer.nullable), it) }"
        }

        test("a model payload with a file handle field keeps the reified decode, and the field its serializer") {
            val spec = spec(
                mapOf("getAttachments" to channel(ref("Attachment"))),
                """ "Attachment": { "type": "object", "properties": { "file": $DOWNLOAD, "files": ${array(DOWNLOAD)} }, "required": ["file", "files"] } """,
            )
            val gen = files(spec)
            gen.getValue("Api") shouldContain
                "return RealtimeChannel.fromJson(result) { BlocksJson.decodeFromJsonElement<Attachment>(it) }"
            gen.getValue("Types") shouldContain "public val files: List<@Serializable(with = FileDownloadHandleSerializer::class) FileDownloadHandle>,"
            gen.shouldDeclareEveryReferencedSerializer()
        }

        test("a payload without transferables is unchanged") {
            files(spec(mapOf("getFeed" to channel(ref("Note"))))).getValue("Api") shouldContain
                "return RealtimeChannel.fromJson(result) { BlocksJson.decodeFromJsonElement<Note>(it) }"
            files(spec(mapOf("getTags" to channel(array("""{ "type": "string" }"""))))).getValue("Api") shouldContain
                "return RealtimeChannel.fromJson(result) { BlocksJson.decodeFromJsonElement<List<String>>(it) }"
        }
    }

    context("a channel inside a model whose payload holds transferables in containers") {
        test("the channel's serializer decodes each message through the payload serializer") {
            val gen = files(holder(""" "downloads": ${channel(array(DOWNLOAD))} """, "downloads"))
            gen.getValue("Types") shouldContain """
                |  @Serializable(with = RealtimeChannelListFileDownloadHandleSerializer::class)
                |  public val downloads: RealtimeChannel<List<FileDownloadHandle>>,
            """.trimMargin()
            gen.getValue("Serializers") shouldContain
                "return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement(ListSerializer(FileDownloadHandleSerializer), it) }"
            gen.shouldDeclareEveryReferencedSerializer()
        }

        test("a list of channels of maps of channels nests the serializers") {
            val gen = files(holder(""" "lobbies": ${array(channel(map(channel(ref("Note")))))} """, "lobbies"))
            // The payload's channels are annotated too: the serialization plugin rejects the type
            // usage otherwise (`Serializer has not been found for type 'RealtimeChannel<Note>'`).
            gen.getValue("Types") shouldContain
                "public val lobbies: List<@Serializable(with = RealtimeChannelMapStringRealtimeChannelNoteSerializer::class) " +
                "RealtimeChannel<Map<String, @Serializable(with = RealtimeChannelNoteSerializer::class) RealtimeChannel<Note>>>>,"
            gen.getValue("Serializers") shouldContain
                "{ BlocksJson.decodeFromJsonElement(MapSerializer(String.serializer(), RealtimeChannelNoteSerializer), it) }"
            gen.shouldDeclareEveryReferencedSerializer()
        }

        test("a map of channels of upload handles annotates the payload handle on the type usage") {
            val gen = files(holder(""" "uploadsByRoom": ${map(channel(UPLOAD))} """, "uploadsByRoom"))
            gen.getValue("Types") shouldContain
                "public val uploadsByRoom: Map<String, @Serializable(with = RealtimeChannelFileUploadHandleSerializer::class) " +
                "RealtimeChannel<@Serializable(with = FileUploadHandleSerializer::class) FileUploadHandle>>,"
            gen.getValue("Serializers") shouldContain "public object RealtimeChannelFileUploadHandleSerializer : KSerializer<RealtimeChannel<FileUploadHandle>>"
            gen.getValue("Serializers") shouldContain
                "{ BlocksJson.decodeFromJsonElement(FileUploadHandleSerializer, it) }"
            gen.shouldDeclareEveryReferencedSerializer()
        }

        test("a list of channels of OIDC payloads marks the payload's OIDC client contextual on the type usage") {
            files(holder(""" "logins": ${array(channel(array(OIDC)))} """, "logins")).getValue("Types") shouldContain
                "public val logins: List<@Serializable(with = RealtimeChannelListOidcClientSerializer::class) RealtimeChannel<List<@Contextual OidcClient>>>,"
        }

        test("a model payload keeps the reified decode in the serializer") {
            files(holder(""" "feed": ${channel(ref("Note"))} """, "feed")).getValue("Serializers") shouldContain
                "return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement<Note>(it) }"
        }
    }

    context("a channel whose payload holds an oidc/client") {
        val loginSchemas = """ "LoginOption": { "type": "object", "properties": { "label": { "type": "string" }, "client": $OIDC }, "required": ["label", "client"] } """

        test("returned directly, messages decode with the OIDC Json bound to the calling client") {
            val api = files(spec(mapOf("getLogins" to channel(ref("LoginOption"))), loginSchemas)).getValue("Api")
            api shouldContain "public suspend fun getLogins(): RealtimeChannel<LoginOption>"
            api shouldContain "val json = OidcClient.json(client, \"app://cb\")"
            api shouldContain "return RealtimeChannel.fromJson(result) { json.decodeFromJsonElement<LoginOption>(it) }"
            api shouldNotContain "BlocksJson.decodeFromJsonElement<LoginOption>"
        }

        test("a list of OIDC clients as the payload decodes with the OIDC Json too") {
            val api = files(spec(mapOf("getClients" to channel(array(OIDC))))).getValue("Api")
            api shouldContain "return RealtimeChannel.fromJson(result) { json.decodeFromJsonElement<List<OidcClient>>(it) }"
        }

        test("inside a model, the channel's serializer reuses the Json decoding it, and the operation binds the client") {
            val gen = files(holder(""" "logins": ${channel(ref("LoginOption"))} """, "logins", schemas = loginSchemas))
            val serializers = gen.getValue("Serializers")
            serializers shouldContain "val json = decoder.json"
            serializers shouldContain "return RealtimeChannel.fromJson(element) { json.decodeFromJsonElement<LoginOption>(it) }"
            gen.getValue("Api") shouldContain "return OidcClient.json(client, \"app://cb\").decodeFromJsonElement(result)"
        }

        test("a channel of channels of OIDC payloads threads the Json through both serializers") {
            val gen = files(holder(""" "rooms": ${channel(array(channel(ref("LoginOption"))))} """, "rooms", schemas = loginSchemas))
            val serializers = gen.getValue("Serializers")
            serializers shouldContain "{ json.decodeFromJsonElement(ListSerializer(RealtimeChannelLoginOptionSerializer), it) }"
            serializers shouldContain "{ json.decodeFromJsonElement<LoginOption>(it) }"
            serializers shouldNotContain "BlocksJson"
            gen.shouldDeclareEveryReferencedSerializer()
        }

        test("without a relay target the operation is a stub, the build warns, and the models still compile") {
            val spec = spec(
                mapOf("getLogins" to channel(ref("LoginOption")), "getHolder" to ref("Holder")),
                "$loginSchemas, \"Holder\": { \"type\": \"object\", \"properties\": { \"logins\": ${channel(ref("LoginOption"))} }, \"required\": [\"logins\"] }",
            )
            val result = run(spec, relayTo = null)
            result.warnings.single() shouldContain "relayTo"
            val api = result.files.single { it.name == "Api" }.toString()
            withClue(api) {
                api shouldContain "public suspend fun getLogins(): Nothing"
                api shouldContain "public suspend fun getHolder(): Nothing"
                api shouldNotContain "OidcClient.json("
            }
            result.files.single { it.name == "Types" }.toString() shouldContain "public val logins: RealtimeChannel<LoginOption>"
        }
    }

    context("an oidc/client reached only through a schema's additionalProperties") {
        val directory = """ "Directory": { "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"], "additionalProperties": $OIDC } """

        test("a \$ref'd record's resolved type carries its additionalProperties type") {
            val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec(mapOf("getDirectory" to ref("Directory")), directory)))
            val record = model.apiNamespaces.single().operations.single().result.type
            record.shouldBeInstanceOf<ResolvedType.Record>()
            record.additionalPropertiesType shouldBe ResolvedType.Transferable("oidc/client", emptyList())
        }

        test("returned directly, the operation decodes with the OIDC Json") {
            val api = files(spec(mapOf("getDirectory" to ref("Directory")), directory)).getValue("Api")
            api shouldContain "return OidcClient.json(client, \"app://cb\").decodeFromJsonElement(result)"
        }

        test("a field, list or map holding the record decodes with the OIDC Json") {
            for (property in listOf(ref("Directory"), array(ref("Directory")), map(ref("Directory")))) {
                val api = files(holder(""" "directory": $property """, "directory", schemas = directory)).getValue("Api")
                withClue(property) { api shouldContain "return OidcClient.json(client, \"app://cb\").decodeFromJsonElement(result)" }
            }
        }

        test("a union variant \$ref'd record with OIDC additionalProperties decodes with the OIDC Json") {
            val spec = spec(
                mapOf("getEntry" to ref("Entry")),
                """ "Listed": { "type": "object", "properties": { "kind": { "type": "string", "enum": ["listed"] } }, "required": ["kind"], "additionalProperties": $OIDC },
                    "Hidden": { "type": "object", "properties": { "kind": { "type": "string", "enum": ["hidden"] } }, "required": ["kind"] },
                    "Entry": { "type": "object", "properties": { "entry": { "oneOf": [ ${ref("Listed")}, ${ref("Hidden")} ] } }, "required": ["entry"] } """,
            )
            files(spec).getValue("Api") shouldContain "return OidcClient.json(client, \"app://cb\").decodeFromJsonElement(result)"
        }

        test("without a relay target the operation is a stub and the build warns") {
            val result = run(spec(mapOf("getDirectory" to ref("Directory")), directory), relayTo = null)
            result.warnings shouldHaveSize 1
            result.warnings.single() shouldContain "relayTo"
            result.files.single { it.name == "Api" }.toString() shouldContain "OIDC is not configured"
        }

        test("additionalProperties without an OIDC client keep the plain decode") {
            val plain = """ "Scores": { "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"], "additionalProperties": { "type": "number" } } """
            files(spec(mapOf("getScores" to ref("Scores")), plain)).getValue("Api") shouldContain
                "return BlocksJson.decodeFromJsonElement(result)"
        }
    }
})
