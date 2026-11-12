package com.aws.blocks.kotlin.generator

import com.squareup.kotlinpoet.CodeBlock
import com.squareup.kotlinpoet.FunSpec
import com.squareup.kotlinpoet.KModifier
import com.squareup.kotlinpoet.ParameterizedTypeName.Companion.parameterizedBy
import com.squareup.kotlinpoet.PropertySpec
import com.squareup.kotlinpoet.TypeName
import com.squareup.kotlinpoet.TypeSpec

/**
 * Decodes one realtime-channel message, the JSON element `it`, into [payloadType] with [json].
 *
 * A payload that is, or holds through lists, maps and nullables only, a transferable needs
 * [payloadSerializer] (`ListSerializer(FileDownloadHandleSerializer)`): a reified decode can't
 * see a serializer on a type usage, so `decodeFromJsonElement<List<FileDownloadHandle>>` throws.
 * Any other payload decodes reified, as before; a model's own serializer handles its fields.
 */
internal fun channelPayloadDecode(payloadType: TypeName, json: CodeBlock, payloadSerializer: CodeBlock?): CodeBlock =
    if (payloadSerializer != null) {
        CodeBlock.of("%L.%M(%L, it)", json, MemberNames.decode, payloadSerializer)
    } else {
        CodeBlock.of("%L.%M<%T>(it)", json, MemberNames.decode, payloadType)
    }

class TransferableSerializerGenerator {
    /**
     * One generated serializer object. For a realtime channel, [payloadSerializer] is the
     * serializer its messages decode through when a reified decode can't (see
     * [channelPayloadDecode]), and [payloadNeedsDecoderJson] is set when the payload holds an
     * `oidc/client`: messages then decode with the [kotlinx.serialization.json.Json] that decodes
     * the channel itself (`OidcClient.json`, bound to the calling client), not plain `BlocksJson`.
     */
    data class TransferableEntry(
        val transferableName: String,
        val serializerName: String,
        val returnType: TypeName,
        val typeArgument: TypeName? = null,
        val payloadSerializer: CodeBlock? = null,
        val payloadNeedsDecoderJson: Boolean = false,
    )

    fun generateSerializerObject(entry: TransferableEntry): TypeSpec {
        val objectBuilder = TypeSpec.objectBuilder(entry.serializerName)
            .addSuperinterface(ClassNames.kSerializer.parameterizedBy(entry.returnType))

        objectBuilder.addProperty(
            PropertySpec.builder("descriptor", ClassNames.serialDescriptor)
                .addModifiers(KModifier.OVERRIDE)
                .initializer("%M(%S)", MemberNames.buildClassSerialDescriptor, entry.serializerName)
                .build()
        )

        objectBuilder.addFunction(generateDeserialize(entry))
        objectBuilder.addFunction(generateSerialize(entry))

        return objectBuilder.build()
    }

    private fun generateDeserialize(entry: TransferableEntry): FunSpec {
        val funBuilder = FunSpec.builder("deserialize")
            .addModifiers(KModifier.OVERRIDE)
            .addParameter("decoder", ClassNames.decoder)
            .returns(entry.returnType)
            .addStatement("val element = (decoder as %T).decodeJsonElement()", ClassNames.jsonDecoder)

        when (entry.transferableName) {
            "realtime/channel" -> {
                if (entry.typeArgument != null) {
                    val json = if (entry.payloadNeedsDecoderJson) {
                        // `decoder` is a JsonDecoder here (smart cast from the line above).
                        funBuilder.addComment("Messages decode with the Json decoding this channel, which binds their OIDC clients.")
                        funBuilder.addStatement("val json = decoder.json")
                        CodeBlock.of("json")
                    } else {
                        CodeBlock.of("%T", ClassNames.blocksJson)
                    }
                    funBuilder.addStatement(
                        "return %T.fromJson(element) { %L }",
                        ClassNames.realtimeChannel,
                        channelPayloadDecode(entry.typeArgument, json, entry.payloadSerializer),
                    )
                } else {
                    funBuilder.addStatement(
                        "return %T.fromJson(element) { it }",
                        ClassNames.realtimeChannel
                    )
                }
            }
            "file-bucket/download" -> {
                funBuilder.addStatement("return %T.fromJson(element)", ClassNames.fileDownloadHandle)
            }
            "file-bucket/upload" -> {
                funBuilder.addStatement("return %T.fromJson(element)", ClassNames.fileUploadHandle)
            }
            else -> {
                funBuilder.addStatement(
                    "throw %T(%S)",
                    UnsupportedOperationException::class,
                    "Unknown transferable: ${entry.transferableName}"
                )
            }
        }

        return funBuilder.build()
    }

    /**
     * Encodes a bound transferable as its `{ "__blocks": … }` descriptor (the runtime's `toJson()`),
     * so a model holding one can be sent as a parameter, as Swift's `encode(to:)` does. An unknown
     * tag's serializer can't decode one either, and still throws.
     */
    private fun generateSerialize(entry: TransferableEntry): FunSpec {
        val funBuilder = FunSpec.builder("serialize")
            .addModifiers(KModifier.OVERRIDE)
            .addParameter("encoder", ClassNames.encoder)
            .addParameter("value", entry.returnType)
        return when (entry.transferableName) {
            "realtime/channel", "file-bucket/download", "file-bucket/upload" ->
                funBuilder.addStatement("(encoder as %T).encodeJsonElement(value.toJson())", ClassNames.jsonEncoder)
            else -> funBuilder.addStatement(
                "throw %T(%S)",
                UnsupportedOperationException::class,
                "Transferables are read-only"
            )
        }.build()
    }
}
